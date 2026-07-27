package com.meeks233.orca

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Shared Orca Secure Channel (OSC) client for native code: credential lookup, the
 * forward-secret handshake, and the JSON request/response sealing the server
 * speaks. Mirrors `frontend/src/e2ee.ts` and `src/e2ee.rs`.
 *
 * The "Quick Download" share target (ShareActivity → DownloadService) and the
 * media proxy ([RemoteMediaProxy]) both talk to the same backend the WebView
 * does, so the session and the crypto primitives live here once.
 *
 * History, because it is the bug this file was rewritten to fix: the first
 * version authenticated with a *static* key id derived from `SHA256(token)`
 * (`X-Orca-Key-Id`). The server has since moved to per-connection sessions —
 * an ephemeral P-256 ECDH handshake with the token mixed in as a pre-shared key,
 * named on the wire by an opaque `X-Orca-Sid` — and no longer looks at a key id
 * at all. Native requests therefore fell through to the plaintext bearer path,
 * which is loopback-only, and every quick download died on a 401 the user never
 * saw. Both callers now run the real handshake.
 */
object OrcaApi {
  data class Creds(val base: String, val token: String)

  /** An established secure channel: an opaque sid plus the 32-byte session key. */
  class Session(val base: String, val token: String, val sid: String, val key: ByteArray)

  private val SESSION_INFO = "orca-osc-v2-session".toByteArray(Charsets.UTF_8) + byteArrayOf(0)

  /**
   * Server base + token, mirrored out of the WebView's localStorage into
   * `<dataDir>/orca_share_creds.json` by the `save_share_creds` Tauri command.
   * Native code cannot read localStorage, so this file is the only channel.
   */
  fun readCreds(ctx: Context): Creds? = try {
    val f = File(ctx.dataDir, "orca_share_creds.json")
    if (!f.exists()) {
      null
    } else {
      val o = JSONObject(f.readText())
      val base = o.optString("base").trimEnd('/')
      val token = o.optString("token")
      if (base.isEmpty() || token.isEmpty()) null else Creds(base, token)
    }
  } catch (e: Exception) {
    null
  }

  // ---- Session cache --------------------------------------------------------
  // One session for the whole process, reused across share submits, status polls
  // and media windows. Rebuilt when the creds change or the server expires it.

  @Volatile private var cached: Session? = null
  private val handshakeLock = Any()

  /** The current session for [creds], handshaking once if there is none. */
  fun session(creds: Creds): Session {
    cached?.let { if (it.base == creds.base && it.token == creds.token) return it }
    synchronized(handshakeLock) {
      cached?.let { if (it.base == creds.base && it.token == creds.token) return it }
      val s = handshake(creds.base, creds.token)
      cached = s
      return s
    }
  }

  /**
   * Discard [stale] so the next [session] call re-handshakes. Only clears it if
   * it is still the live one, so a session another thread just established in
   * response to the same 401 is not thrown away as well.
   */
  fun dropSession(stale: Session) {
    synchronized(handshakeLock) {
      if (cached === stale) cached = null
    }
  }

  /** The forward-secret P-256 handshake — mirrors `handshake` in frontend/src/e2ee.ts. */
  private fun handshake(base: String, token: String): Session {
    val ap = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
    val ecSpec = ap.getParameterSpec(ECParameterSpec::class.java)
    val kpg = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
    val kp = kpg.generateKeyPair()
    val pub = kp.public as ECPublicKey
    val epkC = byteArrayOf(0x04) + fixed(pub.w.affineX, 32) + fixed(pub.w.affineY, 32)
    val nC = ByteArray(16).also { SecureRandom().nextBytes(it) }

    val body = JSONObject()
      .put("epk", Base64.encodeToString(epkC, Base64.NO_WRAP))
      .put("n", Base64.encodeToString(nC, Base64.NO_WRAP))
      .toString()
    val conn = (URL("$base/api/session").openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 15000
      readTimeout = 20000
      doOutput = true
      setRequestProperty("Content-Type", "application/json")
    }
    val resp = try {
      conn.outputStream.use { it.write(body.toByteArray()) }
      if (conn.responseCode !in 200..299) throw Exception("handshake ${conn.responseCode}")
      conn.inputStream.use { it.bufferedReader().readText() }
    } finally {
      conn.disconnect()
    }
    val j = JSONObject(resp)
    val epkS = Base64.decode(j.getString("epk"), Base64.DEFAULT) // 0x04||X||Y
    val nS = Base64.decode(j.getString("n"), Base64.DEFAULT)
    val sid = j.getString("sid")

    val serverPub = KeyFactory.getInstance("EC").generatePublic(
      ECPublicKeySpec(
        ECPoint(BigInteger(1, epkS.copyOfRange(1, 33)), BigInteger(1, epkS.copyOfRange(33, 65))),
        ecSpec,
      )
    )
    val ka = KeyAgreement.getInstance("ECDH").apply { init(kp.private); doPhase(serverPub, true) }
    val sharedX = ka.generateSecret() // P-256 shared secret = the 32-byte X coordinate

    val key = hkdf(sharedX, nC + nS, SESSION_INFO + sha256(token.toByteArray(Charsets.UTF_8)), 32)
    return Session(base, token, sid, key)
  }

  // ---- Authenticated JSON requests -----------------------------------------

  private fun configure(
    conn: HttpURLConnection,
    s: Session,
    method: String,
    path: String,
    hasBody: Boolean,
  ) {
    conn.setRequestProperty("X-Orca-E2EE", "1")
    conn.setRequestProperty("X-Orca-Sid", s.sid)
    conn.setRequestProperty("X-Orca-Auth", authenticator(s.key, method, path))
    if (hasBody) {
      conn.setRequestProperty("X-Orca-Encrypted-Body", "1")
      conn.setRequestProperty("Content-Type", "text/plain")
    }
  }

  private fun readResponse(conn: HttpURLConnection, s: Session, path: String): Pair<Int, String> {
    val code = conn.responseCode
    val stream = if (code in 200..299) conn.inputStream else conn.errorStream
    val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
    val plaintext = if (conn.getHeaderField("X-Orca-E2EE") == "1") {
      open(s.key, body, "$code\n$path")
    } else {
      body
    }
    return Pair(code, plaintext)
  }

  /**
   * Run [call] on the current session, re-handshaking once on a 401. A backend
   * restart drops its in-memory session store, and that looks exactly like an
   * expiry — a fresh handshake fixes it where a blind retry would not. A genuinely
   * wrong token answers 401 again, and that second answer is returned as-is so the
   * caller can say "auth failed" rather than "unreachable".
   */
  private fun withSession(creds: Creds, call: (Session) -> Pair<Int, String>): Pair<Int, String> {
    val s = session(creds)
    val first = call(s)
    if (first.first != 401) return first
    dropSession(s)
    return call(session(creds))
  }

  /** GET `<base><path>`, returning (HTTP status, decrypted body). */
  fun get(creds: Creds, path: String): Pair<Int, String> = withSession(creds) { s ->
    val conn = (URL("${s.base}$path").openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 15000
      readTimeout = 20000
      configure(this, s, "GET", path, false)
    }
    try {
      readResponse(conn, s, path)
    } finally {
      conn.disconnect()
    }
  }

  /** POST `payload` (sealed) to `<base><path>`, returning (HTTP status, decrypted body). */
  fun post(creds: Creds, path: String, payload: String): Pair<Int, String> = withSession(creds) { s ->
    val conn = (URL("${s.base}$path").openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 15000
      readTimeout = 30000
      doOutput = true
      configure(this, s, "POST", path, true)
    }
    try {
      conn.outputStream.use {
        it.write(seal(s.key, payload.toByteArray(), "POST\n$path").toByteArray())
      }
      readResponse(conn, s, path)
    } finally {
      conn.disconnect()
    }
  }

  // ---- Crypto primitives (mirror src/e2ee.rs / frontend e2ee.ts) -------------

  private fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(32) else key, "HmacSHA256"))
    return mac.doFinal(data)
  }

  /** HKDF-SHA256. An empty salt means HashLen zero bytes (RFC 5869). */
  fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, len: Int): ByteArray {
    val prk = hmac(salt, ikm)
    val out = java.io.ByteArrayOutputStream()
    var t = ByteArray(0)
    var i = 1
    while (out.size() < len) {
      t = hmac(prk, t + info + byteArrayOf(i.toByte()))
      out.write(t)
      i += 1
    }
    return out.toByteArray().copyOf(len)
  }

  /** AES-256-GCM seal into the JSON envelope the server opens; the token stays off-wire. */
  private fun seal(key: ByteArray, plaintext: ByteArray, aad: String): String {
    val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    return JSONObject()
      .put("v", 1)
      .put("n", Base64.encodeToString(nonce, Base64.NO_WRAP))
      .put("c", Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP))
      .toString()
  }

  private fun open(key: ByteArray, envelope: String, aad: String): String {
    val parsed = JSONObject(envelope)
    require(parsed.optInt("v") == 1) { "invalid encrypted response" }
    val nonce = Base64.decode(parsed.getString("n"), Base64.DEFAULT)
    val ciphertext = Base64.decode(parsed.getString("c"), Base64.DEFAULT)
    require(nonce.size == 12 && ciphertext.size >= 16) { "invalid encrypted response" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
  }

  /**
   * Prove possession of the session key for exactly this request. The sid names a
   * session but proves nothing; this seal — bound to method+target, stamped, and
   * single-use — is the credential. Mirrors `verify_authenticator` in src/e2ee.rs.
   */
  fun authenticator(key: ByteArray, method: String, path: String): String {
    val nonce = ByteArray(16).also { SecureRandom().nextBytes(it) }
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    val payload = JSONObject().put("t", System.currentTimeMillis() / 1000).put("n", nonce).toString()
    val envelope = seal(key, payload.toByteArray(Charsets.UTF_8), "orca-auth-v1\n$method\n$path")
    return Base64.encodeToString(envelope.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
  }

  /** Left-pad an EC affine coordinate to exactly [size] bytes. */
  private fun fixed(v: BigInteger, size: Int): ByteArray {
    val b = v.toByteArray()
    if (b.size == size) return b
    if (b.size == size + 1 && b[0].toInt() == 0) return b.copyOfRange(1, b.size) // strip sign byte
    val out = ByteArray(size)
    if (b.size < size) System.arraycopy(b, 0, out, size - b.size, b.size)
    else System.arraycopy(b, b.size - size, out, 0, size)
    return out
  }
}

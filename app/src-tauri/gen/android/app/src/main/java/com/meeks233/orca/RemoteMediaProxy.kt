package com.meeks233.orca

import android.content.Context
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * A loopback HTTP server that **streams remote media through the Orca Secure
 * Channel** so the app's `<video>` can play a cloud item (or a server-side file)
 * with no service worker and no whole-file buffering.
 *
 * Why this exists: the Android WebView has no controlling service worker, so
 * `<img>`/`<video>` can't use the `/__m/` E2EE plane, and the server honours the
 * plaintext `?token=` fallback for loopback peers only — a real phone is refused.
 * The frontend can fetch+decrypt small media (thumbnails) itself, but a whole-file
 * blob makes `<video>` wait for the entire download before the first frame. This
 * proxy closes that gap the same way [LocalMediaServer] does for on-device files:
 * a real loopback HTTP origin the media stack will range-request, backed here by
 * the encrypted windowed media protocol (see src/api/emedia.rs + frontend/sw.ts).
 *
 * Security posture — the E2EE model is unchanged, not weakened:
 *  - It rides the same forward-secret P-256 session the rest of the native code
 *    uses (see [OrcaApi]), mixing SHA256(token) in as the PSK, and authenticates
 *    every window with a fresh sealed authenticator. The raw token never rides a
 *    request; a Cloudflare edge sees only ciphertext and an opaque session id.
 *  - The loopback socket is bound to 127.0.0.1 on an OS-chosen ephemeral port, and
 *    every URL carries a fresh 128-bit token, so nothing off-device can reach it
 *    and the decrypted bytes never leave this process except to its own WebView.
 */
object RemoteMediaProxy {
  private const val MEDIA_CHUNK = 65536
  private const val MEDIA_TAG = 16
  private val MEDIA_INFO = "orca-osc-v2-media".toByteArray(Charsets.UTF_8) + byteArrayOf(0)

  private var server: ServerSocket? = null
  private var port: Int = 0
  private val urlToken: String by lazy {
    ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  /**
   * A loopback URL the WebView's `<video>` can play for a remote [kind] resource.
   * `kind` is `"stream"` (cloud proxy) or `"file"` (a file the server holds);
   * `null` when there are no synced creds to reach the server with.
   */
  fun urlFor(ctx: Context, kind: String, slug: String, height: Int = 0): String? {
    if (slug.isEmpty() || (kind != "stream" && kind != "file")) return null
    if (OrcaApi.readCreds(ctx) == null) return null
    val p = ensureStarted(ctx)
    // The resolution cap only applies to a cloud 'stream' resolve; it rides the
    // loopback URL query and is forwarded to the server's /api/stream request.
    val h = if (kind == "stream" && height > 0) "?h=$height" else ""
    return "http://127.0.0.1:$p/$urlToken/$kind/${enc(slug)}$h"
  }

  private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

  @Synchronized
  private fun ensureStarted(ctx: Context): Int {
    server?.let { if (!it.isClosed) return port }
    val s = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    server = s
    port = s.localPort
    val app = ctx.applicationContext
    Thread({ acceptLoop(app, s) }, "orca-remote-media").apply { isDaemon = true; start() }
    return port
  }

  private fun acceptLoop(ctx: Context, s: ServerSocket) {
    while (!s.isClosed) {
      val client = try { s.accept() } catch (_: Exception) { return }
      Thread { handle(ctx, client) }.apply { isDaemon = true }.start()
    }
  }

  // ---- Loopback HTTP (mirrors LocalMediaServer's framing) -------------------

  private fun handle(ctx: Context, client: Socket) {
    try {
      client.use { sock ->
        sock.soTimeout = 20000
        val input = sock.getInputStream().bufferedReader()
        val requestLine = input.readLine() ?: return
        var range: String? = null
        while (true) {
          val line = input.readLine() ?: break
          if (line.isEmpty()) break
          if (line.startsWith("Range:", ignoreCase = true)) range = line.substringAfter(':').trim()
        }
        val parts = requestLine.split(' ')
        if (parts.size < 2) return respondStatus(sock.getOutputStream(), 400, "Bad Request")
        val method = parts[0]
        val target = resolve(parts[1]) ?: return respondStatus(sock.getOutputStream(), 404, "Not Found")
        serve(ctx, sock.getOutputStream(), target, range, includeBody = method != "HEAD")
      }
    } catch (_: Exception) {
      // A media element abandons connections constantly while seeking; a broken
      // pipe is normal and must not take the server down.
    }
  }

  private class Target(val kind: String, val slug: String, val height: Int) {
    val apiPath: String = if (kind == "stream") "/api/stream/${enc(slug)}" else "/api/items/${enc(slug)}/file"
    val resource: String = "$kind:$slug"
    // Rides the server fetch URL only (never the authenticator, which the server
    // binds to the path). A cap applies to the online-stream resolve alone.
    val fetchSuffix: String = if (kind == "stream" && height > 0) "?h=$height" else ""
  }

  /** `/<token>/<kind>/<slug>[?h=N]` → the resource, or null on a bad token/shape. */
  private fun resolve(rawPath: String): Target? {
    val pathOnly = rawPath.trimStart('/').substringBefore('?')
    val segs = pathOnly.split('/')
    if (segs.size < 3 || segs[0] != urlToken) return null
    val kind = segs[1]
    if (kind != "stream" && kind != "file") return null
    val slug = try { URLDecoder.decode(segs[2], "UTF-8") } catch (_: Exception) { return null }
    if (slug.isEmpty()) return null
    val query = rawPath.substringAfter('?', "")
    val height = query.split('&').firstOrNull { it.startsWith("h=") }
      ?.removePrefix("h=")?.toIntOrNull() ?: 0
    return Target(kind, slug, height)
  }

  /**
   * Serve an HTTP range by streaming decrypted E2EE windows from `start` onward,
   * flushing each as it arrives — so playback starts on the first window instead
   * of waiting for the whole file. A seek closes this and issues a new range.
   */
  private fun serve(ctx: Context, out: OutputStream, t: Target, range: String?, includeBody: Boolean) {
    // Learn the total plaintext length (and the first window) up front.
    val start = parseRangeStart(range)
    val first = try {
      window(ctx, t, start)
    } catch (e: Exception) {
      return respondStatus(out, if (e is SessionExpired) 502 else 502, "Bad Gateway")
    }
    val total = first.plainLen
    if (total == 0L) {
      out.write("HTTP/1.1 200 OK\r\nContent-Type: ${contentType(t)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
      out.flush(); return
    }
    if (start >= total) {
      out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$total\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").toByteArray())
      out.flush(); return
    }
    val partial = range != null
    val last = total - 1
    val length = last - start + 1
    val sb = StringBuilder()
    sb.append(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
    sb.append("Content-Type: ${contentType(t)}\r\n")
    sb.append("Content-Length: $length\r\n")
    sb.append("Accept-Ranges: bytes\r\n")
    if (partial) sb.append("Content-Range: bytes $start-$last/$total\r\n")
    sb.append("Access-Control-Allow-Origin: *\r\n")
    sb.append("Cache-Control: no-store\r\n")
    sb.append("Connection: close\r\n\r\n")
    out.write(sb.toString().toByteArray())
    if (!includeBody) { out.flush(); return }

    // First window: drop the bytes before `start` (the window is chunk-aligned).
    var win = first
    var pos = win.windowStart
    while (true) {
      val from = if (start > pos) (start - pos).toInt() else 0
      if (from < win.plaintext.size) out.write(win.plaintext, from, win.plaintext.size - from)
      out.flush()
      pos += win.plaintext.size
      if (pos >= total) break
      win = try { window(ctx, t, pos) } catch (_: Exception) { break }
      if (win.plaintext.isEmpty()) break
    }
    out.flush()
  }

  private fun contentType(t: Target): String = "video/mp4" // the media stack sniffs; a sane default is enough

  private fun parseRangeStart(range: String?): Long {
    if (range == null || !range.startsWith("bytes=")) return 0
    val spec = range.removePrefix("bytes=").trim()
    return spec.substringBefore('-').toLongOrNull() ?: 0
  }

  private fun respondStatus(out: OutputStream, code: Int, text: String) {
    out.write("HTTP/1.1 $code $text\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
    out.flush()
  }

  // ---- Encrypted media plane (over the shared OrcaApi session) --------------

  private class SessionExpired : Exception()
  private class Window(val plainLen: Long, val windowStart: Long, val plaintext: ByteArray)

  /** Fetch + decrypt one encrypted window starting at plaintext byte [start]. */
  private fun window(ctx: Context, t: Target, start: Long): Window {
    val creds = OrcaApi.readCreds(ctx) ?: throw Exception("no creds")
    val s = OrcaApi.session(creds)
    return try {
      fetchWindow(s, t, start)
    } catch (_: SessionExpired) {
      // Server-side expiry: drop the cached session and re-handshake once.
      OrcaApi.dropSession(s)
      fetchWindow(OrcaApi.session(creds), t, start)
    }
  }

  private fun fetchWindow(s: OrcaApi.Session, t: Target, start: Long): Window {
    val conn = (URL("${s.base}${t.apiPath}${t.fetchSuffix}").openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 15000
      readTimeout = 30000
      setRequestProperty("X-Orca-Sid", s.sid)
      setRequestProperty("X-Orca-Auth", OrcaApi.authenticator(s.key, "GET", t.apiPath))
      setRequestProperty("X-Orca-Range", "$start-")
    }
    try {
      val code = conn.responseCode
      if (code == 401) throw SessionExpired()
      if (code !in 200..299 || conn.getHeaderField("X-Orca-E2EE") != "1") {
        throw Exception("media fetch $code")
      }
      val plainLen = conn.getHeaderField("X-Orca-Plain-Len")?.toLongOrNull() ?: 0L
      val i0 = conn.getHeaderField("X-Orca-Chunk-Index")?.toLongOrNull() ?: 0L
      val body = conn.inputStream.use { it.readBytes() }
      val streamKey = OrcaApi.hkdf(s.key, ByteArray(0), MEDIA_INFO + t.resource.toByteArray(Charsets.UTF_8), 32)
      val out = java.io.ByteArrayOutputStream(body.size)
      var off = 0
      var idx = i0
      while (off < body.size) {
        val ptLen = minOf(MEDIA_CHUNK.toLong(), plainLen - idx * MEDIA_CHUNK).toInt()
        val ctLen = ptLen + MEDIA_TAG
        out.write(openChunk(streamKey, idx, body, off, ctLen))
        off += ctLen
        idx += 1
      }
      return Window(plainLen, i0 * MEDIA_CHUNK, out.toByteArray())
    } finally {
      conn.disconnect()
    }
  }

  /** Decrypt one sealed media chunk: nonce = 4 zero bytes ‖ big-endian u64 index. */
  private fun openChunk(streamKey: ByteArray, index: Long, body: ByteArray, off: Int, len: Int): ByteArray {
    val nonce = ByteArray(12)
    var v = index
    for (b in 11 downTo 4) { nonce[b] = (v and 0xff).toByte(); v = v ushr 8 }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(streamKey, "AES"), GCMParameterSpec(128, nonce))
    return cipher.doFinal(body, off, len)
  }
}

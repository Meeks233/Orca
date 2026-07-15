package com.whale.app

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * "Quick Download" share target (mirrors Seal's QuickDownloadActivity).
 *
 * Tapping Whale's "Quick Download" in another app's share sheet must NOT open
 * the full Whale UI: it forwards the shared link to the configured Whale backend
 * IN THE BACKGROUND and reports the result as a notification, then gets out of
 * the way. Whale downloads on a remote server, so "quick download" is just a
 * `POST /api/items` to that server — no local engine, no visible activity.
 *
 * Server base + token live in the WebView's localStorage, which native code
 * can't read. MainActivity's WebView mirrors them to
 * `<dataDir>/whale_share_creds.json` (via the `save_share_creds` Tauri command)
 * on launch and whenever they change; we read that here. If creds are missing
 * (app never opened/configured), we fall back to forwarding the intent into
 * MainActivity so first-run setup still works.
 *
 * Feedback is never silent: on success we post a notification; on ANY failure
 * (probe error, auth, unreachable) the notification is tappable and re-opens the
 * app with the shared URL prefilled, so the user sees the real, actionable error
 * toast (e.g. "add your X / Twitter cookies") instead of a share that vanished.
 */
class ShareActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val url = extractUrl(extractSharedText(intent))
    if (url == null) {
      finish()
      return
    }

    val creds = readCreds()
    if (creds == null) {
      // Not configured yet: open the full app so the user can set token/server,
      // handing the link over the way the WebView drain path expects.
      startActivity(openAppWithUrl(this, url))
      finish()
      return
    }

    // Fire the download in the background, notify the result, and exit
    // immediately with no visible UI — this is the "Quick Download" behaviour.
    val appCtx = applicationContext
    val (base, token) = creds
    Thread { submitAndNotify(appCtx, base, token, url) }.start()
    finish()
  }

  private fun readCreds(): Pair<String, String>? {
    return try {
      val f = File(dataDir, "whale_share_creds.json")
      if (!f.exists()) return null
      val o = JSONObject(f.readText())
      val base = o.optString("base").trimEnd('/')
      val token = o.optString("token")
      if (base.isEmpty() || token.isEmpty()) null else Pair(base, token)
    } catch (e: Exception) {
      null
    }
  }

  /** Pull the URL out of either a SEND (EXTRA_TEXT) or a VIEW (data URI) intent. */
  private fun extractSharedText(incoming: Intent?): String? {
    if (incoming == null) return null
    return when (incoming.action) {
      Intent.ACTION_SEND -> incoming.getStringExtra(Intent.EXTRA_TEXT)
      Intent.ACTION_VIEW -> incoming.dataString
      else -> null
    }
  }

  /** First http(s) URL out of arbitrary shared text ("Watch this https://…"). */
  private fun extractUrl(text: String?): String? {
    if (text == null) return null
    val m = Regex("https?://\\S+").find(text)
    return m?.value ?: text.trim().ifEmpty { null }
  }

  companion object {
    private const val CHANNEL_ID = "quick_download"

    /** An intent that opens MainActivity (the WebView) with `url` prefilled so
     *  the frontend's drain path re-submits it and shows the real error toast. */
    private fun openAppWithUrl(ctx: Context, url: String): Intent =
      Intent(ctx, MainActivity::class.java).apply {
        action = Intent.ACTION_SEND
        type = "text/plain"
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        putExtra(Intent.EXTRA_TEXT, url)
      }

    private fun submitAndNotify(ctx: Context, base: String, token: String, url: String) {
      var title = "Whale"
      var body: String
      var ok = false
      try {
        val conn = (URL("$base/api/items").openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          connectTimeout = 15000
          readTimeout = 30000
          doOutput = true
          setRequestProperty("Content-Type", "application/json")
          setRequestProperty("Authorization", "Bearer $token")
        }
        val payload = JSONObject().put("url", url).put("options", JSONObject()).toString()
        conn.outputStream.use { it.write(payload.toByteArray()) }
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val respText = stream?.bufferedReader()?.use { it.readText() } ?: ""
        val resp = try { JSONObject(respText) } catch (e: Exception) { JSONObject() }
        body = when {
          code in 200..299 -> {
            ok = true
            val item = resp.optJSONObject("item")
            title = item?.optString("title")?.takeIf { it.isNotEmpty() } ?: "Link"
            if (resp.optBoolean("duplicate")) "Already downloaded" else "Download queued ✓"
          }
          code == 422 || resp.optString("error") == "probe_failed" ->
            resp.optString("message").ifEmpty { "Couldn't read that link" }
          code == 401 -> "Auth failed — open Whale and set your token"
          else -> "Submit failed (HTTP $code)"
        }
        conn.disconnect()
      } catch (e: Exception) {
        body = "Can't reach the Whale server"
      }
      // Success → plain notification (stays in the background). Failure → tappable
      // notification that opens the app with the URL so the error is never lost.
      notifyResult(ctx, title, body, if (ok) null else url)
    }

    private fun notifyResult(ctx: Context, title: String, body: String, retryUrl: String?) {
      try {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val builder: Notification.Builder
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Quick Download", NotificationManager.IMPORTANCE_DEFAULT)
          )
          builder = Notification.Builder(ctx, CHANNEL_ID)
        } else {
          @Suppress("DEPRECATION")
          builder = Notification.Builder(ctx)
        }
        builder
          .setSmallIcon(R.drawable.ic_notification)
          .setContentTitle(title)
          .setContentText(body)
          .setStyle(Notification.BigTextStyle().bigText(body))
          .setAutoCancel(true)
        // On failure, tapping the notification reopens the app with the link so
        // the user can read the full error / retry with cookies.
        if (retryUrl != null) {
          val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
          val pi = PendingIntent.getActivity(
            ctx, retryUrl.hashCode(), openAppWithUrl(ctx, retryUrl), flags
          )
          builder.setContentIntent(pi)
        }
        nm.notify((System.currentTimeMillis() % 100000).toInt(), builder.build())
      } catch (e: Exception) {
        // Notifications are best-effort; the download was still submitted.
      }
    }
  }
}

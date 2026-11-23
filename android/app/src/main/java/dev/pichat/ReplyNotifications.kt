package dev.pichat

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.widget.RemoteViews
import org.json.JSONObject
import org.commonmark.parser.Parser
import org.commonmark.renderer.text.TextContentRenderer
import androidx.core.app.NotificationCompat

internal object ReplyNotifications {
    const val OPEN_REPLY = "dev.pichat.OPEN_REPLY"
    private const val CHANNEL = "chat_replies"
    private const val NOTIFICATION_ID = 2
    private const val PERMISSION_REQUEST = 921

    // Activity lifecycle and send completion both run on the main thread.
    private var visibleChats = 0

    fun chatStarted(context: Context) {
        visibleChats++
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }

    fun chatStopped() {
        visibleChats--
    }

    fun askOnce(activity: Activity) {
        if (Build.VERSION.SDK_INT < 33 ||
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = activity.getSharedPreferences("reply_notifications", Context.MODE_PRIVATE)
        if (prefs.getBoolean("asked", false)) return
        prefs.edit().putBoolean("asked", true).apply()
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), PERMISSION_REQUEST)
    }

    private val parser by lazy { Parser.builder().inlineParserFactory(::cjkInlineParser).build() }
    private val plainText by lazy { TextContentRenderer.builder().build() }

    private fun preview(turn: JSONObject): String {
        val answer = turn.optString("answer").trim()
        val file = turn.optJSONArray("replyFiles")?.optJSONObject(0)
        if (answer.isNotEmpty() && !(file != null && answer == "已生成附件。")) {
            val line = plainText.render(parser.parse(answer.take(2048))).trim().replace(Regex("\\s+"), " ")
            if (line.isNotEmpty()) return line
        }
        if (file != null) {
            if (file.optString("mime").startsWith("image/")) return "[图片]"
            return ("[文件] " + file.optString("name")).trimEnd()
        }
        return if (turn.has("stickerId")) "[表情]" else "[新消息]"
    }

    fun onReplySaved(context: Context, turn: JSONObject) {
        if (visibleChats > 0) return
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "回复提醒", NotificationManager.IMPORTANCE_HIGH))
        }
        val open = Intent(context, ChatActivity::class.java).setAction(OPEN_REPLY)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val body = preview(turn)
        val content = RemoteViews(context.packageName, R.layout.notification_reply).apply {
            setTextViewText(R.id.notification_body, body)
        }
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_piggy_notification)
            .setContentTitle(context.getString(R.string.reply_notification_title))
            .setContentText(body)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
            .setCustomContentView(content)
            .setCustomHeadsUpContentView(content)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(PendingIntent.getActivity(context, NOTIFICATION_ID, open,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_SOUND)
            .setAutoCancel(true)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }
}

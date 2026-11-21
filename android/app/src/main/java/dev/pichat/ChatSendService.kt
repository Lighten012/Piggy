package dev.pichat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/** Owns the active upload and reply independently of the chat Activity. All observer calls use the main thread. */
class ChatSendService : Service() {
    interface Listener {
        fun progress(partial: CharSequence, status: String, usage: ContextUsage?)
        fun finished(error: String?, outdated: Boolean)
    }

    companion object {
        var listener: Listener? = null
        private val partial = StringBuilder()
        private var status = "正在发送…"
        private var usage: ContextUsage? = null
        private var running: String? = null

        fun launch(context: Context, id: String) {
            if (running == id) {
                notifyProgress()
                return
            }
            ContextCompat.startForegroundService(context, Intent(context, ChatSendService::class.java).putExtra("request", id))
        }

        private fun notifyProgress() { listener?.progress(partial, status, usage) }
    }

    private lateinit var client: PiggyClient
    private var outdated = false
    private var latestStart = 0

    override fun onCreate() {
        super.onCreate()
        client = PiggyClient(this) { outdated = true }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        latestStart = startId
        val channel = "sending"
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(channel, "消息发送", NotificationManager.IMPORTANCE_LOW))
        val open = Intent(this, ChatActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val notification = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.nav_chat).setContentTitle(getString(R.string.app_name))
            .setContentText("正在发送消息或等待回复").setOngoing(true).setOnlyAlertOnce(true)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build()
        startForeground(1, notification)
        if (running != null) return START_REDELIVER_INTENT
        val id = client.pendingId
        if (!client.inFlight || id == null || intent?.getStringExtra("request") != id) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        running = id
        partial.clear()
        status = if (client.pendingAttachments.isEmpty()) "正在回复…" else "正在发送附件…"
        usage = null
        outdated = false
        notifyProgress()
        client.send(client.pendingText, client.pendingDraft, status = {
            partial.clear()
            status = it
            notifyProgress()
        }, measured = {
            usage = it
            client.rememberUsage(it)
            notifyProgress()
        }, delta = {
            partial.append(it)
            notifyProgress()
        }, finished = {
            running = null
            client.endFlight()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf(latestStart)
            listener?.finished(it, outdated)
        })
        return START_REDELIVER_INTENT
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        running = null
        partial.clear()
        client.close()
        super.onDestroy()
    }
}

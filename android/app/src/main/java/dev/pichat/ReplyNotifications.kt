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

    fun onReplySaved(context: Context) {
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
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.nav_chat)
            .setContentTitle("小猪回复你啦")
            .setContentText("点开看看 Piggy 的回复")
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

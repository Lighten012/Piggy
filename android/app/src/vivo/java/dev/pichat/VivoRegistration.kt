package dev.pichat

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.os.Build
import android.widget.Button
import android.widget.LinearLayout
import com.vivo.push.PushClient
import com.vivo.push.PushConfig
import com.vivo.push.listener.IPushQueryActionListener
import com.vivo.push.sdk.OpenClientPushMessageReceiver

class VivoReceiver : OpenClientPushMessageReceiver() {
    override fun onReceiveRegId(context: Context, regId: String) { VivoRegistration.save(context, regId) }
}

internal object VivoRegistration {
    private fun prefs(c: Context) = c.getSharedPreferences("vivo_push", Context.MODE_PRIVATE)
    fun save(c: Context, token: String) {
        if (prefs(c).getBoolean("enabled", false)) prefs(c).edit().putString("reg", token).apply()
    }
    fun token(c: Context): String? = prefs(c).getString("reg", null)
    fun resume(c: Context) {
        if (!prefs(c).getBoolean("enabled", false)) return
        val app = c.applicationContext
        runCatching {
            val sdk = PushClient.getInstance(app)
            sdk.initialize(PushConfig.Builder().agreePrivacyStatement(true).build())
            sdk.turnOnPush { state ->
                if (state == 0) sdk.getRegId(object : IPushQueryActionListener {
                    override fun onSuccess(id: String) = save(app, id)
                    override fun onFail(code: Int?) {}
                })
            }
        }
    }
    fun settings(a: Activity) {
        if (!Build.MANUFACTURER.equals("vivo", true) && !Build.BRAND.equals("iQOO", true)) return
        val button = Button(a)
        fun label() {button.text = if (prefs(a).getBoolean("enabled", false)) "管理 vivo 锁屏提醒" else "开启 vivo 锁屏提醒"}
        label()
        a.findViewById<LinearLayout>(R.id.settings_page).addView(button)
        button.setOnClickListener {
            if (prefs(a).getBoolean("enabled", false)) {
                AlertDialog.Builder(a).setTitle("vivo 锁屏提醒").setMessage(token(a)?.let { "测试设备 RegID\n$it" } ?: "设备注册中，请稍后查看。")
                    .setPositiveButton("完成", null).setNegativeButton("关闭提醒") { _, _ ->
                        prefs(a).edit().clear().apply()
                        runCatching { PushClient.getInstance(a.applicationContext).turnOffPush {} }
                        label()
                    }.show()
            } else AlertDialog.Builder(a).setTitle("允许 vivo 锁屏提醒？")
                .setMessage("vivo 会为这台手机分配推送标识。Piggy 会把标识和定时消息的通知预览发给 vivo，以便在锁屏时提醒你。")
                .setNegativeButton("取消", null).setPositiveButton("允许") { _, _ ->
                    prefs(a).edit().putBoolean("enabled", true).apply()
                    ReplyNotifications.askOnce(a)
                    resume(a)
                    label()
                }.show()
        }
    }
}

package dev.pichat

import android.app.AlertDialog
import android.app.Dialog
import android.app.DialogFragment
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast

/** User-initiated, per-installation settings for finishing a send after leaving the chat. */
class BackgroundSettingsDialog : DialogFragment() {
    private val deviceNames = listOf(Build.BRAND.lowercase(), Build.MANUFACTURER.lowercase())
    private val vivo = deviceNames.any { it == "vivo" || it == "iqoo" }
    private val oppo = "oppo" in deviceNames
    private val appUri get() = Uri.fromParts("package", activity.packageName, null)
    private val appDetails get() = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, appUri)
    private val optimizationList get() = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog =
        AlertDialog.Builder(activity)
            .setTitle("后台发送设置")
            .setMessage("")
            .setPositiveButton("调整电池优化", null)
            .setNeutralButton(if (vivo) "电池设置" else "应用信息", null)
            .setNegativeButton("关闭", null)
            .create()

    override fun onResume() {
        super.onResume()
        val panel = dialog as? AlertDialog ?: return
        val app = getString(R.string.app_name)
        val exempt = activity.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(activity.packageName)
        val state = if (exempt) "已豁免" else "优化中"
        val guide = when {
            vivo -> "vivo · 打开「电池设置」，在「后台耗电管理」或「后台高耗电」中找到「$app」，选择「允许后台高耗电」。"
            oppo -> "OPPO · 打开「应用信息」，在「耗电管理」或「电池用量」中允许后台活动。部分机型可从系统「设置 → 电池」找到应用耗电管理。"
            else -> "打开「应用信息」，在「电池」或「应用电池用量」中可调整后台活动。"
        }
        panel.setMessage("Android 电池优化：$state\n\n切到其他应用后，如果上传或等回复经常中断，可以单独放宽 Piggy 的省电限制。这样可能增加后台耗电。\n\n$guide")
        panel.getButton(AlertDialog.BUTTON_POSITIVE).apply {
            text = if (exempt) "管理电池优化" else "申请豁免"
            setOnClickListener {
                if (exempt) openSettings(optimizationList, appDetails)
                else openSettings(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, appUri), optimizationList, appDetails)
            }
        }
        panel.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
            if (vivo) openSettings(Intent(Intent.ACTION_POWER_USAGE_SUMMARY), appDetails)
            else openSettings(appDetails, optimizationList)
        }
    }

    private fun openSettings(vararg choices: Intent) {
        for (intent in choices) {
            try {
                startActivity(intent)
                return
            } catch (_: ActivityNotFoundException) {
                // Some OEMs omit this public settings entry.
            } catch (_: SecurityException) {
                // A settings page may exist but be private to the OEM.
            }
        }
        Toast.makeText(activity, "请打开手机设置，在电池设置中找到 " + getString(R.string.app_name), Toast.LENGTH_LONG).show()
    }
}

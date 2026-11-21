package dev.pichat

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast

internal enum class PowerSettingsDevice(val menu: String) {
    OPPO("应用耗电管理"), VIVO("后台耗电管理"), OTHER("后台电池设置");

    companion object {
        fun current(): PowerSettingsDevice {
            val names = listOf(Build.BRAND.lowercase(), Build.MANUFACTURER.lowercase())
            return when {
                "oppo" in names -> OPPO
                names.any { it == "vivo" || it == "iqoo" } -> VIVO
                else -> OTHER
            }
        }
    }

    fun directions(app: String) = when (this) {
        OPPO -> "在「应用耗电管理」中选择「$app」，开启「允许后台活动」。部分 ColorOS 版本叫「允许完全后台行为」。"
        VIVO -> "点「$app」进入它的后台耗电管理。如果选中的是「智能控制后台耗电」，改选「允许后台耗电」。"
        OTHER -> "在应用电池用量中点「允许后台使用」，有「不受限制」选项时可选中它。"
    }

    fun vendorMenus(): List<Intent> = when (this) {
        VIVO -> listOf(
            Intent("com.iqoo.powersaving.battery.high.power.jump").setPackage("com.iqoo.powersaving"),
            Intent().setClassName("com.vivo.abe", "com.vivo.applicationbehaviorengine.ui.ExcessivePowerManagerActivity")
        )
        OPPO -> listOf(Intent("com.oplus.powermanager.fuelgaue.PowerAppsBgSetting").setPackage("com.oplus.battery"))
        OTHER -> emptyList()
    }
}

private fun Activity.launchPage(intent: Intent): Boolean {
    try {
        startActivity(intent)
        return true
    } catch (_: ActivityNotFoundException) {
        return false
    } catch (_: SecurityException) {
        return false
    }
}

internal fun Activity.openBackgroundPowerSettings(device: PowerSettingsDevice) {
    val app = getString(R.string.app_name)
    val uri = Uri.fromParts("package", packageName, null)
    val appInfo = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
    if (device == PowerSettingsDevice.OTHER) {
        val detail = Intent("android.settings.VIEW_ADVANCED_POWER_USAGE_DETAIL", uri).setPackage("com.android.settings")
        if (launchPage(detail) || launchPage(appInfo)) return
    } else {
        for (intent in device.vendorMenus()) {
            val page = packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo ?: continue
            if (!page.exported || page.applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM == 0) continue
            if (page.permission != null && checkSelfPermission(page.permission) != PackageManager.PERMISSION_GRANTED) continue
            if (launchPage(intent)) return
        }
        val path = if (device == PowerSettingsDevice.OPPO) "电池 → 更多设置 → 应用耗电管理" else "电池 → 后台耗电管理"
        AlertDialog.Builder(this)
            .setTitle("从系统设置进入")
            .setMessage("这台手机未提供可直接打开的「${device.menu}」入口。请在系统设置中进入「$path」，或搜索「${device.menu}」。\n\n" + device.directions(app))
            .setNegativeButton("取消", null)
            .setPositiveButton("打开系统电池设置") { _, _ ->
                if (!launchPage(Intent(Intent.ACTION_POWER_USAGE_SUMMARY)) && !launchPage(Intent(Settings.ACTION_SETTINGS))) {
                    Toast.makeText(this, "请手动打开手机设置 → 电池", Toast.LENGTH_LONG).show()
                }
            }.show()
        return
    }
    Toast.makeText(this, "请在手机设置中打开「$app」的应用信息", Toast.LENGTH_LONG).show()
}

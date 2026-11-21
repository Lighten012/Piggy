package dev.pichat

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast

internal enum class PowerSettingsDevice {
    OPPO, VIVO, OTHER;

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
        OPPO -> "在「应用耗电管理」中选择「$app」，开启「允许完全后台行为」或「允许后台活动」。找不到时，可在系统设置中搜索「应用耗电管理」。"
        VIVO -> "在「后台耗电管理」或「后台高耗电」中选择「$app」，再选择「允许后台高耗电」。"
        OTHER -> "在应用电池用量中点「允许后台使用」，有「不受限制」选项时可选中它。"
    }
}

internal fun Activity.openBackgroundPowerSettings(device: PowerSettingsDevice) {
    val app = getString(R.string.app_name)
    val uri = Uri.fromParts("package", packageName, null)
    val battery = Intent(Intent.ACTION_POWER_USAGE_SUMMARY)
    val appInfo = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
    val detail = Intent("android.settings.VIEW_ADVANCED_POWER_USAGE_DETAIL", uri).setPackage("com.android.settings")
    val vendor = when (device) {
        PowerSettingsDevice.OPPO -> Intent("com.oplus.powermanager.fuelgaue.PowerAppsBgSetting").setPackage("com.oplus.battery")
        PowerSettingsDevice.VIVO -> Intent().setClassName("com.vivo.abe", "com.vivo.applicationbehaviorengine.ui.ExcessivePowerManagerActivity")
        PowerSettingsDevice.OTHER -> null
    }
    val pages = buildList {
        if (vendor != null) {
            // Some releases reserve this page for system apps. Only use an accessible system handler.
            val page = packageManager.resolveActivity(vendor, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo
            if (page != null && page.exported && page.applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM != 0 &&
                (page.permission == null || checkSelfPermission(page.permission) == PackageManager.PERMISSION_GRANTED)) {
                add(vendor to "选择「$app」，调整后台耗电策略")
            }
            val menu = if (device == PowerSettingsDevice.OPPO) "应用耗电管理" else "后台耗电管理"
            add(battery to "打开「$menu」，选择「$app」")
            add(appInfo to "打开电池或耗电管理，调整后台耗电策略")
        } else {
            add(detail to "在电池用量中选择后台策略")
            add(appInfo to "打开电池或耗电管理")
        }
        add(Intent(Settings.ACTION_SETTINGS) to "在系统设置中搜索「耗电管理」或「电池」")
    }
    for ((intent, guidance) in pages) {
        try {
            startActivity(intent)
            Toast.makeText(this, guidance, Toast.LENGTH_LONG).show()
            return
        } catch (_: ActivityNotFoundException) {
            // Try the next available system page.
        } catch (_: SecurityException) {
            // Access rules may differ across system versions.
        }
    }
    Toast.makeText(this, "请手动打开手机设置 → 电池", Toast.LENGTH_LONG).show()
}

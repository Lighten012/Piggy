package dev.pichat

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast

fun Activity.openBackgroundPowerSettings() {
    val app = getString(R.string.app_name)
    val uri = Uri.fromParts("package", packageName, null)
    val brands = listOf(Build.BRAND.lowercase(), Build.MANUFACTURER.lowercase())
    val vivo = brands.any { it == "vivo" || it == "iqoo" }
    val hint = when {
        vivo -> "选择「允许后台高耗电」"
        "oppo" in brands -> "开启「允许后台活动」"
        else -> "在电池用量中允许后台使用"
    }
    // AOSP exposes this per-app page on some releases. OEMs can omit or protect it.
    val detail = Intent("android.settings.VIEW_ADVANCED_POWER_USAGE_DETAIL", uri).setPackage("com.android.settings")
    val appInfo = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
    val battery = Intent(Intent.ACTION_POWER_USAGE_SUMMARY)
    val pages = buildList {
        add(detail to hint)
        if (vivo) add(battery to "后台耗电管理 → $app → 允许后台高耗电")
        add(appInfo to "打开耗电管理或电池用量，$hint")
        if (!vivo) add(battery to "找到「$app」，$hint")
    }
    for ((intent, guidance) in pages) {
        try {
            startActivity(intent)
            Toast.makeText(this, guidance, Toast.LENGTH_LONG).show()
            return
        } catch (_: ActivityNotFoundException) {
            // Try the next system settings page.
        } catch (_: SecurityException) {
            // Some ROMs reserve a matching page for system apps.
        }
    }
    Toast.makeText(this, "请打开手机设置 → 电池，找到「$app」", Toast.LENGTH_LONG).show()
}

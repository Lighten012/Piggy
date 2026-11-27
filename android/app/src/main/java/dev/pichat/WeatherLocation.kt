package dev.pichat

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject
import kotlin.math.roundToInt

/** Collect only while the chat is visible. Only rounded coordinates leave the phone. */
internal class WeatherLocation(private val context: Context) : LocationListener {
    private val manager = context.getSystemService(LocationManager::class.java)
    private var started = false
    fun start() {
        if (started || !allowed(context)) return
        started = true
        val providers = manager.getProviders(true)
        for (provider in providers) {
            runCatching { manager.getLastKnownLocation(provider) }.getOrNull()?.let(::onLocationChanged)
            if (provider != LocationManager.PASSIVE_PROVIDER) {
                runCatching { manager.requestLocationUpdates(provider, 15 * 60_000L, 0f, this, Looper.getMainLooper()) }
            }
        }
    }
    fun stop() {
        if (started) manager.removeUpdates(this)
        started = false
    }
    override fun onLocationChanged(location: Location) {
        val age = ((SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000).coerceAtLeast(0)
        if (!allowed(context) || age >= 86_400_000) return
        val observed = System.currentTimeMillis() - age
        synchronized(Companion) {
            val p = prefs(context)
            if (observed <= p.getLong("observed", 0)) return
            p.edit().putInt("lat", (location.latitude * 10).roundToInt())
                .putInt("lon", (location.longitude * 10).roundToInt()).putLong("observed", observed)
                .putLong("revision", nextRevision(context)).apply()
        }
    }
    @Deprecated("Legacy callback")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
    override fun onProviderDisabled(provider: String) = Unit
    override fun onProviderEnabled(provider: String) = Unit

    companion object {
        private fun prefs(c: Context) = c.getSharedPreferences("local-weather", Context.MODE_PRIVATE)
        fun granted(c: Context) = c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        // An explicit opt-out in build 57 can coexist with a system grant.
        fun legacyOff(c: Context) = !prefs(c).getBoolean("enabled", true)
        fun allowed(c: Context) = granted(c) && !legacyOff(c)
        fun declined(c: Context) = prefs(c).getBoolean("declined", false)
        fun decision(c: Context, allow: Boolean) {
            val edit = prefs(c).edit().putBoolean("declined", !allow)
            if (allow || !granted(c)) edit.remove("enabled")
            edit.apply()
        }
        private fun nextRevision(c: Context) = maxOf(System.currentTimeMillis(), prefs(c).getLong("revision", 0) + 1)
        @Synchronized fun snapshot(c: Context): JSONObject? {
            val p = prefs(c)
            if (!granted(c)) {
                val edit = p.edit()
                if (p.contains("enabled")) edit.remove("enabled")
                if (p.contains("observed")) edit.remove("observed").remove("lat").remove("lon")
                    .putLong("revision", nextRevision(c))
                edit.apply()
            }
            if (!p.contains("revision")) return null
            val observed = p.getLong("observed", 0)
            val place = if (allowed(c) && observed > System.currentTimeMillis() - 86_400_000)
                JSONObject().put("lat", p.getInt("lat", 0) / 10.0).put("lon", p.getInt("lon", 0) / 10.0)
                    .put("observed", observed).put("zone", java.util.TimeZone.getDefault().id) else JSONObject.NULL
            return JSONObject().put("revision", p.getLong("revision", 0)).put("place", place)
        }
    }
}

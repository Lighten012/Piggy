package dev.pichat

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import android.widget.Toolbar
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class SettingsActivity : Activity() {
    private lateinit var weather: android.widget.Switch
    override fun onResume() {
        super.onResume()
        weather.isChecked = WeatherLocation.enabled(this) && WeatherLocation.granted(this)
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode == 72) {
            weather.isChecked = WeatherLocation.granted(this)
            WeatherLocation.enable(this, weather.isChecked)
        }
    }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        setContentView(R.layout.activity_settings)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.settings_page)) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        findViewById<Toolbar>(R.id.settings_toolbar).setNavigationOnClickListener { finish() }
        weather = findViewById(R.id.local_weather)
        weather.setOnClickListener {
            if (weather.isChecked && !WeatherLocation.granted(this)) {
                weather.isChecked = false
                requestPermissions(arrayOf(android.Manifest.permission.ACCESS_COARSE_LOCATION), 72)
            } else WeatherLocation.enable(this, weather.isChecked)
        }
        val device = PowerSettingsDevice.current()
        findViewById<TextView>(R.id.power_directions).text = device.directions(getString(R.string.app_name))
        findViewById<TextView>(R.id.background_power).apply {
            text = device.menu
            setOnClickListener { openBackgroundPowerSettings(device) }
        }
    }
}

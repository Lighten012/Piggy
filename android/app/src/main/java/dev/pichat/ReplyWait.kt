package dev.pichat

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.provider.Settings
import android.view.animation.LinearInterpolator
import android.widget.TextView
import org.json.JSONArray
import javax.net.ssl.HttpsURLConnection
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.roundToInt

internal object ReplyPhrases {
    const val HOUR = 3_600_000L
    const val WAITING = "正在回复…"
    private val defaults = listOf("小猪正在努力回复中", "小猪正在为你寻找答案", "Piggy 正在加油哦")
    private fun prefs(context: Context) = context.getSharedPreferences("reply-phrases", Context.MODE_PRIVATE)
    private fun parse(raw: String): List<String> {
        val array = JSONArray(raw)
        require(array.length() in 1..48)
        return List(array.length()) {
            val text = array.get(it) as String
            require(text.isNotBlank() && text.codePointCount(0, text.length) <= 48)
            text
        }
    }
    fun current(context: Context): List<String> =
        prefs(context).getString("list", null)?.let { runCatching { parse(it) }.getOrNull() } ?: defaults

    @Volatile private var fetching = false
    // Called on the main thread. Only the timestamp of a successful refresh expires the cached list.
    fun refresh(context: Context): Long {
        val app = context.applicationContext
        val settings = prefs(app)
        val age = System.currentTimeMillis() - settings.getLong("saved", 0)
        if (age in 0 until HOUR) return HOUR - age
        if (!fetching) {
            fetching = true
            Thread {
                try {
                    val http = PiggyServer.mobile(context, PiggyServer.url("/mobile/reply-phrases"))
                    try {
                        http.connectTimeout = 5000
                        http.readTimeout = 5000
                        http.instanceFollowRedirects = false
                        if (http.responseCode == 200) {
                            val raw = http.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                            parse(raw)
                            settings.edit().putString("list", raw).putLong("saved", System.currentTimeMillis()).apply()
                        }
                    } finally { http.disconnect() }
                } catch (_: Exception) {
                    // Keep the last good list, including when the server is temporarily unreachable.
                } finally { fetching = false }
            }.start()
        }
        return 300_000L
    }
}

private const val PHRASE_INTERVAL_MS = 10_000L

internal class ReplyWait(private val bubble: TextView) {
    private val phrases = ReplyPhrases.current(bubble.context)
    private var index = 0
    private var waiting = false
    private var visible = false
    private val dots = Dots(bubble.resources.displayMetrics.density, bubble.currentHintTextColor)
    private val animation = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 1150
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener { dots.phase = it.animatedValue as Float; dots.invalidateSelf() }
    }
    private val rotate = object : Runnable {
        override fun run() {
            index = (index + 1) % phrases.size
            bubble.hint = phrases[index]
            bubble.postDelayed(this, PHRASE_INTERVAL_MS)
        }
    }

    fun show(status: String, hasText: Boolean) {
        val next = !hasText && status == ReplyPhrases.WAITING
        if (next != waiting) {
            waiting = next
            bubble.setCompoundDrawablesRelative(null, null, if (waiting) dots else null, null)
            updateMotion()
        }
        if (!next) bubble.hint = if (hasText) null else status
    }

    fun visible(value: Boolean) {
        if (visible == value) return
        visible = value
        updateMotion()
    }

    private fun updateMotion() {
        bubble.removeCallbacks(rotate)
        animation.cancel()
        if (!waiting) return
        bubble.hint = phrases[index]
        if (!visible) return
        if (phrases.size > 1) bubble.postDelayed(rotate, PHRASE_INTERVAL_MS)
        if (Settings.Global.getFloat(bubble.context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f)
            animation.start()
    }

    private class Dots(val density: Float, color: Int) : Drawable() {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
        var phase = 0f
        init { setBounds(0, 0, (22 * density).roundToInt(), (18 * density).roundToInt()) }
        override fun draw(canvas: Canvas) {
            for (i in 0..2) {
                val beat = (phase * 1.5f - i * .16f)
                val lift = if (beat in 0f..0.6f) sin(PI * beat / .6).toFloat() * 3f else 0f
                canvas.drawCircle((6 + 6 * i) * density, (11 - lift) * density, 1.7f * density, paint)
            }
        }
        override fun setAlpha(alpha: Int) { paint.alpha = alpha }
        override fun setColorFilter(filter: ColorFilter?) { paint.colorFilter = filter }
        @Deprecated("Drawable API") override fun getOpacity() = PixelFormat.TRANSLUCENT
    }
}

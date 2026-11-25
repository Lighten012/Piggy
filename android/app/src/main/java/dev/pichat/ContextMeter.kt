package dev.pichat

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.Gravity
import android.widget.TextView
import java.text.NumberFormat
import java.util.Locale

data class ContextUsage(val used: Int, val limit: Int) {
    private val numbers get() = NumberFormat.getIntegerInstance(Locale.US)
    val detail get() = "${numbers.format(used)} / ${numbers.format(limit)} tokens"
    val percent: String get() = when {
        used == 0 -> "0%"
        used < limit / 100 -> "<1%"
        else -> "${100L * used / limit}%"
    }
}

class ContextMeter(context: Context) : TextView(context) {
    private val density = resources.displayMetrics.density
    private val paintRing = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.5f * density
        strokeCap = Paint.Cap.ROUND
    }
    private val bounds = RectF()
    var usage: ContextUsage? = null
        private set
    init {
        gravity = Gravity.CENTER_VERTICAL or Gravity.RIGHT
        setPadding((31 * density).toInt(), 0, (5 * density).toInt(), 0)
        setTextColor(0xff675275.toInt())
        textSize = 13f
        minimumWidth = paddingLeft + paddingRight + kotlin.math.ceil(paint.measureText("100%")).toInt()
        isFocusable = true
        val style = android.util.TypedValue()
        context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, style, true)
        setBackgroundResource(style.resourceId)
        text = "—"
        contentDescription = "上下文用量，暂未获取，查看详情"
    }

    fun update(value: ContextUsage) {
        usage = value
        text = value.percent
        contentDescription = "上下文用量，" + value.detail + "，查看详情"
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val x = 15f * density
        val y = height / 2f
        val r = 8f * density
        bounds.set(x-r, y-r, x+r, y+r)
        paintRing.color = 0xffd8d1df.toInt()
        canvas.drawOval(bounds, paintRing)
        val value = usage ?: return
        paintRing.color = if (value.used >= value.limit) 0xff97354b.toInt() else 0xff77558f.toInt()
        canvas.drawArc(bounds, -90f, (360f * value.used / value.limit).coerceAtMost(360f), false, paintRing)
    }
}

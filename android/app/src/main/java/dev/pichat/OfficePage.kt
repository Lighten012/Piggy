package dev.pichat

import android.content.Context
import android.graphics.*
import android.view.*
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.sqrt

/**
 * Coordinates are document twips; the engine paints only the visible rectangle at screen
 * resolution.
 */
internal class OfficePage(
    context: Context,
    private val docWidth: Int,
    private val docHeight: Int,
    private val sheet: Boolean,
    description: String,
    private val paintRegion: (Rect, Int, Int, (Bitmap) -> Unit) -> Unit,
) : View(context) {
    private var scale = 0.0
    private var initial = 0.0
    private var minScale = 0.0
    private var panX = 0.0
    private var panY = 0.0
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    private var image: Bitmap? = null
    private var painted = Rect()
    private var target = Rect()
    private var busy = false
    private var targetWidth = 0
    private var targetHeight = 0
    private var drawnWidth = 0
    private var drawnHeight = 0

    private val pinch =
        ScaleGestureDetector(
            context,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScale(d: ScaleGestureDetector): Boolean {
                    zoom(scale * d.scaleFactor, d.focusX, d.focusY)
                    return true
                }
            },
        )
    private val gestures =
        GestureDetector(
            context,
            object : GestureDetector.SimpleOnGestureListener() {
                override fun onDown(e: MotionEvent) = true

                override fun onDoubleTap(e: MotionEvent): Boolean {
                    zoom(if (scale > initial * 1.2) initial else initial * 2.5, e.x, e.y)
                    return true
                }

                override fun onScroll(
                    e1: MotionEvent?,
                    e2: MotionEvent,
                    dx: Float,
                    dy: Float,
                ): Boolean {
                    if (!pinch.isInProgress) {
                        panX += dx
                        panY += dy
                        invalidate()
                    }
                    return true
                }
            },
        )

    init {
        contentDescription = description
        setBackgroundColor(Color.rgb(246, 245, 248))
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val fit = minOf(w.toDouble() / docWidth, h.toDouble() / docHeight)
        initial = if (sheet) maxOf(fit, resources.displayMetrics.density / 20.0) else fit
        minScale = if (sheet) minOf(initial, maxOf(fit, initial / 5)) else fit
        scale = initial
        panX = 0.0
        panY = 0.0
    }

    private fun insetX() = if (sheet) 0.0 else maxOf(0.0, (width - docWidth * scale) / 2)

    private fun insetY() = if (sheet) 0.0 else maxOf(0.0, (height - docHeight * scale) / 2)

    private fun zoom(wanted: Double, fx: Float, fy: Float) {
        val x = (panX + fx - insetX()) / scale
        val y = (panY + fy - insetY()) / scale
        scale =
            wanted.coerceIn(minScale, maxOf(initial * 8, resources.displayMetrics.density / 3.0))
        panX = x * scale - fx + insetX()
        panY = y * scale - fy + insetY()
        invalidate()
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        pinch.onTouchEvent(e)
        gestures.onTouchEvent(e)
        return true
    }

    private val render = Runnable {
        if (!isAttachedToWindow || busy || target.isEmpty) return@Runnable
        val area = Rect(target)
        val w = targetWidth
        val h = targetHeight
        busy = true
        paintRegion(area, w, h) { bm ->
            painted = area
            image = bm
            drawnWidth = w
            drawnHeight = h
            busy = false
            invalidate()
        }
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(render)
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        if (scale <= 0) return
        panX = panX.coerceIn(0.0, maxOf(0.0, docWidth * scale - width))
        panY = panY.coerceIn(0.0, maxOf(0.0, docHeight * scale - height))
        val x = insetX() - panX
        val y = insetY() - panY
        fun rect(r: Rect) =
            RectF(
                (x + r.left * scale).toFloat(),
                (y + r.top * scale).toFloat(),
                (x + r.right * scale).toFloat(),
                (y + r.bottom * scale).toFloat(),
            )
        paint.color = Color.WHITE
        canvas.drawRect(rect(Rect(0, 0, docWidth, docHeight)), paint)
        image?.let { canvas.drawBitmap(it, null, rect(painted), paint) }
        target.set(
            floor(-x / scale).toInt().coerceAtLeast(0),
            floor(-y / scale).toInt().coerceAtLeast(0),
            ceil((width - x) / scale).toInt().coerceAtMost(docWidth),
            ceil((height - y) / scale).toInt().coerceAtMost(docHeight),
        )
        val w = maxOf(1, ceil(target.width() * scale).toInt())
        val h = maxOf(1, ceil(target.height() * scale).toInt())
        val shrink = minOf(1.0, sqrt(2300000.0 / w / h))
        targetWidth = maxOf(1, (w * shrink).toInt())
        targetHeight = maxOf(1, (h * shrink).toInt())
        if (
            !busy &&
                (image == null ||
                    target != painted ||
                    targetWidth != drawnWidth ||
                    targetHeight != drawnHeight)
        ) {
            removeCallbacks(render)
            postDelayed(render, if (image == null) 0 else 35)
        }
    }
}

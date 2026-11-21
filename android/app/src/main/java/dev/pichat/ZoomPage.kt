package dev.pichat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View

internal class ZoomPage(
    context: Context,
    private val bitmap: Bitmap,
    page: Int,
    private val renderDetail: (RectF, Int, Int, (Bitmap) -> Unit) -> Unit,
) : View(context) {
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    private var detail: Bitmap? = null
    private var detailArea: RectF? = null
    private var requested: RectF? = null
    private var rendering = false
    private var task: Runnable? = null
    private var zoom = 1f
    private var dx = 0f
    private var dy = 0f
    private val scale =
        ScaleGestureDetector(
            context,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScale(detector: ScaleGestureDetector): Boolean {
                    resize(zoom * detector.scaleFactor, detector.focusX, detector.focusY)
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
                    resize(if (zoom > 1.2f) 1f else 2.5f, e.x, e.y)
                    return true
                }

                override fun onScroll(
                    e1: MotionEvent?,
                    e2: MotionEvent,
                    distanceX: Float,
                    distanceY: Float,
                ): Boolean {
                    if (!scale.isInProgress) {
                        dx -= distanceX
                        dy -= distanceY
                        invalidate()
                    }
                    return true
                }
            },
        )

    init {
        contentDescription = "第 ${page} 页，双击或双指缩放"
    }

    private fun resize(value: Float, x: Float, y: Float) {
        val next = value.coerceIn(1f, 6f)
        val ratio = next / zoom
        dx = (dx - (x - width / 2f)) * ratio + (x - width / 2f)
        dy = (dy - (y - height / 2f)) * ratio + (y - height / 2f)
        zoom = next
        invalidate()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scale.onTouchEvent(event)
        gestures.onTouchEvent(event)
        return true
    }

    override fun onDraw(canvas: Canvas) {
        val factor = minOf(width.toFloat() / bitmap.width, height.toFloat() / bitmap.height) * zoom
        val w = bitmap.width * factor
        val h = bitmap.height * factor
        val xLimit = maxOf(0f, (w - width) / 2)
        val yLimit = maxOf(0f, (h - height) / 2)
        dx = dx.coerceIn(-xLimit, xLimit)
        dy = dy.coerceIn(-yLimit, yLimit)
        val x = (width - w) / 2 + dx
        val y = (height - h) / 2 + dy
        canvas.drawBitmap(bitmap, null, RectF(x, y, x + w, y + h), paint)
        if (zoom <= 1.5f) return
        val area =
            RectF(
                maxOf(0f, -x / w),
                maxOf(0f, -y / h),
                minOf(1f, (width - x) / w),
                minOf(1f, (height - y) / h),
            )
        detailArea?.let { r ->
            detail?.let {
                canvas.drawBitmap(
                    it,
                    null,
                    RectF(x + r.left * w, y + r.top * h, x + r.right * w, y + r.bottom * h),
                    paint,
                )
            }
        }
        if (rendering || area == requested) return
        requested = area
        task?.let { removeCallbacks(it) }
        task =
            Runnable {
                    if (!isAttachedToWindow || zoom <= 1.5f) {
                        requested = null
                        return@Runnable
                    }
                    rendering = true
                    renderDetail(
                        area,
                        (area.width() * w).toInt().coerceAtLeast(1),
                        (area.height() * h).toInt().coerceAtLeast(1),
                    ) { result ->
                        rendering = false
                        detailArea = area
                        detail = result
                        invalidate()
                    }
                }
                .also { postDelayed(it, 100) }
    }
}

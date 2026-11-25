package dev.pichat

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.View
import android.widget.*
import java.util.Locale
import kotlin.math.roundToInt

internal class UpdateTicket(context: Context) : LinearLayout(context) {
    companion object { val backdrop = 0xffe9e7d8.toInt() }
    private val paper = 0xfffffcf3.toInt()
    private val ink = 0xff394334.toInt()
    private val sage = 0xff506449.toInt()
    private val match = LayoutParams.MATCH_PARENT
    private val wrap = LayoutParams.WRAP_CONTENT
    private fun dp(n: Int) = (n * resources.displayMetrics.density).roundToInt()
    private fun fill(color: Int, radius: Int) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius).toFloat()
    }
    private fun label(size: Float, color: Int = ink) = TextView(context).apply {
        setTextColor(color); textSize = size; includeFontPadding = false
    }

    private val version = label(16f, sage)
    private val title = label(25f)
    private val detail = label(14f, sage)
    private val percent = label(17f)
    private val bar = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal)
    private val action = Button(context)

    init {
        orientation = VERTICAL
        setBackgroundColor(backdrop)
        val brand = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(22), dp(8), dp(22), dp(8))
            addView(ImageView(context).apply { setImageResource(R.drawable.piggy_portrait) },dp(32),dp(32))
            addView(label(22f).apply { text = "Piggy"; typeface = Typeface.create("serif",Typeface.BOLD) },
                LayoutParams(wrap,wrap).apply { leftMargin = dp(9) })
        }
        addView(brand,match,wrap)
        val scroll = ScrollView(context).apply { isFillViewport = true; isVerticalScrollBarEnabled = false }
        addView(scroll,LayoutParams(match,0,1f))
        val stage = LinearLayout(context).apply {
            orientation = VERTICAL; gravity = Gravity.CENTER
            setPadding(dp(24),dp(16),dp(24),dp(30))
            clipChildren = false; clipToPadding = false
        }
        scroll.addView(stage)
        val card = object : LinearLayout(context) {
            override fun onMeasure(widthSpec: Int, heightSpec: Int) {
                val width = minOf(View.MeasureSpec.getSize(widthSpec),dp(380))
                super.onMeasure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),heightSpec)
            }
        }.apply {
            orientation = VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0,dp(28),0,dp(24))
            background = fill(paper,12)
            elevation = dp(3).toFloat()
            clipChildren = false
        }
        stage.addView(card,match,wrap)

        val photo = FrameLayout(context).apply {
            rotation = -7f
            background = fill(0xfffffef8.toInt(),1)
            elevation = dp(3).toFloat()
            clipChildren = false
            addView(ImageView(context).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                setImageResource(R.drawable.piggy_launcher_photo)
            }, FrameLayout.LayoutParams(match, match).apply { setMargins(dp(6),dp(6),dp(6),dp(18)) })
            addView(View(context).apply { rotation = 4f; setBackgroundColor(0xd6dbcfac.toInt()) },
                FrameLayout.LayoutParams(dp(53),dp(16),Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = -dp(6) })
        }
        card.addView(photo,dp(141),dp(144))
        version.gravity = Gravity.CENTER
        version.typeface = Typeface.create("serif",Typeface.ITALIC)
        card.addView(version, LayoutParams(match,wrap).apply { topMargin = dp(16) })
        val seam = object : View(context) {
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val dashes = DashPathEffect(floatArrayOf(dp(4).toFloat(),dp(4).toFloat()),0f)
            override fun onDraw(canvas: Canvas) {
                val y = height/2f
                paint.color = 0xffb9bbab.toInt(); paint.strokeWidth = resources.displayMetrics.density
                paint.pathEffect = dashes
                canvas.drawLine(dp(8).toFloat(),y,width-dp(8).toFloat(),y,paint)
                paint.pathEffect = null; paint.color = backdrop
                canvas.drawCircle(0f,y,dp(9).toFloat(),paint)
                canvas.drawCircle(width.toFloat(),y,dp(9).toFloat(),paint)
            }
        }
        card.addView(seam, LayoutParams(match,dp(22)).apply { topMargin = dp(17) })
        val stub = LinearLayout(context).apply {
            orientation = VERTICAL
            setPadding(dp(24),dp(12),dp(24),0)
            minimumHeight = dp(144)
        }
        card.addView(stub,match,wrap)
        title.typeface = Typeface.DEFAULT_BOLD
        stub.addView(title,match,wrap)
        bar.max = 100
        bar.progressTintList = ColorStateList.valueOf(sage)
        bar.indeterminateTintList = ColorStateList.valueOf(sage)
        bar.progressBackgroundTintList = ColorStateList.valueOf(0xffe2e2d6.toInt())
        stub.addView(bar,LayoutParams(match,dp(12)).apply { topMargin = dp(14) })
        val stats = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        stub.addView(stats,LayoutParams(match,wrap).apply { topMargin = dp(8) })
        stats.addView(detail,LayoutParams(0,wrap,1f))
        percent.typeface = Typeface.DEFAULT_BOLD
        stats.addView(percent,LayoutParams(wrap,wrap).apply { leftMargin = dp(6) })
        action.background = RippleDrawable(ColorStateList.valueOf(0x33ffffff),fill(sage,14),null)
        action.setTextColor(-1); action.textSize = 16f; action.minimumHeight = dp(48)
        stub.addView(action,LayoutParams(match,wrap).apply { topMargin = dp(15) })
    }

    fun show(state: UpdateState, install: () -> Unit, retry: () -> Unit) {
        val name = when (state) {
            is UpdateState.Downloading -> state.name
            is UpdateState.Ready -> state.name
            is UpdateState.Preparing -> state.name
            else -> BuildConfig.VERSION_NAME
        }
        version.text = "Piggy · $name"
        val busy = state == UpdateState.Checking || state is UpdateState.Preparing
        bar.isIndeterminate = busy
        bar.visibility = if (busy || state is UpdateState.Downloading) VISIBLE else GONE
        percent.visibility = if (state is UpdateState.Downloading) VISIBLE else GONE
        action.visibility = GONE
        when (state) {
            UpdateState.Checking -> { title.text = "正在检查更新"; detail.text = "正在获取版本信息" }
            is UpdateState.Preparing -> { title.text = state.message; detail.text = "正在准备安装包" }
            is UpdateState.Downloading -> {
                title.text = "正在下载更新"
                bar.progress = (state.received * 100 / state.total).toInt()
                percent.text = "${bar.progress}%"
                detail.text = String.format(Locale.ROOT,"%s · %.1f / %.1f MB",state.mode,state.received/1e6,state.total/1e6)
            }
            is UpdateState.Ready -> {
                title.text = "更新已准备好"; detail.text = "安装后就能继续聊天。"
                button("安装更新",install)
            }
            UpdateState.Occupied -> {
                title.text = "这个 Piggy 已连接其他安装"; detail.text = "请使用原来的 Piggy。如已换机或重装，请联系管理员。"
                button("重新连接",retry)
            }
            is UpdateState.Failed -> { title.text = "暂时无法完成更新"; detail.text = state.message; button("重试",retry) }
            UpdateState.Current -> Unit
        }
    }

    private fun button(caption: String, click: () -> Unit) {
        action.text = caption; action.visibility = VISIBLE
        action.setOnClickListener { click() }
    }
}

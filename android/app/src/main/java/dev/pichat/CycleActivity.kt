package dev.pichat

import android.app.Activity
import android.app.AlertDialog
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Calendar
import kotlin.math.roundToInt

class CycleActivity : Activity() {
    private val prefs by lazy { getSharedPreferences("cycle_calendar", MODE_PRIVATE) }
    private var selected = CivilDay.today()
    private lateinit var content: LinearLayout
    private val ink = Color.rgb(59, 46, 65)
    private val muted = Color.rgb(104, 89, 111)
    private val plum = Color.rgb(103, 67, 126)
    private val lilac = Color.rgb(239, 231, 248)
    private val rose = Color.rgb(251, 229, 236)
    private val mint = Color.rgb(222, 242, 235)
    private val paper = Color.WHITE
    private val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    private val match = LinearLayout.LayoutParams.MATCH_PARENT
    private fun dp(n: Int) = (n * resources.displayMetrics.density).roundToInt()
    private fun box(color: Int, radius: Int = 14) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius).toFloat()
    }
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun label(value: String, size: Int, color: Int = ink, bold: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size.toFloat()
        setTextColor(color)
        if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        gravity = Gravity.CENTER_VERTICAL
    }
    private fun action(title: String, fill: Int, click: () -> Unit) = label(title, 15, plum, true).apply {
        gravity = Gravity.CENTER
        setPadding(dp(10), 0, dp(10), 0)
        minHeight = dp(46)
        background = RippleDrawable(ColorStateList.valueOf(0x22694D83), box(fill), null)
        isFocusable = true
        setOnClickListener { click() }
    }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        selected = state?.getInt("day", selected) ?: selected
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        val page = column().apply { setBackgroundColor(Color.rgb(250, 247, 251)) }
        ViewCompat.setOnApplyWindowInsetsListener(page) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val toolbar = Toolbar(this).apply {
            title = "经期管理"
            setTitleTextColor(ink)
            val icon = android.util.TypedValue()
            theme.resolveAttribute(android.R.attr.homeAsUpIndicator, icon, true)
            setNavigationIcon(icon.resourceId)
            navigationContentDescription = "返回聊天"
            setNavigationOnClickListener { finish() }
            menu.add("周期设置").setShowAsAction(android.view.MenuItem.SHOW_AS_ACTION_ALWAYS)
            setOnMenuItemClickListener { settings(); true }
        }
        page.addView(toolbar, match, dp(54))
        content = column().apply { setPadding(dp(12), dp(8), dp(12), dp(18)) }
        page.addView(ScrollView(this).apply { addView(content) }, match, match)
        setContentView(page)
        render()
    }
    override fun onSaveInstanceState(state: Bundle) {
        super.onSaveInstanceState(state)
        state.putInt("day", selected)
    }
    private fun model() = CycleCalendar(
        prefs.getStringSet("starts", emptySet()).orEmpty().mapNotNull { it.toIntOrNull() }.toSet(),
        prefs.getInt("length", 28), prefs.getInt("duration", 5)
    )
    private fun select(day: Int) { selected = day; render() }
    private fun mark(record: Boolean) {
        val starts = model().starts
        val changed = if (record) starts + selected else starts - selected
        prefs.edit().putStringSet("starts", changed.map { it.toString() }.toSet()).apply()
        render()
    }
    private fun card(): LinearLayout = column().apply {
        background = box(paper, 22)
        setPadding(dp(10), dp(12), dp(10), dp(12))
        content.addView(this, LinearLayout.LayoutParams(match, wrap).apply { bottomMargin = dp(12) })
    }
    private fun dayMark(day: CycleDay?): String = when {
        day == null -> ""
        day.recorded -> "已记"
        day.ovulation -> "排卵"
        day.period -> "经期"
        day.fertile -> "易孕"
        else -> day.phase?.removeSuffix("期").orEmpty()
    }
    private fun render() {
        content.removeAllViews()
        val cycle = model()
        val date = CivilDay.calendar(selected)
        val month = date.get(Calendar.MONTH) + 1
        val today = CivilDay.today()
        val calendar = card()
        val heading = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        heading.addView(label("${date.get(Calendar.YEAR)} 年 ${month} 月", 21, ink, true),
            LinearLayout.LayoutParams(0, wrap, 1f))
        heading.addView(action("今天", paper) { select(today) })
        for ((step, sign) in listOf(-1 to "‹", 1 to "›")) {
            heading.addView(action(sign, paper) { select(CivilDay.shiftMonth(selected, step)) }.apply {
                textSize = 26f
                contentDescription = if (step < 0) "上个月" else "下个月"
            }, dp(44), dp(48))
        }
        calendar.addView(heading, match, wrap)
        val week = LinearLayout(this)
        for (weekday in "一二三四五六日") week.addView(label(weekday.toString(), 13, muted).apply {
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(0, dp(34), 1f))
        calendar.addView(week)
        val first = CivilDay.first(selected)
        val offset = (CivilDay.calendar(first).get(Calendar.DAY_OF_WEEK) + 5) % 7
        val days = date.getActualMaximum(Calendar.DAY_OF_MONTH)
        repeat((offset + days + 6) / 7) { row ->
            val strip = LinearLayout(this)
            repeat(7) { col ->
                val index = row * 7 + col - offset
                val cell = if (index !in 0 until days) View(this) else {
                    val day = first + index
                    val info = cycle.on(day)
                    val mark = dayMark(info)
                    val fill = when (mark) {
                        "已记", "经期" -> rose
                        "易孕" -> mint
                        "排卵" -> lilac
                        else -> paper
                    }
                    column().apply {
                        gravity = Gravity.CENTER
                        val shape = box(fill, 12)
                        if (day == selected) shape.setStroke(dp(2), plum)
                        background = RippleDrawable(ColorStateList.valueOf(0x22694D83), shape, null)
                        addView(label((index + 1).toString(), 16, ink, day == today))
                        val sub = mark.ifEmpty { if (day == today) "今天" else "" }
                        if (sub.isNotEmpty()) addView(label(sub, 11, ink))
                        contentDescription = "${month}月${index + 1}日" + (if (day == today) "，今天" else "") +
                            (if (mark == "已记") "，已记录开始日" else if (mark.isEmpty()) "" else "，预计$mark")
                        isSelected = day == selected
                        isFocusable = true
                        setOnClickListener { select(day) }
                    }
                }
                strip.addView(cell, LinearLayout.LayoutParams(0, dp(49), 1f))
            }
            calendar.addView(strip)
        }
        calendar.addView(label("“已记”是实际开始日，其他阶段均为预计。点日期查看详情。", 13, muted).apply {
            setPadding(dp(6), dp(12), dp(6), 0)
        })
        val detail = card().apply { setPadding(dp(16), dp(14), dp(16), dp(14)) }
        val info = cycle.on(selected)
        val title = "${month}月${date.get(Calendar.DAY_OF_MONTH)}日"
        detail.addView(label(title + (info?.let { "  ·  周期第 ${it.position} 天" } ?: ""), 18, ink, true))
        val description = if (info == null) {
            if (cycle.starts.isEmpty()) "点选最近一次月经开始的日期，记下第一天后即可查看预测。" else "这一天早于最早的经期记录。"
        } else listOfNotNull(
            if (info.recorded) "已记录经期开始" else if (info.period) "预计经期" else null,
            info.phase?.let { "预计$it" } ?: "本版仅对 21–35 天的周期估算排卵",
            if (info.fertile) "预计易孕窗" else null
        ).joinToString(" · ")
        detail.addView(label(description, 15, muted).apply { setPadding(0, dp(6), 0, dp(12)) })
        if (selected <= today) {
            if (selected in cycle.starts) detail.addView(action("撤销这次开始记录", lilac) {
                AlertDialog.Builder(this).setMessage("撤销 ${title} 的经期开始记录？")
                    .setNegativeButton("取消", null).setPositiveButton("撤销") { _, _ -> mark(false) }.show()
            }) else detail.addView(action("记为经期第一天", lilac) { mark(true) })
        }
        content.addView(label("周期 ${cycle.length} 天  ·  经期 ${cycle.duration} 天", 14, ink, true))
        content.addView(label("日期仅按记录推算，周期不规律时偏差更大，不能用于避孕。记录仅保存在本机。", 13, muted).apply { setPadding(0, dp(4), 0, 0) })
    }
    private fun settings() {
        val cycle = model()
        val form = column().apply { setPadding(dp(24), dp(12), dp(24), 0) }
        fun field(title: String, value: Int): EditText {
            val input = EditText(this).apply {
                id = View.generateViewId()
                inputType = InputType.TYPE_CLASS_NUMBER
                setSingleLine()
                setText(value.toString())
                selectAll()
            }
            form.addView(label(title, 15).apply { labelFor = input.id })
            form.addView(input)
            return input
        }
        val length = field("周期间隔（两次开始日相隔的天数）", cycle.length)
        val duration = field("经期持续天数", cycle.duration)
        val dialog = AlertDialog.Builder(this).setTitle("周期设置").setView(form)
            .setNegativeButton("取消", null).setPositiveButton("保存", null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val span = length.text.toString().toIntOrNull()
                val bleed = duration.text.toString().toIntOrNull()
                when {
                    span == null || span !in 2..365 -> length.error = "请输入 2 至 365 天"
                    bleed == null || bleed !in 1 until span -> duration.error = "持续天数须至少 1 天，并短于周期间隔"
                    else -> {
                        prefs.edit().putInt("length", span).putInt("duration", bleed).apply()
                        dialog.dismiss()
                        render()
                    }
                }
            }
        }
        dialog.show()
    }
}

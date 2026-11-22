package dev.pichat

import android.app.Activity
import android.app.AlertDialog
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Bundle
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
    private fun model(): CycleCalendar {
        val starts = prefs.getStringSet("starts", emptySet()).orEmpty().mapNotNull { it.toIntOrNull() }.toSet()
        val ends = starts.filter { prefs.contains("end_$it") }.associateWith { prefs.getInt("end_$it", it) }
        return CycleCalendar(starts, prefs.getInt("length", 28), prefs.getInt("duration", 5), ends)
    }
    private fun dateText(day: Int) = CivilDay.calendar(day).run {
        "${get(Calendar.MONTH) + 1}月${get(Calendar.DAY_OF_MONTH)}日"
    }
    private fun setEnd(start: Int, end: Int?) {
        val edit = prefs.edit()
        if (end == null) edit.remove("end_$start") else edit.putInt("end_$start", end)
        edit.apply()
        render()
    }
    private fun select(day: Int) { selected = day; render() }
    private fun mark(record: Boolean) {
        val starts = model().starts
        val changed = if (record) starts + selected else starts - selected
        val edit = prefs.edit().putStringSet("starts", changed.map { it.toString() }.toSet())
        if (!record) edit.remove("end_$selected")
        edit.apply()
        render()
    }
    private fun card(): LinearLayout = column().apply {
        background = box(paper, 22)
        setPadding(dp(10), dp(12), dp(10), dp(12))
        content.addView(this, LinearLayout.LayoutParams(match, wrap).apply { bottomMargin = dp(12) })
    }
    private fun dayMark(date: Int, day: CycleDay?): String = when {
        day == null -> ""
        day.recorded && day.actualEnd == date -> "起止"
        day.recorded -> "开始"
        day.actualEnd == date -> "结束"
        day.confirmed -> "实记"
        day.predictedEnd == date -> "预计止"
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
                    val mark = dayMark(day, info)
                    val fill = when (mark) {
                        "开始", "起止", "结束", "实记", "预计止", "经期" -> rose
                        "易孕" -> mint
                        "排卵" -> lilac
                        else -> paper
                    }
                    column().apply {
                        gravity = Gravity.CENTER
                        val shape = box(fill, 12)
                        if (day == selected) shape.setStroke(dp(2), plum)
                        background = RippleDrawable(ColorStateList.valueOf(0x22694D83), shape, null)
                        addView(label((index + 1).toString(), 16, ink, day == today), wrap, wrap)
                        val sub = mark.ifEmpty { if (day == today) "今天" else "" }
                        if (sub.isNotEmpty()) addView(label(sub, 11, ink), wrap, wrap)
                        contentDescription = "${month}月${index + 1}日" + (if (day == today) "，今天" else "") +
                            when {
                                mark.isEmpty() -> ""
                                mark == "预计止" -> "，预计经期结束"
                                info?.confirmed == true || info?.recorded == true -> "，已记录$mark"
                                else -> "，预计$mark"
                            }
                        isSelected = day == selected
                        isFocusable = true
                        setOnClickListener { select(day) }
                    }
                }
                strip.addView(cell, LinearLayout.LayoutParams(0, dp(49), 1f))
            }
            calendar.addView(strip)
        }
        calendar.addView(label("“预计止”是预计的最后一天。记录实际结束后，整段经期会标为实记。", 13, muted).apply {
            setPadding(dp(6), dp(12), dp(6), 0)
        })
        val detail = card().apply { setPadding(dp(16), dp(14), dp(16), dp(14)) }
        val info = cycle.on(selected)
        val title = "${month}月${date.get(Calendar.DAY_OF_MONTH)}日"
        detail.addView(label(title + (info?.let { "  ·  周期第 ${it.position} 天" } ?: ""), 18, ink, true))
        val description = if (info == null) {
            if (cycle.starts.isEmpty()) "点选最近一次月经开始的日期，记下第一天后即可查看预测。" else "这一天早于最早的经期记录。"
        } else listOfNotNull(
            when {
                info.confirmed -> "实记经期 · ${dateText(info.anchor)}至${dateText(info.actualEnd!!)}，共 ${info.actualEnd - info.anchor + 1} 天"
                info.recorded -> "已记录经期开始"
                info.period -> "预计经期"
                else -> null
            },
            if (info.period) info.predictedEnd?.let { "预计 ${dateText(it)} 结束" } else null,
            info.phase?.let { "预计$it" } ?: "此时段不显示排卵估算",
            if (info.fertile) "预计易孕窗" else null
        ).joinToString(" · ")
        detail.addView(label(description, 15, muted).apply { setPadding(0, dp(6), 0, dp(12)) })
        if (selected <= today) {
            if (selected in cycle.starts) detail.addView(action("撤销这次开始记录", lilac) {
                AlertDialog.Builder(this).setMessage("撤销 ${title} 开始的整次经期记录？")
                    .setNegativeButton("取消", null).setPositiveButton("撤销") { _, _ -> mark(false) }.show()
            }) else if (info?.confirmed != true) detail.addView(action("记为经期第一天", lilac) { mark(true) })
            if (info != null) {
                if (info.actualEnd == selected) {
                    detail.addView(action("撤销实际结束日", paper) { setEnd(info.anchor, null) })
                } else {
                    val verb = if (info.actualEnd == null) "记为" else "改为"
                    detail.addView(action("${verb}${dateText(info.anchor)}这次经期的结束日", paper) {
                        setEnd(info.anchor, selected)
                    })
                }
            }
        }
        content.addView(label("周期 ${cycle.length} 天  ·  预计经期 ${cycle.duration} 天", 14, ink, true))
        content.addView(label("日期仅按记录推算，周期不规律时偏差更大，不能用于避孕。记录仅保存在本机。", 13, muted).apply { setPadding(0, dp(4), 0, 0) })
    }
    private fun settings() {
        val cycle = model()
        val form = column().apply { setPadding(dp(24), dp(12), dp(24), 0) }
        val wheels = LinearLayout(this)
        form.addView(wheels)
        fun wheel(title: String, min: Int, max: Int, current: Int): NumberPicker {
            val group = column().apply { gravity = Gravity.CENTER_HORIZONTAL }
            wheels.addView(group, LinearLayout.LayoutParams(0, wrap, 1f))
            val picker = NumberPicker(this).apply {
                id = View.generateViewId()
                minValue = min
                maxValue = max
                value = current
                wrapSelectorWheel = false
                descendantFocusability = NumberPicker.FOCUS_BLOCK_DESCENDANTS
            }
            group.addView(label(title, 15).apply { labelFor = picker.id })
            group.addView(picker, match, wrap)
            return picker
        }
        val length = wheel("周期间隔（天）", 2, 365, cycle.length)
        val duration = wheel("预计经期（天）", 1, cycle.length - 1, cycle.duration)
        length.setOnValueChangedListener { _, _, span -> duration.maxValue = span - 1 }
        form.addView(label("间隔从一次开始日算到下次开始日。预计天数只用于预测。", 13, muted))
        AlertDialog.Builder(this).setTitle("周期设置").setView(ScrollView(this).apply { addView(form) })
            .setNegativeButton("取消", null).setPositiveButton("保存") { _, _ ->
                prefs.edit().putInt("length", length.value).putInt("duration", duration.value).apply()
                render()
            }.show()
    }
}

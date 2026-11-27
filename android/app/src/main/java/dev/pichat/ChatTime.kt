package dev.pichat

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs

internal class ChatTime(private val now: Long, private val zone: TimeZone = TimeZone.getDefault()) {
    private fun format(pattern: String) = SimpleDateFormat(pattern, Locale.CHINA).apply { timeZone = zone }
    private val day = format("yyyyMMdd")
    private val clock = format("HH:mm")
    private val date = format("M月d日")
    private val fullDate = format("yyyy年M月d日")
    private val today = day.format(Date(now))

    fun label(previous: Long, current: Long): String? {
        if (current <= 0) return null
        val instant = Date(current)
        val key = day.format(instant)
        if (previous > 0 && day.format(Date(previous)) == key) {
            return if (abs(current - previous) >= 300_000L) clock.format(instant) else null
        }
        val calendar = day.calendar.clone() as java.util.Calendar
        calendar.timeInMillis = now
        calendar.add(java.util.Calendar.DATE, -1)
        val prefix = when (key) {
            today -> "今天 · "
            day.format(calendar.time) -> "昨天 · "
            else -> ""
        }
        val formatter = if (key.take(4) == today.take(4)) date else fullDate
        return prefix + formatter.format(instant) + "  " + clock.format(instant)
    }
}

package dev.pichat

import java.util.Calendar
import java.util.GregorianCalendar
import java.util.TimeZone

// Day arithmetic uses civil dates; local midnight and DST never change the length of a cycle.
internal object CivilDay {
    private const val DAY_MS = 86_400_000L
    private fun utc() = GregorianCalendar(TimeZone.getTimeZone("UTC"))
    fun of(year: Int, month: Int, date: Int): Int = utc().run {
        clear()
        set(year, month - 1, date)
        (timeInMillis / DAY_MS).toInt()
    }
    fun today(): Int = Calendar.getInstance().run { of(get(Calendar.YEAR), get(Calendar.MONTH) + 1, get(Calendar.DATE)) }
    fun calendar(day: Int) = utc().apply { timeInMillis = day * DAY_MS }
    fun first(day: Int) = day - calendar(day).get(Calendar.DAY_OF_MONTH) + 1
    fun shiftMonth(day: Int, months: Int): Int = calendar(day).run {
        add(Calendar.MONTH, months)
        (timeInMillis / DAY_MS).toInt()
    }
}

internal data class CycleDay(val position: Int, val recorded: Boolean, val period: Boolean,
                             val ovulation: Boolean, val fertile: Boolean, val phase: String?,
                             val anchor: Int, val actualEnd: Int?, val confirmed: Boolean,
                             val predictedEnd: Int?)

internal class CycleCalendar(val starts: Set<Int>, val length: Int, val duration: Int,
                             val ends: Map<Int, Int> = emptyMap()) {
    fun on(day: Int): CycleDay? {
        val anchor = starts.filter { it <= day }.maxOrNull() ?: return null
        val next = starts.filter { it > day }.minOrNull()
        val elapsed = day - anchor
        // A recorded next start closes the interval. Never invent intervening periods.
        val end = ends[anchor]
        val projectedStart = day - elapsed % length
        val start = if (next != null || (end != null && projectedStart <= end)) anchor else projectedStart
        val index = day - start
        val confirmed = end != null && day <= end
        val predictedEnd = if (start == anchor && end != null) null
            else minOf(start + duration - 1, next?.minus(1) ?: Int.MAX_VALUE)
        val period = confirmed || (predictedEnd != null && day <= predictedEnd)
        val span = next?.minus(anchor) ?: length
        val ovulationIndex = span - 15 // cycle day (length - 14), with day one at index zero
        val estimate = span in 21..35 && index < span
        val phase = when {
            !estimate -> null
            index < ovulationIndex -> "卵泡期"
            index == ovulationIndex -> "排卵日"
            else -> "黄体期"
        }
        return CycleDay(index + 1, day == anchor, period,
            estimate && index == ovulationIndex, estimate && index in ovulationIndex - 5..ovulationIndex + 1, phase, anchor, end, confirmed, predictedEnd)
    }
}

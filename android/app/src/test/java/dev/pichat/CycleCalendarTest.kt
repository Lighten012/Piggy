package dev.pichat

import org.junit.Assert.*
import org.junit.Test

class CycleCalendarTest {
    private val first = CivilDay.of(2024, 2, 25)
    @Test fun predictionsAcrossLeapDayAndMonths() {
        val model = CycleCalendar(setOf(first), 28, 5)
        assertNull(model.on(first - 1))
        assertTrue(model.on(first)!!.recorded)
        assertTrue(model.on(CivilDay.of(2024, 2, 29))!!.period)
        assertFalse(model.on(CivilDay.of(2024, 3, 1))!!.period)
        assertFalse(model.on(first + 7)!!.fertile)
        assertTrue(model.on(first + 8)!!.fertile)
        assertTrue(model.on(first + 13)!!.ovulation)
        assertTrue(model.on(first + 14)!!.fertile)
        assertFalse(model.on(first + 15)!!.fertile)
        assertEquals("黄体期", model.on(first + 15)!!.phase)
        assertTrue(model.on(first + 28)!!.period)
        assertFalse(model.on(first + 28)!!.recorded)
        assertEquals(CivilDay.of(2024, 2, 29), CivilDay.shiftMonth(CivilDay.of(2024, 1, 31), 1))
    }
    @Test fun laterRecordsReplaceProjectionsAndSettingsChangeFutureDates() {
        val model = CycleCalendar(setOf(first, first + 32), 30, 4)
        assertTrue(model.on(first + 17)!!.ovulation)
        assertFalse(model.on(first + 30)!!.period)
        assertTrue(model.on(first + 32)!!.recorded)
        assertFalse(model.on(first + 36)!!.period)
        assertTrue(model.on(first + 47)!!.ovulation)
        assertTrue(model.on(first + 62)!!.period)
        assertNull(CycleCalendar(emptySet(), 28, 5).on(first))
        assertNull(CycleCalendar(setOf(first), 42, 5).on(first + 27)!!.phase)
    }

    @Test fun actualEndOverridesOnlyItsOwnPeriod() {
        for (days in listOf(1, 3, 8)) {
            val end = first + days - 1
            val model = CycleCalendar(setOf(first), 28, 5, mapOf(first to end))
            for (offset in 0 until days) assertTrue(model.on(first + offset)!!.confirmed)
            assertFalse(model.on(end + 1)!!.period)
            assertNull(model.on(first)!!.predictedEnd)
            assertEquals(first + 32, model.on(first + 28)!!.predictedEnd)
            assertFalse(model.on(first + 28)!!.confirmed)
        }
        val old = CycleCalendar(setOf(first), 28, 5)
        assertEquals(first + 4, old.on(first)!!.predictedEnd)
        val revised = CycleCalendar(setOf(first, first + 30), 28, 7, mapOf(first to first + 3))
        assertFalse(revised.on(first + 4)!!.period)
        assertEquals(first + 36, revised.on(first + 30)!!.predictedEnd)
    }
    @Test fun extendedPeriodTakesPrecedenceOverProjectedStart() {
        val model = CycleCalendar(setOf(first), 21, 5, mapOf(first to first + 22))
        assertEquals(23, model.on(first + 22)!!.position)
        assertTrue(model.on(first + 22)!!.confirmed)
        assertFalse(model.on(first + 23)!!.period)
        assertTrue(model.on(first + 42)!!.period)
    }
}

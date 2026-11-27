package dev.pichat

import java.time.Instant
import java.util.TimeZone
import org.junit.Assert.*
import org.junit.Test

class ChatTimeTest {
    private val start = Instant.parse("2026-11-26T15:55:00Z").toEpochMilli()
    private val clock = ChatTime(start + 300_000, TimeZone.getTimeZone("Asia/Shanghai"))

    @Test fun adjacentMessagesAndMidnight() {
        assertEquals("昨天 · 11月26日  23:55", clock.label(0, start))
        assertNull(clock.label(start, start + 299_999))
        assertEquals("今天 · 11月27日  00:00", clock.label(start + 299_999, start + 300_000))
        val morning = start + 9 * 3_600_000
        assertNull(clock.label(morning, morning + 240_000))
        assertNull(clock.label(morning + 240_000, morning + 480_000))
        assertEquals("09:04", clock.label(morning + 240_000, morning + 540_000))
        assertNull(clock.label(morning, 0))
    }
}

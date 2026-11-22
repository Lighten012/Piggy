package dev.pichat

import org.junit.Assert.assertEquals
import org.junit.Test

class ReplyPositionsTest {
    @Test fun legacyOrdinalCaptionsAndUnassignedFiles() {
        val text = "第一张裁切图\n\n第二张裁切图"
        assertEquals(listOf(6, text.length), replyPositions(text, listOf(-1, -1)))
        assertEquals(listOf(2, 2), replyPositions("完成", listOf(-1, -1)))
    }
    @Test fun serverOffsetsSurviveEmojiAndMixedFiles() {
        val text = "🐷第一份\n文字\n第二份\n完"
        assertEquals(listOf(5, 12, text.length), replyPositions(text, listOf(5, 12, -1)))
    }
}

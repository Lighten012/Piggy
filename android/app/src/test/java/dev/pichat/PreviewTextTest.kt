package dev.pichat

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PreviewTextTest {
    private fun read(bytes: ByteArray): List<String> {
        val file = File.createTempFile("piggy-text", ".txt")
        return try {
            file.writeBytes(bytes)
            readTextPages(file)
        } finally { file.delete() }
    }

    @Test fun decodesCommonChineseDocumentEncodings() {
        val sample = "中文预览"
        assertEquals(listOf(sample), read(("\uFEFF" + sample).toByteArray()))
        assertEquals(listOf(sample), read(("\uFEFF" + sample).toByteArray(Charsets.UTF_16LE)))
        assertEquals(listOf(sample), read(sample.toByteArray(charset("GB18030"))))
    }

    @Test fun longLinesPreserveSurrogatePairsAtPageBoundaries() {
        val original = "字".repeat(23999) + "🐷" + "末".repeat(30000)
        val pages = read(original.toByteArray())
        assertTrue(pages.size > 1)
        assertEquals(original, pages.joinToString(""))
        assertTrue(pages.none { Character.isHighSurrogate(it.last()) })
    }
}

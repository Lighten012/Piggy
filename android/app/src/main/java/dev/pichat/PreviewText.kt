package dev.pichat

import java.io.File

internal fun readTextPages(file: File): List<String> {
    val bom = file.inputStream().use { it.read() to it.read() }
    val charset =
        when (bom) {
            255 to 254 -> Charsets.UTF_16LE
            254 to 255 -> Charsets.UTF_16BE
            else -> Charsets.UTF_8
        }
    fun read(encoding: java.nio.charset.Charset): List<String> {
        val result = ArrayList<String>()
        file.inputStream().use { input ->
            val reader = java.io.InputStreamReader(input, encoding.newDecoder())
            val chars = CharArray(4096)
            val page = StringBuilder()
            while (true) {
                val n = reader.read(chars)
                if (n < 0) break
                page.append(chars, 0, n)
                if (result.isEmpty() && page.startsWith("\uFEFF")) page.deleteCharAt(0)
                if (page.length >= 24000) {
                    val newline = page.lastIndexOf("\n", 23999)
                    var end = if (newline > 12000) newline + 1 else 24000
                    if (Character.isHighSurrogate(page[end - 1])) end--
                    result.add(page.substring(0, end))
                    page.delete(0, end)
                }
            }
            if (page.isNotEmpty()) result.add(page.toString())
        }
        return result.ifEmpty { listOf("（空文件）") }
    }
    return try {
        read(charset)
    } catch (error: java.nio.charset.CharacterCodingException) {
        if (charset != Charsets.UTF_8) throw error
        read(charset("GB18030"))
    }
}

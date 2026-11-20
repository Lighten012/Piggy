package dev.pichat

import android.content.Context
import android.net.Uri
import android.webkit.MimeTypeMap
import org.json.JSONObject
import java.io.DataInputStream
import java.io.EOFException

internal class AttachmentFormats(private val context: Context) {
    private val types = context.assets.open("attachment-types.json").bufferedReader().use { JSONObject(it.readText()) }
    private val byExtension = buildMap {
        for (mime in types.keys()) for (ext in types.getString(mime).split(" ")) put(ext, mime)
    }
    val pickerTypes = (types.keys().asSequence().toList() + byExtension.keys.mapNotNull {
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(it)
    }.filterNot { it.startsWith("video/") || it.startsWith("audio/") } + "application/octet-stream").distinct().toTypedArray()

    fun validate(name: String, reported: String?, uri: Uri): String {
        val mime = reported.orEmpty().substringBefore(';').trim().lowercase()
        val lower = name.trim().lowercase()
        val type = byExtension[lower.substringAfterLast('.')]
            ?: mime.takeIf { '.' !in lower && types.has(it) }
        require(type != null && !mime.startsWith("video/") && !mime.startsWith("audio/") &&
            (!mime.startsWith("image/") || mime == type || (mime == "image/jpg" && type == "image/jpeg"))) { "暂不支持 $name" }
        if (type == "image/gif") {
            val single = context.contentResolver.openInputStream(uri)?.use {
                try { staticGif(DataInputStream(it.buffered())) } catch (_: EOFException) { false }
            }
            require(single == true) { "$name 需要是有效的静态 GIF" }
        }
        return type
    }

    private fun staticGif(input: DataInputStream): Boolean {
        var consumed = 0
        fun byte(): Int {
            require(++consumed <= 10 * 1024 * 1024) { "每个附件最多 10 MB" }
            return input.readUnsignedByte()
        }
        fun skip(count: Int) {
            consumed += count
            require(consumed <= 10 * 1024 * 1024) { "每个附件最多 10 MB" }
            var left = count
            while (left > 0) {
                val n = input.skipBytes(left)
                if (n == 0) { input.readUnsignedByte(); left-- } else left -= n
            }
        }
        fun table(flags: Int) = if (flags and 128 != 0) 3 * (2 shl (flags and 7)) else 0
        val signature = String(ByteArray(6) { byte().toByte() }, Charsets.US_ASCII)
        if (signature != "GIF87a" && signature != "GIF89a") return false
        skip(4)
        skip(2 + table(byte()))
        var frames = 0
        while (true) {
            when (byte()) {
                0x3b -> return frames == 1
                0x2c -> {
                    if (++frames > 1) return false
                    skip(8)
                    skip(1 + table(byte()))
                }
                0x21 -> skip(1)
                else -> return false
            }
            var length = byte()
            while (length > 0) { skip(length); length = byte() }
        }
    }
}

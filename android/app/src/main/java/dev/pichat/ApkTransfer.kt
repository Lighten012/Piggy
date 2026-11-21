package dev.pichat

import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

internal data class EngineRegion(val offset: Long, val size: Long, val sha256: String) {
    fun fits(apkSize: Long) = offset > 0 && size > 0 && size < apkSize - offset &&
        sha256.matches(Regex("[0-9a-f]{64}"))
}

internal fun sha256(input: InputStream): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(32 * 1024)
    while (true) {
        val n = input.read(buf)
        if (n < 0) break
        digest.update(buf, 0, n)
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

// All offsets refer to the final signed APK, including its ZIP headers and signing block.
internal fun downloadApk(
    temp: File,
    size: Long,
    region: EngineRegion?,
    openEngine: () -> InputStream,
    fetch: (LongRange?, OutputStream) -> Unit,
    verify: (File) -> Unit,
    closed: () -> Boolean,
) {
    fun checkReady() {
        check(!closed()) { "更新下载已中断" }
        check(temp.usableSpace >= size - temp.length()) { "手机存储空间不足，无法准备更新" }
    }
    checkReady()
    if (region != null && region.fits(size)) {
        try {
            if (openEngine().use(::sha256) == region.sha256) {
                temp.outputStream().buffered().use { out ->
                    fetch(0L until region.offset, out)
                    openEngine().use { engine -> check(engine.copyTo(out, 32 * 1024) == region.size) }
                    fetch((region.offset + region.size) until size, out)
                }
                verify(temp)
                return
            }
        } catch (e: Exception) {
            // Unsupported ranges, stale assets or invalid reconstruction: retry once in full.
            checkReady()
        }
    }
    temp.outputStream().buffered().use { fetch(null, it) }
    verify(temp)
}

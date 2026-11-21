package dev.pichat

import java.io.File
import java.io.IOException
import org.junit.Assert.*
import org.junit.Test

class ApkTransferTest {
    private val apk = "beforeENGINEafter".toByteArray()
    private val engine = "ENGINE".toByteArray()
    private val region = EngineRegion(6, 6, engine.inputStream().use(::sha256))

    private fun transfer(meta: EngineRegion?, local: ByteArray = engine, badRange: String = ""): List<LongRange?> {
        val requests = mutableListOf<LongRange?>()
        val temp = File.createTempFile("update", ".apk")
        try {
            downloadApk(temp, apk.size.toLong(), meta, { local.inputStream() }, { range, out ->
                requests.add(range)
                if (range == null) out.write(apk) else {
                    if (badRange == "unsupported") throw IOException("200 instead of 206")
                    val bytes = apk.copyOfRange(range.first.toInt(), range.last.toInt() + 1)
                    if (badRange == "corrupt") bytes[0] = 0
                    out.write(bytes)
                }
            }, { check(it.readBytes().contentEquals(apk)) }, { false })
            assertArrayEquals(apk, temp.readBytes())
            return requests
        } finally { temp.delete() }
    }

    @Test fun copiesOnlyTwoRanges() {
        assertEquals(listOf(0L..5L, 12L..16L), transfer(region))
    }

    @Test fun fullWhenMissingOrDifferentEngine() {
        for (meta in listOf(null, region.copy(offset = Long.MAX_VALUE))) {
            assertEquals(listOf(null), transfer(meta))
        }
        assertEquals(listOf(null), transfer(region, "changed".toByteArray()))
    }

    @Test fun rejectsBrokenReconstructionAndRetriesInFull() {
        assertEquals(listOf(0L..5L, null), transfer(region, badRange = "unsupported"))
        assertEquals(listOf(0L..5L, 12L..16L, null), transfer(region, badRange = "corrupt"))
    }
}

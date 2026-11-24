package dev.pichat

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.net.URL
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

object PiggyServer {
    val ORIGIN = BuildConfig.SERVER_ORIGIN
    fun url(path: String) = URL(ORIGIN + path)

    private var key: String? = null
    @Synchronized private fun installation(context: Context): String {
        key?.let { return it }
        val file = AtomicFile(File(context.noBackupFilesDir, "piggy-installation"))
        val value = try {
            file.openRead().bufferedReader().use { UUID.fromString(it.readText()).toString() }
        } catch (_: java.io.FileNotFoundException) {
            val id = UUID.randomUUID().toString()
            val stream = file.startWrite()
            try {
                stream.write(id.toByteArray(Charsets.US_ASCII))
                file.finishWrite(stream)
            } catch (e: Exception) {
                file.failWrite(stream)
                throw e
            }
            id
        }
        key = value
        return value
    }

    fun mobile(context: Context, url: URL): HttpsURLConnection {
        require(url.protocol == "https" && url.authority == URL(ORIGIN).authority && url.path.startsWith("/mobile/"))
        return (url.openConnection() as HttpsURLConnection).apply {
            instanceFollowRedirects = false
            setRequestProperty("X-Piggy-Version-Code", BuildConfig.VERSION_CODE.toString())
            setRequestProperty("X-Piggy-Installation", installation(context))
            setRequestProperty("X-Piggy-Session", CycleSync.session(context))
        }
    }

    class Occupied : Exception()
    fun connect(context: Context) {
        val http = mobile(context, url("/mobile/connect"))
        try {
            http.connectTimeout = 10000
            http.readTimeout = 10000
            http.requestMethod = "POST"
            when (val status = http.responseCode) {
                204 -> return
                403 -> throw Occupied()
                else -> error("连接 Piggy 服务失败（HTTP $status）")
            }
        } finally { http.disconnect() }
    }
}

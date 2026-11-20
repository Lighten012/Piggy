package dev.pichat

import android.app.Activity
import org.json.JSONObject
import java.io.IOException
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

class PiggyClient(private val activity: Activity) {
    private val worker = Executors.newSingleThreadExecutor()
    private val endpoint = URL("https://38.14.232.112:8888/mobile/chat")
    @Volatile private var closed = false
    @Volatile private var connection: HttpsURLConnection? = null
    private var session: String? = null

    fun reset() { session = null }

    private fun ui(action: () -> Unit) = activity.runOnUiThread { if (!closed) action() }

    private fun post(data: JSONObject, consume: (HttpsURLConnection) -> Unit) {
        val http = endpoint.openConnection() as HttpsURLConnection
        connection = http
        try {
            if (closed) throw IOException("连接已关闭")
            http.requestMethod = "POST"
            http.instanceFollowRedirects = false
            http.connectTimeout = 15000
            http.readTimeout = 120000
            http.doOutput = true
            http.setRequestProperty("Content-Type", "application/json")
            http.outputStream.use { it.write(data.toString().toByteArray(Charsets.UTF_8)) }
            val status = http.responseCode
            if (status !in 200..299) {
                if (status == 410) session = null
                val detail = http.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val message = runCatching { JSONObject(detail).getString("error") }.getOrNull()
                throw IOException(message ?: "服务器返回 HTTP $status")
            }
            consume(http)
        } finally {
            http.disconnect()
            connection = null
        }
    }

    fun send(text: String, delta: (String) -> Unit, finished: (String?) -> Unit) = worker.execute {
        val failure = runCatching {
            post(JSONObject().put("text", text).put("session", session)) { http ->
                var next: String? = null
                http.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                    for (line in lines) {
                        if (closed) throw IOException("连接已关闭")
                        if (line.isBlank()) continue
                        val event = JSONObject(line)
                        if (event.has("error")) throw IOException(event.getString("error"))
                        if (event.has("delta")) {
                            val part = event.getString("delta")
                            ui { delta(part) }
                        }
                        if (event.optBoolean("done")) next = event.getString("session")
                    }
                }
                session = next ?: throw IOException("回复中断，请重试")
            }
        }.exceptionOrNull()
        ui { finished(failure?.localizedMessage) }
    }

    fun close() {
        closed = true
        connection?.disconnect()
        worker.shutdownNow()
    }
}

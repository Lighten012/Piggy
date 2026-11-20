package dev.pichat

import android.app.Activity
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.io.IOException
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

class PiggyClient(private val activity: Activity) {
    private val worker = Executors.newSingleThreadExecutor()
    private val endpoint = PiggyServer.url(activity, "/mobile/chat")
    @Volatile private var closed = false
    @Volatile private var connection: HttpsURLConnection? = null
    private val prefs = activity.getSharedPreferences("conversation", Activity.MODE_PRIVATE)
    private val session = prefs.getString("session", null) ?: UUID.randomUUID().toString().also {
        prefs.edit().putString("session", it).commit()
    }
    val recent: JSONArray get() = JSONArray(prefs.getString("recent", "[]"))
    val draft: String get() = prefs.getString("pendingText", "").orEmpty()

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
                if (status == 422) prefs.edit().remove("pendingId").commit()
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
            val previousId = prefs.getString("pendingId", null)
            val id = if (draft == text && previousId != null) previousId else UUID.randomUUID().toString()
            check(prefs.edit().putString("pendingText", text).putString("pendingId", id).commit()) { "无法保存待发送消息" }
            post(JSONObject().put("text", text).put("session", session).put("request", id)) { http ->
                var done = false
                val answer = StringBuilder()
                http.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                    for (line in lines) {
                        if (closed) throw IOException("连接已关闭")
                        if (line.isBlank()) continue
                        val event = JSONObject(line)
                        if (event.has("error")) {
                            prefs.edit().remove("pendingId").commit()
                            throw IOException(event.getString("error"))
                        }
                        if (event.has("delta")) {
                            val part = event.getString("delta")
                            answer.append(part)
                            ui { delta(part) }
                        }
                        if (event.optBoolean("done")) done = true
                    }
                }
                if (!done) throw IOException("回复中断，请重试")
                val saved = recent
                saved.put(JSONObject().put("text", text).put("answer", answer.toString()))
                while (saved.length() > 40) saved.remove(0)
                check(prefs.edit().putString("recent", saved.toString()).remove("pendingText")
                    .remove("pendingId").commit()) { "无法保存回复，请重试" }
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

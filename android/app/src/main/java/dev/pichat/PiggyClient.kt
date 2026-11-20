package dev.pichat

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.text.format.Formatter
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.io.IOException
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

class PiggyClient(private val activity: Activity, private val outdated: () -> Unit) {
    private val worker = Executors.newSingleThreadExecutor()
    private val endpoint = PiggyServer.url("/mobile/chat")
    @Volatile private var closed = false
    @Volatile private var connection: HttpsURLConnection? = null
    private val prefs = activity.getSharedPreferences("conversation", Activity.MODE_PRIVATE)
    private val session = prefs.getString("session", null) ?: UUID.randomUUID().toString().also {
        prefs.edit().putString("session", it).commit()
    }
    val recent: JSONArray get() = JSONArray(prefs.getString("recent", "[]"))
    val draft: String get() = prefs.getString("pendingText", "").orEmpty()

    val attachment: JSONObject? get() = prefs.getString("file", null)?.let { JSONObject(it) }

    fun fileLabel(file: JSONObject): String {
        val size = file.optLong("size", -1)
        return file.getString("name") + if (size >= 0) " · " + Formatter.formatFileSize(activity, size) else ""
    }

    fun chooseFile(uri: Uri) {
        val resolver = activity.contentResolver
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "附件"
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
            if (it.moveToFirst()) {
                if (!it.isNull(0)) name = it.getString(0)
                if (!it.isNull(1)) size = it.getLong(1)
            }
        }
        require(size <= 10L * 1024 * 1024) { "每个附件最多 10 MB" }
        val mime = resolver.getType(uri) ?: "application/octet-stream"
        resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val previous = attachment
        val file = JSONObject().put("id", UUID.randomUUID().toString()).put("uri",uri.toString())
            .put("name",name).put("size",size).put("mime",mime)
        check(prefs.edit().putString("file", file.toString()).remove("pendingId").commit())
        if (previous?.optString("uri") != uri.toString()) releaseFile(previous)
    }

    private fun releaseFile(file: JSONObject?) {
        val uri = file?.optString("uri") ?: return
        if (attachment?.optString("uri") == uri) return
        val history = recent
        if ((0 until history.length()).any { history.getJSONObject(it).optJSONObject("file")?.optString("uri") == uri }) return
        runCatching { activity.contentResolver.releasePersistableUriPermission(
            Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    fun removeFile() {
        val previous = attachment
        prefs.edit().remove("file").remove("pendingId").commit()
        releaseFile(previous)
    }

    private fun ui(action: () -> Unit) = activity.runOnUiThread { if (!closed) action() }

    private fun post(url: URL, write: (HttpsURLConnection) -> Unit, consume: (HttpsURLConnection) -> Unit) {
        val http = url.openConnection() as HttpsURLConnection
        connection = http
        try {
            if (closed) throw IOException("连接已关闭")
            http.requestMethod = "POST"
            http.instanceFollowRedirects = false
            http.connectTimeout = 15000
            http.readTimeout = 120000
            http.doOutput = true
            http.setRequestProperty("X-Piggy-Version-Code", BuildConfig.VERSION_CODE.toString())
            write(http)
            val status = http.responseCode
            if (status !in 200..299) {
                if (status == 426) ui(outdated)
                if (status == 422) prefs.edit().remove("pendingId").commit()
                val detail = http.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val message = runCatching { JSONObject(detail).getString("error") }.getOrNull()
                throw IOException(message ?: if (status == 413) "每个附件最多 10 MB" else "服务器返回 HTTP $status")
            }
            consume(http)
        } finally {
            http.disconnect()
            connection = null
        }
    }

    private fun upload(file: JSONObject) {
        post(PiggyServer.url("/mobile/attachments"), { http ->
            val name = Base64.encodeToString(file.getString("name").toByteArray(Charsets.UTF_8),
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            http.setRequestProperty("X-Piggy-Filename", name)
            http.setRequestProperty("X-Piggy-Session", session)
            http.setRequestProperty("X-Piggy-Attachment", file.getString("id"))
            http.setRequestProperty("Content-Type", file.getString("mime"))
            val size = file.getLong("size")
            if (size >= 0) http.setFixedLengthStreamingMode(size) else http.setChunkedStreamingMode(32768)
            val uri = Uri.parse(file.getString("uri"))
            val input = activity.contentResolver.openInputStream(uri) ?: throw IOException("无法读取所选文件")
            input.use { source -> http.outputStream.use { source.copyTo(it, 32768) } }
        }) { http ->
            val result = JSONObject(http.inputStream.bufferedReader().use { it.readText() })
            check(result.getString("id") == file.getString("id")) { "附件确认失败" }
            file.put("uploaded",true).put("size",result.getLong("size"))
            check(prefs.edit().putString("file",file.toString()).commit())
        }
    }

    fun send(text: String, uploaded: () -> Unit, delta: (String) -> Unit, finished: (String?) -> Unit) = worker.execute {
        val failure = runCatching {
            val previousId = prefs.getString("pendingId", null)
            val id = if (draft == text && previousId != null) previousId else UUID.randomUUID().toString()
            check(prefs.edit().putString("pendingText", text).putString("pendingId", id).commit()) { "无法保存待发送消息" }
            val file = attachment
            if (file != null && !file.optBoolean("uploaded")) upload(file)
            ui(uploaded)
            val data = JSONObject().put("text",text).put("session",session).put("request",id)
            if (file != null) data.put("attachment",file.getString("id"))
            post(endpoint, { http ->
                http.setRequestProperty("Content-Type","application/json")
                http.outputStream.use { it.write(data.toString().toByteArray(Charsets.UTF_8)) }
            }) { http ->
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
                val turn = JSONObject().put("text", text).put("answer", answer.toString())
                if (file != null) {
                    turn.put("filename",fileLabel(file))
                    ImagePreviews.save(activity, file)
                    turn.put("file", file)
                }
                saved.put(turn)
                val evicted = if (saved.length() > 40) saved.remove(0) as? JSONObject else null
                check(prefs.edit().putString("recent", saved.toString()).remove("pendingText")
                    .remove("pendingId").remove("file").commit()) { "无法保存回复，请重试" }
                val oldFile = evicted?.optJSONObject("file")
                ImagePreviews.discard(activity, oldFile?.optString("id"))
                releaseFile(oldFile)
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

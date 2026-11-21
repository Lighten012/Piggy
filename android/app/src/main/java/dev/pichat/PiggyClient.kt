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
    val draft: String get() = prefs.getString("pendingDraft", prefs.getString("pendingText", "")).orEmpty()

    companion object {
        const val MAX_FILES = 4
        private fun objects(array: JSONArray) = List(array.length()) { array.getJSONObject(it) }
        fun turnFiles(turn: JSONObject): List<JSONObject> =
            turn.optJSONArray("files")?.let(::objects) ?: listOfNotNull(turn.optJSONObject("file"))
    }

    val attachments: List<JSONObject> get() = prefs.getString("files", null)?.let { objects(JSONArray(it)) }
        ?: listOfNotNull(prefs.getString("file", null)?.let(::JSONObject))

    fun sizeLabel(file: JSONObject): String {
        val size = file.optLong("size", -1)
        return if (size >= 0) Formatter.formatFileSize(activity, size) else ""
    }

    internal val formats = AttachmentFormats(activity)

    fun chooseFiles(uris: List<Uri>, finished: (String?) -> Unit) = worker.execute {
        val result = runCatching { addSelection(uris) }
        ui { finished(result.fold({ it }, { it.localizedMessage ?: "无法读取文件" })) }
    }

    private fun addSelection(uris: List<Uri>): String? {
        val current = attachments
        val added = uris.distinct().filter { uri -> current.none { it.getString("uri") == uri.toString() } }
        if (added.isEmpty()) return null
        val rejected = mutableListOf<String>()
        val resolver = activity.contentResolver
        val files = added.mapNotNull { uri ->
            var name = uri.lastPathSegment?.substringAfterLast('/') ?: "附件"
            var size = -1L
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
                if (it.moveToFirst()) {
                    if (!it.isNull(0)) name = it.getString(0)
                    if (!it.isNull(1)) size = it.getLong(1)
                }
            }
            val type = try {
                require(size != 0L) { "$name 是空文件" }
                require(size <= 10L * 1024 * 1024) { "$name 超过 10 MB" }
                formats.validate(name, resolver.getType(uri), uri)
            } catch (e: IllegalArgumentException) {
                rejected += e.message ?: "暂不支持 $name"
                return@mapNotNull null
            }
            JSONObject().put("id", UUID.randomUUID().toString()).put("uri",uri.toString())
                .put("name",name).put("size",size).put("mime",type)
        }
        try {
            require(current.size + files.size <= MAX_FILES) { "每条消息最多可添加 4 个附件" }
            if (files.isEmpty()) return rejected.joinToString("；")
            files.forEach { resolver.takePersistableUriPermission(Uri.parse(it.getString("uri")), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            persistSelection(current + files)
        } catch (e: Exception) {
            files.forEach(::releaseFile)
            throw e
        }
        return rejected.takeIf { it.isNotEmpty() }?.joinToString("；")
    }

    private fun persistSelection(files: List<JSONObject>) {
        check(prefs.edit().putString("files", JSONArray(files).toString()).remove("file").remove("pendingId").commit())
    }

    private fun releaseFile(file: JSONObject) {
        val uri = file.getString("uri")
        if (attachments.any { it.getString("uri") == uri }) return
        val history = recent
        if ((0 until history.length()).any { i -> turnFiles(history.getJSONObject(i)).any { it.optString("uri") == uri } }) return
        runCatching { activity.contentResolver.releasePersistableUriPermission(
            Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    fun removeFile(file: JSONObject) {
        persistSelection(attachments.filterNot { it.getString("id") == file.getString("id") })
        releaseFile(file)
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

        }
    }

    private fun usage(json: JSONObject): ContextUsage {
        val used = json.getInt("used")
        val limit = json.getInt("limit")
        require(used >= 0 && limit > 0)
        return ContextUsage(used, limit)
    }

    fun readContext(finished: (ContextUsage?) -> Unit) = worker.execute {
        var current: ContextUsage? = null
        runCatching {
            post(PiggyServer.url("/mobile/context"), { http ->
                http.setRequestProperty("Content-Type","application/json")
                http.outputStream.use { it.write(JSONObject().put("session",session).toString().toByteArray()) }
            }) { http ->
                current = usage(JSONObject(http.inputStream.bufferedReader().use { it.readText() }))
            }
        }
        ui { finished(current) }
    }

    fun send(text: String, draftText: String, uploaded: () -> Unit, measured: (ContextUsage) -> Unit, delta: (String) -> Unit, finished: (String?) -> Unit) = worker.execute {
        val failure = runCatching {
            val previousId = prefs.getString("pendingId", null)
            val id = if (prefs.getString("pendingText", null) == text && previousId != null) previousId else UUID.randomUUID().toString()
            check(prefs.edit().putString("pendingText", text).putString("pendingDraft",draftText).putString("pendingId", id).commit()) { "无法保存待发送消息" }
            val files = attachments
            // Check restored drafts from older releases before uploading any part of a group.
            for (file in files) {
                val uri = Uri.parse(file.getString("uri"))
                file.put("mime", formats.validate(file.getString("name"), file.optString("mime"), uri))
            }
            for (file in files) {
                if (file.optBoolean("uploaded")) continue
                upload(file)
                check(prefs.edit().putString("files",JSONArray(files).toString()).remove("file").commit())
            }
            ui(uploaded)
            val data = JSONObject().put("text",text).put("session",session).put("request",id)
            if (files.isNotEmpty()) data.put("attachments",JSONArray(files.map { it.getString("id") }))
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
                        event.optJSONObject("context")?.let {
                            val value = usage(it)
                            ui { measured(value) }
                        }
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
                val turn = JSONObject().put("text", draftText).put("answer", answer.toString())
                if (files.isNotEmpty()) {
                    files.forEach { ImagePreviews.save(activity, it) }
                    turn.put("files", JSONArray(files))
                }
                saved.put(turn)
                val evicted = if (saved.length() > 40) saved.remove(0) as? JSONObject else null
                check(prefs.edit().putString("recent", saved.toString()).remove("pendingText")
                    .remove("pendingId").remove("pendingDraft").remove("file").remove("files").commit()) { "无法保存回复，请重试" }
                if (evicted != null) for (file in turnFiles(evicted)) {
                    ImagePreviews.discard(activity, file.getString("id"))
                    releaseFile(file)
                }
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

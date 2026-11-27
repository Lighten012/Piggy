package dev.pichat

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

class PiggyClient(context: Context, private val outdated: () -> Unit) {
    private val context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val selectionWorker = Executors.newSingleThreadExecutor()
    private val contextWorker = Executors.newSingleThreadExecutor()
    private val endpoint = PiggyServer.url("/mobile/chat")
    @Volatile private var closed = false
    private val connections = ConcurrentHashMap.newKeySet<HttpsURLConnection>()
    private val prefs = context.getSharedPreferences("conversation", Context.MODE_PRIVATE)
    private val session = CycleSync.session(this.context)
    var replyMode: String
        get() = prefs.getString("replyMode", "chat") ?: "chat"
        set(value) { prefs.edit().putString("replyMode", value).apply() }
    private val pendingMode: String get() = prefs.getString("pendingMode", "chat") ?: "chat"
    internal val history = ChatHistory.get(this.context)
    val draft: String get() = prefs.getString("composer", prefs.getString("pendingDraft", "")).orEmpty()
    val pendingDraft: String get() = prefs.getString("pendingDraft", "").orEmpty()
    val pendingSeparate: Boolean get() = prefs.getBoolean("pendingSeparate", false)

    val pendingAttachments: List<JSONObject> get() = objects(JSONArray(prefs.getString("pendingFiles", "[]")))

    init {
        // test.5 kept uploads in the composer slot while waiting for a reply.
        if (pendingSeparate && !prefs.contains("pendingFiles")) {
            check(prefs.edit().putString("pendingFiles", JSONArray(attachments).toString())
                .remove("file").remove("files").commit())
        }
    }

    fun saveDraft(value: String) {
        prefs.edit().putString("composer", value).apply()
    }

    val pendingId: String? get() = prefs.getString("pendingId", null)
    val pendingSentAt: Long get() = prefs.getLong("pendingSentAt", 0L)
    val inFlight: Boolean get() = prefs.getBoolean("sending", false)
    val pendingText: String get() = prefs.getString("pendingText", "").orEmpty()
    fun endFlight() { prefs.edit().remove("sending").commit() }

    fun beginSend(text: String, draft: String, retry: Boolean): Boolean {
        val id = prefs.getString("pendingId", null)?.takeIf { prefs.getString("pendingText", null) == text && (retry || pendingMode == replyMode) }
            ?: UUID.randomUUID().toString()
        val edit = prefs.edit().putString("pendingText", text).putString("pendingDraft", draft)
            .putBoolean("sending", true).putString("pendingId", id).putBoolean("pendingSeparate", true)
        if (id != pendingId) edit.putLong("pendingSentAt", System.currentTimeMillis())
        if (!retry) edit.putString("pendingMode", replyMode).putString("composer", "").putString("pendingFiles", JSONArray(attachments).toString())
            .remove("files").remove("file")
        return edit.commit()
    }

    fun restorePendingIfEmpty() {
        if (!inFlight && pendingSeparate && draft.isEmpty() && attachments.isEmpty()) {
            prefs.edit().putString("composer", pendingDraft).putString("files", JSONArray(pendingAttachments).toString())
                .remove("pendingFiles").remove("pendingSeparate").commit()
        }
    }

    fun dismissPending() {
        val files = pendingAttachments
        prefs.edit().remove("pendingText").remove("pendingDraft").remove("pendingId")
            .remove("pendingSeparate").remove("pendingFiles").commit()
        files.forEach(::releaseFile)
    }

    val lastUsage: ContextUsage? get() {
        val used = prefs.getInt("contextUsed", -1)
        val limit = prefs.getInt("contextLimit", 0)
        return if (used >= 0 && limit > 0) ContextUsage(used, limit) else null
    }

    fun rememberUsage(value: ContextUsage) {
        prefs.edit().putInt("contextUsed", value.used).putInt("contextLimit", value.limit).apply()
    }

    companion object {
        private val historyLock = Any()
        val STICKER_ID = Regex("[0-9a-f]{24}")
        const val MAX_FILES = 4
        private fun objects(array: JSONArray) = List(array.length()) { array.getJSONObject(it) }
        fun turnFiles(turn: JSONObject): List<JSONObject> =
            turn.optJSONArray("files")?.let(::objects) ?: listOfNotNull(turn.optJSONObject("file"))
    }

    fun replyFiles(turn: JSONObject): List<JSONObject> =
        turn.optJSONArray("replyFiles")?.let(::objects).orEmpty().filter { file ->
            file.optString("key").matches(Regex("[0-9]{13}-[a-f0-9-]{36}"))
        }.onEach { file ->
            val key = file.getString("key")
            file.put("id", key).put("uri", PiggyServer.url("/mobile/reply-files/$session/$key").toString())
        }

    val attachments: List<JSONObject> get() = prefs.getString("files", null)?.let { objects(JSONArray(it)) }
        ?: listOfNotNull(prefs.getString("file", null)?.let(::JSONObject))

    fun sizeLabel(file: JSONObject): String {
        val size = file.optLong("size", -1)
        return if (size >= 0) Formatter.formatFileSize(context, size) else ""
    }

    internal val formats = AttachmentFormats(context)

    fun chooseFiles(uris: List<Uri>, finished: (String?) -> Unit) = selectionWorker.execute {
        val result = runCatching { addSelection(uris) }
        ui { finished(result.fold({ it }, { it.localizedMessage ?: "无法读取文件" })) }
    }

    private fun addSelection(uris: List<Uri>): String? {
        val current = attachments
        val added = uris.distinct().filter { uri -> current.none { it.getString("uri") == uri.toString() } }
        if (added.isEmpty()) return null
        val rejected = mutableListOf<String>()
        val resolver = context.contentResolver
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
            synchronized(this) {
                files.forEach { resolver.takePersistableUriPermission(Uri.parse(it.getString("uri")), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                persistSelection(current + files)
            }
        } catch (e: Exception) {
            files.forEach(::releaseFile)
            throw e
        }
        return rejected.takeIf { it.isNotEmpty() }?.joinToString("；")
    }

    private fun persistSelection(files: List<JSONObject>) {
        val edit = prefs.edit().putString("files", JSONArray(files).toString()).remove("file")
        if (!pendingSeparate) edit.remove("pendingId")
        check(edit.commit())
    }

    @Synchronized private fun releaseFile(file: JSONObject) {
        val uri = file.getString("uri")
        if ((attachments + pendingAttachments).any { it.getString("uri") == uri }) return
        if (history.references(uri)) return
        runCatching { context.contentResolver.releasePersistableUriPermission(
            Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    fun removeFile(file: JSONObject) {
        persistSelection(attachments.filterNot { it.getString("id") == file.getString("id") })
        releaseFile(file)
    }

    private fun ui(action: () -> Unit) = main.post { if (!closed) action() }

    @Synchronized
    private fun invalidatePendingRequest() {
        if (!closed) prefs.edit().remove("pendingId").commit()
    }

    private fun post(url: URL, write: (HttpsURLConnection) -> Unit, consume: (HttpsURLConnection) -> Unit) {
        val http = PiggyServer.mobile(context, url)
        connections.add(http)
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
                if (status == 422 && url == endpoint) invalidatePendingRequest()
                val detail = http.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val message = runCatching { JSONObject(detail).getString("error") }.getOrNull()
                throw HttpFailure(status, http.getHeaderField("Retry-After") != null, message ?: "服务器返回 HTTP $status")
            }
            consume(http)
        } finally {
            http.disconnect()
            connections.remove(http)
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
            val input = context.contentResolver.openInputStream(uri) ?: throw IOException("无法读取所选文件")
            input.use { source -> http.outputStream.use { source.copyTo(it, 32768) } }
        }) { http ->
            val result = JSONObject(http.inputStream.bufferedReader().use { it.readText() })
            check(result.getString("id") == file.getString("id")) { "附件确认失败" }
            file.put("uploaded",true).put("size",result.getLong("size"))

        }
    }

    private val inboxWorker = Executors.newSingleThreadExecutor()
    val inboxCursor: Long get() = prefs.getLong("inboxAfter", 0)

    fun syncInbox(finished: (Boolean, Boolean) -> Unit) = inboxWorker.execute {
        var newest: JSONObject? = null
        val failure = runCatching {
            val after = prefs.getLong("inboxAfter", 0)
            val body = JSONObject().put("session", session).put("after", after)
            post(PiggyServer.url("/mobile/inbox"), { http ->
                http.setRequestProperty("Content-Type", "application/json")
                http.outputStream.use { it.write(body.toString().toByteArray()) }
            }) { http ->
                val page = JSONObject(http.inputStream.bufferedReader().use { it.readText() }).getJSONArray("messages")
                synchronized(historyLock) {
                    val cursor = prefs.getLong("inboxAfter", 0)
                    var last = cursor
                    for (turn in objects(page)) {
                        val id = turn.getLong("id")
                        if (id <= last) continue
                        history.append(turn.put("proactive", true))
                        newest = turn
                        last = id
                    }
                    if (last > cursor) {
                        check(prefs.edit().putLong("inboxAfter", last).commit())
                    }
                }
            }
        }.exceptionOrNull()
        // A stopped JobService can race the durable commit. Deliver committed messages even if the job closed its client.
        main.post {
            newest?.let { ReplyNotifications.onReplySaved(context, it) }
            if (!closed) finished(newest != null, failure is HttpFailure && (failure.status == 403 || failure.status == 426))
        }
    }

    private fun usage(json: JSONObject): ContextUsage {
        val used = json.getInt("used")
        val limit = json.getInt("limit")
        require(used >= 0 && limit > 0)
        return ContextUsage(used, limit)
    }

    fun readContext(mode: String, finished: (ContextUsage?) -> Unit) = contextWorker.execute {
        var current: ContextUsage? = null
        runCatching {
            post(PiggyServer.url("/mobile/context"), { http ->
                http.setRequestProperty("Content-Type","application/json")
                http.outputStream.use { it.write(JSONObject().put("session",session).put("mode",mode).toString().toByteArray()) }
            }) { http ->
                current = usage(JSONObject(http.inputStream.bufferedReader().use { it.readText() }))
            }
        }
        ui { finished(current) }
    }

    private class HttpFailure(val status: Int, val pending: Boolean, message: String) : IOException(message)

    private fun retryNetwork(status: (String) -> Unit, block: () -> Unit) {
        val deadline = SystemClock.elapsedRealtime() + 390_000
        var failures = 0
        while (true) {
            try { block(); return } catch (e: IOException) {
                if (closed || SystemClock.elapsedRealtime() >= deadline ||
                    e is javax.net.ssl.SSLHandshakeException || e is javax.net.ssl.SSLPeerUnverifiedException) throw e
                val waiting = e is HttpFailure && e.status == 409 && e.pending
                if (e is HttpFailure && !waiting && e.status !in listOf(408, 429, 502, 503, 504)) throw e
                if (!waiting && ++failures > 3) throw e
                ui { status(if (waiting) "服务器仍在回复…" else "连接中断，正在重试…") }
                Thread.sleep(if (waiting) 3000L else 1000L shl (failures - 1))
            }
        }
    }

    fun send(text: String, draftText: String, status: (String) -> Unit, measured: (ContextUsage) -> Unit, delta: (String) -> Unit, finished: (String?, JSONObject?) -> Unit) = worker.execute {
        var savedReply: JSONObject? = null
        val failure = runCatching {
            val id = checkNotNull(prefs.getString("pendingId", null))
            val files = pendingAttachments
            // Check restored drafts from older releases before uploading any part of a group.
            for (file in files) {
                val uri = Uri.parse(file.getString("uri"))
                file.put("mime", formats.validate(file.getString("name"), file.optString("mime"), uri))
            }
            for (file in files) {
                if (file.optBoolean("uploaded")) continue
                retryNetwork(status) { upload(file) }
                synchronized(this@PiggyClient) {
                    if (closed) throw IOException("发送任务已暂停")
                    check(prefs.edit().putString("pendingFiles",JSONArray(files).toString()).commit())
                }
            }
            ui { status(ReplyPhrases.WAITING) }
            retryNetwork(status) { CycleSync.sync(context, true) }
            val data = JSONObject().put("timeZone", java.util.TimeZone.getDefault().id).put("text",text).put("session",session).put("request",id).put("mode",pendingMode)
            if (files.isNotEmpty()) data.put("attachments",JSONArray(files.map { it.getString("id") }))
            retryNetwork(status) {
                post(endpoint, { http ->
                    http.setRequestProperty("Content-Type","application/json")
                    http.outputStream.use { it.write(data.toString().toByteArray(Charsets.UTF_8)) }
                }) { http ->
                    var repliedAt = 0L
                    var done = false
                    var replies: JSONArray? = null
                    var stickerId = ""
                    val answer = StringBuilder()
                    http.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                        for (line in lines) {
                            if (closed) throw IOException("连接已关闭")
                            if (line.isBlank()) continue
                            val event = JSONObject(line)
                            event.optJSONObject("context")?.let {
                                runCatching { usage(it) }.getOrNull()?.let { value -> ui { measured(value) } }
                            }
                            if (event.has("error")) {
                                invalidatePendingRequest()
                                throw IllegalStateException(event.getString("error"))
                            }
                            if (event.has("delta")) {
                                val part = event.getString("delta")
                                answer.append(part)
                                ui { delta(part) }
                            }
                            if (event.optBoolean("done")) {
                                if (event.has("answer")) {
                                    answer.clear()
                                    answer.append(event.getString("answer"))
                                }
                                stickerId = event.optString("stickerId")
                                replies = event.optJSONArray("replyFiles")
                                repliedAt = event.optLong("repliedAt", 0L)
                                done = true
                            }
                        }
                    }
                    if (!done) throw IOException("回复中断，请重试")
                    val turn = JSONObject().put("request", id).put("text", draftText).put("answer", answer.toString())
                    turn.put("sentAt", pendingSentAt).put("repliedAt", repliedAt)
                    if (files.isNotEmpty()) {
                        files.forEach { ImagePreviews.save(context, it) }
                        turn.put("files", JSONArray(files))
                    }
                    if (stickerId.matches(STICKER_ID)) turn.put("stickerId",stickerId)
                    replies?.let { turn.put("replyFiles", it) }
                    synchronized(historyLock) {
                        if (closed || pendingId != id) throw IOException("发送任务已暂停")
                        history.append(turn)
                        check(prefs.edit().remove("pendingText")
                            .remove("sending").remove("pendingId").remove("pendingDraft").remove("pendingSeparate").remove("pendingFiles").commit()) { "无法保存回复，请重试" }
                    }
                    savedReply = turn
                }
            }
        }.exceptionOrNull()
        CycleSync.afterChat(context)
        if (!closed) ui { finished(failure?.let { it.localizedMessage ?: "发送失败，请重试" }, savedReply) }
    }

    private val downloads = Executors.newSingleThreadExecutor()
    private val downloadDir = java.io.File(context.cacheDir, "reply-files")

    private fun pruneDownloads() {
        val now = System.currentTimeMillis()
        downloadDir.listFiles()?.filter { (it.name.substringBefore('-').toLongOrNull() ?: 0L) <= now }
            ?.forEach { it.deleteRecursively() }
    }

    init {
        downloads.execute {
            pruneDownloads()
            val now = System.currentTimeMillis()
            java.io.File(context.cacheDir, "office-previews").listFiles()
                ?.filter { it.lastModified() <= now }?.forEach { it.delete() }
            context.cacheDir.listFiles()?.filter { it.isDirectory && it.name.startsWith("reader-") &&
                it.name.endsWith(".tmp") && it.lastModified() < now - 7L * 86400000 }
                ?.forEach { it.deleteRecursively() }
        }
    }

    // Accessed by the preview and the background export worker.
    internal fun cachedReply(file: JSONObject): Uri {
        val key = file.getString("key")
        val sticker = file.has("stickerId")
        val directory: java.io.File
        val url: String
        if (sticker) {
            require(key.matches(STICKER_ID) && file.getString("stickerId")==key)
            directory = java.io.File(context.cacheDir, "stickers/" + key)
            url = "/mobile/stickers/" + key
        } else {
            pruneDownloads()
            check(file.getLong("until") > System.currentTimeMillis()) { "附件已过期" }
            require(key.matches(Regex("[0-9]{13}-[a-f0-9-]{36}")))
            directory = java.io.File(downloadDir, key)
            url = "/mobile/reply-files/$session/$key"
        }
        directory.mkdirs()
        val name = file.getString("name").substringAfterLast('/').substringAfterLast('\\')
        val cached = java.io.File(directory, name.takeUnless { it.isBlank() || it == "." || it == ".." } ?: "附件")
        if (!cached.isFile) {
            val temp = java.io.File.createTempFile("download-", ".part", directory)
            val http = PiggyServer.mobile(context, PiggyServer.url(url))
            try {
                http.connectTimeout = 15000
                http.readTimeout = 60000
                http.instanceFollowRedirects = false
                check(http.responseCode == 200) { if (http.responseCode == 404) "附件已过期或不存在" else "下载失败，请重试" }
                val size = temp.outputStream().use { out -> http.inputStream.use { it.copyTo(out) } }
                val expected = if (sticker) http.contentLength.toLong() else file.getLong("size")
                check(size > 0 && expected == size && temp.renameTo(cached)) { "文件下载不完整，请重试" }
            } finally {
                http.disconnect()
                temp.delete()
            }
        }
        return androidx.core.content.FileProvider.getUriForFile(context, context.packageName + ".updates", cached)
    }

    fun fetchReply(file: JSONObject, finished: (Uri?, String?) -> Unit) = downloads.execute {
        val result = runCatching { cachedReply(file) }
        ui { finished(result.getOrNull(), result.exceptionOrNull()?.localizedMessage) }
    }

    fun close() {
        synchronized(this) { closed = true }
        connections.forEach { it.disconnect() }
        selectionWorker.shutdownNow()
        inboxWorker.shutdownNow()
        contextWorker.shutdownNow()
        worker.shutdownNow()
        downloads.shutdown()
    }
}

package dev.pichat

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Typeface
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.*
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import io.noties.markwon.ext.tables.TableAwareMovementMethod
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.Executors
import kotlin.math.sqrt
import org.json.JSONObject

class PreviewActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val attachmentActions by lazy { AttachmentActions(this, client) }
    private val markdown by lazy { chatMarkdown(this) }
    private lateinit var client: PiggyClient
    private lateinit var info: JSONObject
    private lateinit var temp: File
    private lateinit var content: FrameLayout
    private lateinit var pager: LinearLayout
    private lateinit var position: TextView
    private lateinit var prev: TextView
    private lateinit var next: TextView
    private lateinit var more: TextView
    private var original: Uri? = null
    private var browser: WebView? = null
    private var pdf: PdfRenderer? = null
    private var pages: List<String> = emptyList()
    @Volatile private var index = 0
    private var count = 0
    private var isMarkdown = false
    @Volatile private var closed = false
    private val paper = Color.rgb(250, 249, 252)
    private val ink = Color.rgb(48, 42, 54)
    private val accent = Color.rgb(105, 77, 131)
    @Volatile private var office: OfficeReader? = null
    private var officeKind = -1
    private var sheetNames: Array<String>? = null
    private val limit = 32L * 1024 * 1024
    private val origin = "https://preview.piggy.invalid"
    private val name
        get() = info.getString("name")

    private val mime
        get() = info.optString("mime", "application/octet-stream")

    private val until
        get() = info.optLong("until", Long.MAX_VALUE)

    private fun dp(n: Int) = (resources.displayMetrics.density * n + .5f).toInt()

    private fun label(value: String, size: Float, tint: Int = ink) =
        TextView(this).apply {
            text = value
            textSize = size
            setTextColor(tint)
            gravity = Gravity.CENTER_VERTICAL
        }

    private fun action(value: String, description: String, click: () -> Unit) =
        label(value, 16f, accent).apply {
            contentDescription = description
            gravity = Gravity.CENTER
            isFocusable = true
            minWidth = dp(48)
            minHeight = dp(48)
            setPadding(dp(8), 0, dp(8), 0)
            setOnClickListener { click() }
        }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        info = JSONObject(requireNotNull(intent.getStringExtra("file")))
        index = state?.getInt("page") ?: 0
        client = PiggyClient(this) {}
        attachmentActions.awaitingPermission = state?.getString("savingAttachment")?.let { JSONObject(it) }
        temp =
            File.createTempFile("reader-", ".tmp", cacheDir).apply {
                delete()
                mkdir()
            }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        val root =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(paper)
            }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars =
                insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
                )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val bar =
            LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL
                setBackgroundColor(Color.WHITE)
            }
        bar.addView(action("‹", "返回聊天") { finish() })
        bar.addView(
            label(name, 16f).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                typeface = Typeface.DEFAULT_BOLD
            },
            LinearLayout.LayoutParams(0, dp(52), 1f),
        )
        more = action("⋮", "文件操作") { attachmentActions.showMenu(info, original) }
        more.isEnabled = false
        bar.addView(more)
        root.addView(bar)
        content = FrameLayout(this)
        root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
        pager =
            LinearLayout(this).apply {
                gravity = Gravity.CENTER
                setBackgroundColor(Color.WHITE)
            }
        prev = action("上一页", "上一页") { showPage(index - 1) }
        next = action("下一页", "下一页") { showPage(index + 1) }
        position = label("", 14f, accent).apply { gravity = Gravity.CENTER }
        pager.addView(prev)
        pager.addView(position, LinearLayout.LayoutParams(0, dp(48), 1f))
        pager.addView(next)
        root.addView(pager)
        pager.visibility = View.GONE
        setContentView(root)
        status("正在打开…")
        if (until != Long.MAX_VALUE)
            content.postDelayed(
                { if (!closed) finish() },
                (until - System.currentTimeMillis()).coerceAtLeast(0),
            )
        if (until <= System.currentTimeMillis()) {
            finish()
            return
        }
        if (info.has("key"))
            client.fetchReply(info) { uri, error ->
                if (uri == null) status(error ?: "下载失败") else prepare(uri)
            }
        else prepare(Uri.parse(info.getString("uri")))
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        attachmentActions.awaitingPermission?.let { out.putString("savingAttachment", it.toString()) }
        out.putInt("page", index)
    }

    private fun status(message: String) {
        content.removeAllViews()
        content.addView(
            label(message, 16f).apply {
                gravity = Gravity.CENTER
                setPadding(dp(20), 0, dp(20), 0)
            }
        )
    }

    private fun onScreen(block: () -> Unit) = runOnUiThread {
        if (!closed && !isFinishing && until > System.currentTimeMillis()) block()
    }

    private fun background(block: () -> Unit) =
        worker.execute {
            try {
                block()
            } catch (e: Exception) {
                onScreen {
                    status(
                        when (e) {
                            is java.util.zip.ZipException -> "工作簿可能已加密或损坏"
                            is java.net.SocketTimeoutException -> "预览超时，请返回后重试"
                            is SecurityException -> "原文件的读取权限已失效"
                            else -> e.localizedMessage ?: "文件无法预览"
                        }
                    )
                    pager.visibility = View.GONE
                }
            }
        }

    private fun prepare(uri: Uri) {
        val ext =
            name.substringAfterLast('.', "").lowercase().ifEmpty {
                android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime).orEmpty()
            }
        original = uri
        more.isEnabled = true
        background {
            val source = File(temp, "original")
            val input =
                try {
                    contentResolver.openInputStream(uri)
                } catch (_: IOException) {
                    null
                } catch (_: SecurityException) {
                    null
                }
            if (input == null) {
                val thumb = ImagePreviews.saved(this, info.optString("id"))
                if (thumb == null || ImagePreviews.source(info) == null)
                    throw IOException("原文件已移除或读取权限已失效")
                contentResolver.openInputStream(thumb)!!.use { stream ->
                    source.outputStream().use { stream.copyTo(it) }
                }
                onScreen {
                    more.isEnabled = false
                    showBrowser("image", "image/webp")
                    Toast.makeText(this, "原图不可用，显示本机缩略图", Toast.LENGTH_SHORT).show()
                }
                return@background
            }
            input.use { i -> source.outputStream().use { o -> copyBounded(i, o, limit) } }
            when {
                mime.startsWith("image/") ||
                    ext in setOf("png", "jpg", "jpeg", "gif", "bmp", "webp", "avif") ->
                    onScreen { showBrowser("image", mime) }
                ext == "pdf" || mime == "application/pdf" -> openPdf(source)
                ext in setOf("csv", "tsv") -> onScreen { showBrowser("sheet", ext) }
                ext in
                    setOf(
                        "xls",
                        "xlsx",
                        "xlsm",
                        "xlsb",
                        "xlt",
                        "xltx",
                        "ods",
                        "numbers",
                        "doc",
                        "docx",
                        "dot",
                        "odt",
                        "rtf",
                        "ppt",
                        "pptx",
                        "pot",
                        "pps",
                        "odp",
                        "pages",
                        "key",
                    ) -> {
                    onScreen { status("正在读取原文档…") }
                    openOffice(source, ext)
                }
                ext in setOf("gdoc", "gsheet", "gslides") ->
                    onScreen { status("这是在线文档的快捷方式。要查看正文，请将文档导出为 Word、Excel、PPT 或 PDF。") }
                mime.startsWith("text/") ||
                    AttachmentFormats(this).isTextFile(name, mime) ||
                    ext in setOf("md", "markdown", "txt") -> {
                    isMarkdown = mime == "text/markdown" || ext in setOf("md", "markdown")
                    pages = readTextPages(source)
                    count = pages.size
                    onScreen { showPage(index) }
                }
                else -> onScreen { status("此格式没有可用的预览，可从文件操作中保存原件。") }
            }
        }
    }

    private fun copyBounded(input: InputStream, out: OutputStream, max: Long) {
        val buf = ByteArray(32768)
        var total = 0L
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            check(total <= max) { "文件过大，无法在应用内预览" }
            out.write(buf, 0, n)
        }
    }

    private fun openOffice(source: File, ext: String) {
        val original = File(temp, "document." + ext)
        check(source.renameTo(original)) { "无法准备预览文件" }
        if (closed) return
        val reader = OfficeReader(this)
        office = reader
        if (closed) {
            reader.close()
            return
        }
        val info =
            reader.request(OfficeReader.OPEN, Bundle().apply { putString("path", original.path) })
        officeKind = info.getInt("kind")
        count = info.getInt("count")
        onScreen { showPage(index) }
    }

    private fun showOfficePage(reader: OfficeReader, current: Int) {
        background {
            if (closed || current != index) return@background
            val page = reader.request(OfficeReader.PAGE, Bundle().apply { putInt("part", current) })
            val sheet = officeKind == 1
            val label =
                if (sheet) page.getString("name").orEmpty().ifBlank { "工作表 ${current+1}" }
                else "第 ${current+1} 页"
            onScreen {
                if (current != index) return@onScreen
                if (sheet) {
                    pager.visibility = View.VISIBLE
                    prev.text = "上一表"
                    next.text = "下一表"
                    prev.contentDescription = "上一张工作表"
                    next.contentDescription = "下一张工作表"
                    position.text = if (count > 1) "$label  ▾  ·  ${current+1} / $count" else label
                    if (count > 1) {
                        position.contentDescription = "选择工作表，$label"
                        position.isFocusable = true
                        position.setOnClickListener { selectSheet(reader) }
                    }
                    position.maxLines = 2
                    position.ellipsize = TextUtils.TruncateAt.END
                }
                content.removeAllViews()
                content.addView(
                    OfficePage(
                        this,
                        page.getInt("width"),
                        page.getInt("height"),
                        sheet,
                        label + "，双击或双指缩放",
                    ) { area, w, h, ready ->
                        background paint@{
                            if (closed || current != index) return@paint
                            val reply =
                                reader.request(
                                    OfficeReader.PAINT,
                                    Bundle().apply {
                                        putInt("part", current)
                                        putInt("w", w)
                                        putInt("h", h)
                                        putInt("x", area.left)
                                        putInt("y", area.top)
                                        putInt("dw", area.width())
                                        putInt("dh", area.height())
                                    },
                                )
                            @Suppress("DEPRECATION")
                            val bitmap = checkNotNull(reply.getParcelable<Bitmap>("pixels"))
                            onScreen { if (current == index) ready(bitmap) }
                        }
                    }
                )
            }
        }
    }

    private fun selectSheet(reader: OfficeReader) {
        position.isEnabled = false
        background {
            val names =
                sheetNames
                    ?: buildList {
                            while (size < count && !closed) {
                                val reply =
                                    reader.request(
                                        OfficeReader.SHEETS,
                                        Bundle().apply { putInt("offset", size) },
                                    )
                                addAll(checkNotNull(reply.getStringArray("names")))
                            }
                        }
                        .toTypedArray()
                        .also { sheetNames = it }
            onScreen {
                position.isEnabled = true
                android.app.AlertDialog.Builder(this)
                    .setTitle("选择工作表")
                    .setSingleChoiceItems(names, index) { dialog, which ->
                        dialog.dismiss()
                        showPage(which)
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
        }
    }

    private fun openPdf(path: File) {
        val fd = ParcelFileDescriptor.open(path, ParcelFileDescriptor.MODE_READ_ONLY)
        try {
            pdf = PdfRenderer(fd)
        } catch (e: Exception) {
            fd.close()
            throw IOException("PDF 无法打开，可能已加密或损坏", e)
        }
        count = pdf!!.pageCount
        check(count > 0) { "文档没有页面" }
        onScreen { showPage(index) }
    }

    private fun showPage(wanted: Int) {
        index = wanted.coerceIn(0, count - 1)
        val current = index
        pager.visibility = if (count > 1) View.VISIBLE else View.GONE
        position.text = "${index+1} / $count"
        prev.isEnabled = index > 0
        next.isEnabled = index < count - 1
        prev.alpha = if (prev.isEnabled) 1f else .4f
        next.alpha = if (next.isEnabled) 1f else .4f
        val reader = office
        if (reader != null) {
            showOfficePage(reader, current)
        } else if (pdf != null) {
            val width = resources.displayMetrics.widthPixels
            background {
                if (closed || current != index) return@background
                val bitmap =
                    pdf!!.openPage(current).use { page ->
                        val scale =
                            minOf(
                                (width * 2).coerceAtMost(2200).toDouble() / page.width,
                                sqrt(3200000.0 / page.width / page.height),
                            )
                        Bitmap.createBitmap(
                                (page.width * scale).toInt().coerceAtLeast(1),
                                (page.height * scale).toInt().coerceAtLeast(1),
                                Bitmap.Config.ARGB_8888,
                            )
                            .also {
                                it.eraseColor(Color.WHITE)
                                page.render(
                                    it,
                                    null,
                                    null,
                                    PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY,
                                )
                            }
                    }
                onScreen {
                    if (current == index) {
                        content.removeAllViews()
                        content.addView(
                            ZoomPage(this, bitmap, current + 1) { area, w, h, ready ->
                                background {
                                    if (closed || current != index) return@background
                                    val shrink = minOf(1.0, sqrt(3200000.0 / w / h))
                                    val detail =
                                        Bitmap.createBitmap(
                                            (w * shrink).toInt().coerceAtLeast(1),
                                            (h * shrink).toInt().coerceAtLeast(1),
                                            Bitmap.Config.ARGB_8888,
                                        )
                                    detail.eraseColor(Color.WHITE)
                                    pdf!!.openPage(current).use { page ->
                                        val matrix =
                                            Matrix().apply {
                                                setScale(
                                                    detail.width / (area.width() * page.width),
                                                    detail.height / (area.height() * page.height),
                                                )
                                                postTranslate(
                                                    -area.left * detail.width / area.width(),
                                                    -area.top * detail.height / area.height(),
                                                )
                                            }
                                        page.render(
                                            detail,
                                            null,
                                            matrix,
                                            PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY,
                                        )
                                    }
                                    onScreen { if (current == index) ready(detail) }
                                }
                            }
                        )
                    }
                }
            }
        } else {
            val view =
                label("", 17f).apply {
                    setPadding(dp(18), dp(18), dp(18), dp(28))
                    setTextIsSelectable(true)
                    movementMethod = TableAwareMovementMethod.create()
                    setLinkTextColor(accent)
                    setLineSpacing(dp(3).toFloat(), 1f)
                    if (isMarkdown) markdown.setMarkdown(this, pages[current])
                    else text = pages[current]
                }
            content.removeAllViews()
            content.addView(ScrollView(this).apply { addView(view) })
        }
    }

    @Suppress("SetJavaScriptEnabled")
    private fun showBrowser(mode: String, kind: String) {
        val sheet = mode == "sheet"
        val web = WebView(this)
        if (!sheet) web.setOnLongClickListener { attachmentActions.showMenu(info, original); true }
        browser = web
        web.settings.apply {
            javaScriptEnabled = sheet
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        web.webViewClient =
            object : WebViewClient() {
                override fun onRenderProcessGone(
                    view: WebView,
                    detail: android.webkit.RenderProcessGoneDetail,
                ): Boolean {
                    content.removeView(view)
                    view.destroy()
                    browser = null
                    status("文件过大或无法显示，可从文件操作中保存原件。")
                    return true
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
                    true

                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse {
                    val path = request.url.path.orEmpty()
                    if (
                        request.url.scheme == "https" &&
                            request.url.authority == "preview.piggy.invalid"
                    ) {
                        when (path) {
                            "/original" ->
                                return WebResourceResponse(
                                    if (sheet) "application/octet-stream" else kind,
                                    null,
                                    runCatching { File(temp, "original").inputStream() }.getOrNull(),
                                )
                            "/image" -> {
                                val html =
                                    """<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"><style>body{margin:0;background:#faf9fc;display:grid;place-items:center;min-height:100vh}img{max-width:100%;max-height:100vh}</style><img src="/original" alt="图片预览">"""
                                return WebResourceResponse(
                                    "text/html",
                                    "UTF-8",
                                    html.byteInputStream(),
                                )
                            }
                            "/workbook.html",
                            "/workbook.js",
                            "/xlsx.full.min.js" ->
                                if (sheet)
                                    return WebResourceResponse(
                                        if (path.endsWith(".html")) "text/html"
                                        else "text/javascript",
                                        "UTF-8",
                                        assets.open("preview" + path),
                                    )
                        }
                    }
                    return WebResourceResponse(
                        "text/plain",
                        "UTF-8",
                        403,
                        "Forbidden",
                        emptyMap(),
                        ByteArrayInputStream(byteArrayOf()),
                    )
                }
            }
        content.removeAllViews()
        content.addView(web)
        web.loadUrl(if (sheet) "$origin/workbook.html?$kind" else "$origin/image")
    }

    override fun onRequestPermissionsResult(request: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(request, permissions, results)
        attachmentActions.onPermissionResult(request, results)
    }

    override fun onDestroy() {
        closed = true
        office?.close()
        client.close()
        browser?.let {
            content.removeView(it)
            it.destroy()
        }
        worker.execute {
            pdf?.close()
            temp.deleteRecursively()
        }
        worker.shutdown()
        super.onDestroy()
    }
}

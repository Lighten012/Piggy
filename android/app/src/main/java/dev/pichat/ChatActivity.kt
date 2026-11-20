package dev.pichat

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.net.Uri
import android.webkit.MimeTypeMap
import org.json.JSONObject
import android.content.Intent
import android.text.TextUtils
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Bundle
import android.text.InputFilter
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.*
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class ChatActivity : Activity() {
    private val markdown by lazy { chatMarkdown(this) }
    private lateinit var chat: LinearLayout
    private lateinit var transcript: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var empty: LinearLayout
    private lateinit var input: EditText
    private lateinit var attach: TextView
    private lateinit var fileRow: LinearLayout
    private lateinit var fileStrip: HorizontalScrollView
    private lateinit var sendError: TextView
    private lateinit var send: ImageButton
    private lateinit var gate: LinearLayout
    private lateinit var gateTitle: TextView
    private lateinit var gateDetail: TextView
    private lateinit var gateAction: TextView
    private lateinit var gateProgress: ProgressBar
    private lateinit var client: PiggyClient
    private lateinit var updater: AppUpdater

    private var versionCurrent = false
    private var selecting = false
    private var generating = false
    private var promptedVersion: String? = null
    private val ink = Color.rgb(58, 42, 48)
    private val muted = Color.rgb(113, 92, 98)
    private val plum = Color.rgb(117, 66, 83)
    private val paper = Color.rgb(252, 248, 245)
    private val line = Color.rgb(232, 218, 216)
    private val match = LinearLayout.LayoutParams.MATCH_PARENT
    private val wrap = LinearLayout.LayoutParams.WRAP_CONTENT

    private fun dp(value: Int) = (resources.displayMetrics.density * value + .5f).toInt()
    private fun shape(color: Int, radius: Int, border: Boolean = false) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius).toFloat()
        if (border) setStroke(dp(1), line)
    }
    private fun pill() = RippleDrawable(ColorStateList.valueOf(0x33ffffff), shape(plum, 32), null)
    private fun text(value: String, size: Float, color: Int = ink) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        includeFontPadding = false
    }
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun mark() = ImageView(this).apply {
        setImageResource(R.drawable.piggy_portrait)
        scaleType = ImageView.ScaleType.CENTER_CROP
        background = shape(paper, 64)
        clipToOutline = true
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        val root = column().apply {
            setBackgroundColor(paper)
            isFocusableInTouchMode = true
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left + dp(18), bars.top + dp(8), bars.right + dp(18), bars.bottom + dp(10))
            insets
        }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(mark(), LinearLayout.LayoutParams(dp(43), dp(43)))
        val title = text("Piggy", 30f).apply { typeface = Typeface.create("serif", Typeface.BOLD_ITALIC) }
        header.addView(title, LinearLayout.LayoutParams(0, wrap, 1f).apply { leftMargin = dp(10) })
        header.addView(text("v" + BuildConfig.VERSION_NAME, 13f, muted))
        root.addView(header, match, dp(60))

        chat = column()
        scroll = ScrollView(this).apply { isFillViewport = true; isVerticalScrollBarEnabled = false }
        transcript = column().apply { setPadding(dp(1), dp(14), dp(1), dp(6)) }
        empty = column().apply {
            gravity = Gravity.CENTER
            addView(mark(), dp(72), dp(72))
            addView(text("今天想聊点什么？", 22f), LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(18) })
        }
        transcript.addView(empty, LinearLayout.LayoutParams(match, 0, 1f))
        scroll.addView(transcript)
        chat.addView(scroll, LinearLayout.LayoutParams(match, 0, 1f))
        val composerCard = column().apply {
            background = shape(Color.WHITE, 26, true)
            setPadding(dp(6), dp(6), dp(6), dp(6))
            elevation = dp(2).toFloat()
        }
        fileRow = LinearLayout(this)
        fileStrip = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            setPadding(dp(5), dp(4), dp(5), dp(8))
            addView(fileRow)
        }
        composerCard.addView(fileStrip, match, wrap)
        sendError = text("", 14f, plum).apply {
            visibility = View.GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            setPadding(dp(10), dp(4), dp(10), dp(4))
        }
        composerCard.addView(sendError, match, wrap)
        val composer = LinearLayout(this).apply { gravity = Gravity.BOTTOM }
        attach = text("＋", 24f, plum).apply {
            contentDescription = "添加附件"
            gravity = Gravity.CENTER
            isFocusable = true
            setOnClickListener {
                startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, client.formats.pickerTypes)
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                }, 302)
            }
        }
        composer.addView(attach, dp(48), dp(48))
        input = EditText(this).apply {
            hint = "给 Piggy 发消息…"
            contentDescription = "消息"
            setTextColor(ink)
            setHintTextColor(muted)
            textSize = 16f
            background = null
            minHeight = dp(48)
            maxLines = 5
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(2), dp(8), dp(4), dp(8))
            filters = arrayOf(InputFilter.LengthFilter(8000))
        }
        composer.addView(input, LinearLayout.LayoutParams(0, wrap, 1f))
        send = ImageButton(this).apply {
            contentDescription = "发送"
            setImageResource(R.drawable.send_arrow)
            scaleType = ImageView.ScaleType.CENTER
            background = pill()
            setOnClickListener { submit() }
        }
        composer.addView(send, LinearLayout.LayoutParams(dp(48), dp(48)).apply { leftMargin = dp(8) })
        composerCard.addView(composer, match, wrap)
        chat.addView(composerCard, LinearLayout.LayoutParams(match, wrap).apply { topMargin = dp(8) })
        root.addView(chat, LinearLayout.LayoutParams(match, 0, 1f))
        chat.visibility = View.GONE

        gate = column().apply { gravity = Gravity.CENTER }
        val card = column().apply {
            gravity = Gravity.CENTER
            background = shape(Color.WHITE, 30, true)
            setPadding(dp(20), dp(30), dp(20), dp(26))
        }
        card.addView(mark(), dp(64), dp(64))
        gateTitle = text("", 23f).apply { gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD }
        card.addView(gateTitle, LinearLayout.LayoutParams(match, wrap).apply { topMargin = dp(18) })
        gateDetail = text("", 15f, muted).apply { gravity = Gravity.CENTER }
        card.addView(gateDetail, LinearLayout.LayoutParams(match, wrap).apply { topMargin = dp(10) })
        gateProgress = ProgressBar(this).apply { indeterminateTintList = ColorStateList.valueOf(plum) }
        card.addView(gateProgress, LinearLayout.LayoutParams(dp(26), dp(26)).apply { topMargin = dp(20) })
        gateAction = text("", 16f, Color.WHITE).apply {
            gravity = Gravity.CENTER
            background = pill()
            isFocusable = true
            setPadding(dp(24), 0, dp(24), 0)
        }
        card.addView(gateAction, LinearLayout.LayoutParams(wrap, dp(48)).apply { topMargin = dp(20) })
        gate.addView(card, LinearLayout.LayoutParams(match, wrap))
        root.addView(gate, LinearLayout.LayoutParams(match, 0, 1f))
        setContentView(root)
        client = PiggyClient(this) { updater.check() }
        updater = AppUpdater(this, ::showVersion)
        val recent = client.recent
        for (i in 0 until recent.length()) {
            val turn = recent.getJSONObject(i)
            bubble(turn.getString("text"), true, PiggyClient.turnFiles(turn), turn.optString("filename"))
            bubble(turn.getString("answer"), false)
        }
        input.setText(client.draft)
        showFile()
        updater.checkOnLaunch()
    }

    private fun showFile() {
        val files = if (generating) emptyList() else client.attachments
        fileRow.removeAllViews()
        fileStrip.visibility = if (files.isEmpty()) View.GONE else View.VISIBLE
        for (file in files) {
            val image = ImagePreviews.source(file)
            val tile = FrameLayout(this)
            if (image != null) {
                tile.addView(photoTile(file, image), dp(88), dp(76))
            } else {
                tile.addView(documentTile(file, true), dp(188), dp(76))
            }
            val remove = text("×", 18f, Color.WHITE).apply {
                gravity = Gravity.CENTER
                background = shape(Color.argb(220, 63, 44, 51), 20)
            }
            val action = FrameLayout(this).apply {
                contentDescription = "移除附件，" + file.getString("name")
                isFocusable = true
                addView(remove, FrameLayout.LayoutParams(dp(24),dp(24),Gravity.TOP or Gravity.END).apply {
                    topMargin = dp(4); rightMargin = dp(4)
                })
                setOnClickListener { if (!selecting) { client.removeFile(file); showFile() } }
            }
            tile.addView(action, FrameLayout.LayoutParams(dp(48),dp(48),Gravity.TOP or Gravity.END))
            fileRow.addView(tile, LinearLayout.LayoutParams(wrap,wrap).apply { rightMargin = dp(6) })
        }
    }

    private fun photoTile(file: JSONObject, image: Uri) = previewView().apply {
        isFocusable = true
        scaleType = ImageView.ScaleType.CENTER_CROP
        setOnClickListener { openFile(file) }
        ImagePreviews.display(this, image, file.getString("name"))
    }

    private fun documentTile(file: JSONObject, draft: Boolean) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        background = shape(if (draft) paper else Color.WHITE, 14, true)
        setPadding(dp(10), dp(6), dp(if (draft) 30 else 10), dp(6))
        contentDescription = "打开附件，" + file.getString("name")
        isFocusable = true
        setOnClickListener { openFile(file) }
        addView(ImageView(this@ChatActivity).apply {
            setImageResource(R.drawable.attachment_document)
            background = shape(Color.rgb(245, 231, 233), 10)
            setPadding(dp(7),dp(7),dp(7),dp(7))
        }, dp(36), dp(42))
        val labels = column()
        labels.addView(text(file.getString("name"), 15f).apply {
            maxLines = 2; ellipsize = TextUtils.TruncateAt.END
            typeface = Typeface.DEFAULT_BOLD
        })
        labels.addView(text(client.sizeLabel(file), 12f, muted).apply { setPadding(0,dp(3),0,0) })
        addView(labels, LinearLayout.LayoutParams(0,wrap,1f).apply { leftMargin = dp(9) })
        if (!draft) addView(text("↗",18f,plum))
    }

    private fun openFile(file: JSONObject) {
        val name = file.getString("name")
        val uri = Uri.parse(file.getString("uri"))
        val image = ImagePreviews.source(file)
        if (image != null) {
            val preview = previewView()
            val dialog = AlertDialog.Builder(this).setTitle(name).setView(preview)
                .setPositiveButton("关闭", null).show()
            ImagePreviews.enlarge(preview, image, ImagePreviews.saved(this, file.optString("id")), name)
            dialog.setOnDismissListener { ImagePreviews.display(preview, null, "") }
            return
        }
        var mime = file.optString("mime")
        if (mime.isBlank() || mime == "application/octet-stream") {
            mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
                ?: "application/octet-stream"
        }
        try {
            // Detect removed documents here so the user gets a useful message in Piggy.
            contentResolver.openFileDescriptor(uri, "r")?.close()
            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).apply {
                clipData = ClipData.newRawUri(name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "手机上没有可打开此类文件的应用", Toast.LENGTH_LONG).show()
        } catch (_: Exception) {
            Toast.makeText(this, "无法打开本地文件，请重新选择", Toast.LENGTH_LONG).show()
        }
    }

    private fun previewView() = ImageView(this).apply {
        adjustViewBounds = true
        scaleType = ImageView.ScaleType.FIT_CENTER
        background = shape(paper, 12)
        clipToOutline = true
    }

    private fun showVersion(state: UpdateState) {
        versionCurrent = state == UpdateState.Current
        chat.visibility = if (versionCurrent) View.VISIBLE else View.GONE
        gate.visibility = if (versionCurrent) View.GONE else View.VISIBLE
        controls()
        if (versionCurrent) { toBottom(); return }
        gateProgress.visibility = if (state == UpdateState.Checking || state is UpdateState.Downloading) View.VISIBLE else View.GONE
        gateAction.visibility = View.GONE
        gateDetail.visibility = View.VISIBLE
        when (state) {
            UpdateState.Checking -> {
                gateTitle.text = "正在确认版本"
                gateDetail.visibility = View.GONE
            }
            is UpdateState.Downloading -> {
                gateTitle.text = "正在更新到 " + state.name
                gateDetail.text = "正在下载并校验安装包…"
            }
            is UpdateState.Ready -> {
                gateTitle.text = "新版本已准备好"
                gateDetail.text = "安装 " + state.name + " 后即可继续之前的对话。"
                gateButton("安装更新") { updater.install() }
                val permitted = android.os.Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()
                if (promptedVersion != state.name && permitted && hasWindowFocus()) {
                    promptedVersion = state.name
                    updater.install()
                }
            }
            is UpdateState.Failed -> {
                gateTitle.text = "暂时无法完成更新"
                gateDetail.text = state.message
                gateButton("重试") { updater.check() }
            }
            UpdateState.Current -> Unit
        }
    }

    private fun gateButton(value: String, click: () -> Unit) {
        gateAction.text = value
        gateAction.visibility = View.VISIBLE
        gateAction.setOnClickListener { click() }
    }

    @Deprecated("Activity result callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 302 && resultCode == RESULT_OK) {
            val clip = data?.clipData
            val uris = if (clip != null) (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
                else listOfNotNull(data?.data)
            selecting = true
            controls()
            client.chooseFiles(uris) { error ->
                selecting = false
                showFile()
                controls()
                sendError.text = error
                sendError.visibility = if (error.isNullOrEmpty()) View.GONE else View.VISIBLE
            }
        }
        if (requestCode == AppUpdater.PERMISSION_REQUEST && android.os.Build.VERSION.SDK_INT >= 26 &&
            packageManager.canRequestPackageInstalls()) updater.install()
    }

    private fun bubble(value: String, user: Boolean, files: List<JSONObject> = emptyList(), legacyLabel: String = ""): TextView {
        empty.visibility = View.GONE
        val row = column().apply { gravity = if (user) Gravity.END else Gravity.START }
        val role = text(if (user) "你" else "Piggy", 13f, muted)
        role.setPadding(dp(9), 0, dp(9), dp(5))
        if (user) row.addView(role, wrap, wrap) else {
            val byline = LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(5), 0, 0, dp(5))
                addView(mark(), dp(22), dp(22))
                role.setPadding(dp(6), 0, 0, 0)
                addView(role, wrap, wrap)
            }
            row.addView(byline, wrap, wrap)
        }
        if (files.isEmpty() && legacyLabel.isNotEmpty())
            row.addView(text(legacyLabel, 14f, muted), wrap, wrap)
        val group = if (files.isEmpty()) row else column().apply {
            val width = minOf(dp(276), (resources.displayMetrics.widthPixels * .76f).toInt())
            background = shape(Color.rgb(247, 238, 239), 20, true)
            setPadding(dp(5),dp(5),dp(5),dp(5))
            row.addView(this,width,wrap)
            var index = 0
            while (index < files.size) {
                val file = files[index++]
                val image = ImagePreviews.source(file)
                val item: View
                val height: Int
                if (image != null) {
                    val photos = LinearLayout(this@ChatActivity)
                    fun addPhoto(f: JSONObject, uri: Uri, gap: Int) {
                        val local = ImagePreviews.saved(this@ChatActivity, f.getString("id")) ?: uri
                        photos.addView(photoTile(f,local),LinearLayout.LayoutParams(0,match,1f).apply { leftMargin = dp(gap) })
                    }
                    addPhoto(file,image,0)
                    val next = files.getOrNull(index)
                    val nextImage = next?.let { ImagePreviews.source(it) }
                    if (next != null && nextImage != null) {
                        addPhoto(next,nextImage,4)
                        index++
                    }
                    item = photos
                    height = dp(if (photos.childCount == 2) 126 else 172)
                } else {
                    item = documentTile(file,false)
                    height = dp(66)
                }
                addView(item, LinearLayout.LayoutParams(match,height).apply { topMargin = if (childCount == 0) 0 else dp(4) })
            }
        }
        val view = text("", 17f, if (user && files.isEmpty()) Color.WHITE else ink).apply {
            setTextIsSelectable(true)
            setLinkTextColor(if (user && files.isEmpty()) Color.WHITE else plum)
            setPadding(dp(17), dp(13), dp(17), dp(13))
            setLineSpacing(dp(2).toFloat(), 1f)
            if (files.isEmpty()) background = shape(if (user) plum else Color.WHITE, 22, !user)
            maxWidth = (resources.displayMetrics.widthPixels * .81f).toInt()
        }
        if (value.isNotEmpty()) markdown.setMarkdown(view, value)
        if (files.isEmpty() || value.isNotEmpty()) group.addView(view, if (files.isEmpty()) wrap else match, wrap)
        transcript.addView(row, LinearLayout.LayoutParams(match, wrap).apply { bottomMargin = dp(15) })
        return view
    }

    private fun toBottom() = scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
    private fun controls() {
        val enabled = versionCurrent && !generating && !selecting
        attach.isEnabled = enabled
        send.isEnabled = enabled
        send.alpha = if (enabled) 1f else .55f
        input.isEnabled = enabled
    }
    private fun submit() {
        val draft = input.text.toString().trim()
        val files = client.attachments
        val message = draft.ifEmpty {
            when (files.size) { 0 -> ""; 1 -> "请帮我看看这个文件。"; else -> "请帮我看看这些文件。" }
        }
        if (message.isEmpty() || !send.isEnabled) return
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
        generating = true
        controls()
        sendError.visibility = View.GONE
        input.setText("")
        showFile()
        val firstPendingRow = transcript.childCount
        bubble(draft, true, files)
        val reply = bubble("", false).apply { hint = if (files.isEmpty()) "正在回复…" else "正在发送附件…" }
        toBottom()
        val source = StringBuilder()
        var scheduled = false
        val render = Runnable {
            scheduled = false
            val follow = !scroll.canScrollVertically(1)
            markdown.setMarkdown(reply, source.toString())
            if (follow) toBottom()
        }
        client.send(message, draft, uploaded = { reply.hint = "正在回复…" }, delta = { part ->
            reply.hint = ""
            source.append(part)
            if (!scheduled) {
                scheduled = true
                reply.postDelayed(render, 100)
            }
        }, finished = { error ->
            reply.removeCallbacks(render)
            if (error == null) {
                render.run()
            } else {
                transcript.removeViews(firstPendingRow, transcript.childCount - firstPendingRow)
                if (firstPendingRow == 1) empty.visibility = View.VISIBLE
                sendError.text = error
                sendError.visibility = View.VISIBLE
                input.setText(draft)
                input.setSelection(input.length())
            }
            generating = false
            showFile()
            controls()
        })
    }

    override fun onDestroy() {
        updater.close()
        client.close()
        super.onDestroy()
    }
}

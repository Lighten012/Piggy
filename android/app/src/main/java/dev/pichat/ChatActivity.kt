package dev.pichat

import android.app.Dialog
import android.app.Activity
import android.app.AlertDialog
import android.net.Uri
import org.json.JSONObject
import android.content.Intent
import android.text.Spanned
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
import io.noties.markwon.ext.tables.TableAwareMovementMethod
import io.noties.markwon.ext.tables.TableRowSpan

class ChatActivity : Activity() {
    private val markdown by lazy { chatMarkdown(this) }
    private lateinit var menu: ImageButton
    private var drawer: Dialog? = null
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

    private lateinit var contextMeter: ContextMeter
    private var readingContext = false
    private var versionCurrent = false
    private var selecting = false
    private var generating = false
    private var promptedVersion: String? = null
    private val ink = Color.rgb(48, 42, 54)
    private val muted = Color.rgb(101, 92, 111)
    private val plum = Color.rgb(105, 77, 131)
    private val paper = Color.rgb(250, 249, 252)
    private val line = Color.rgb(225, 220, 231)
    private val lavender = Color.rgb(229, 215, 247)
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
        scaleType = ImageView.ScaleType.FIT_CENTER
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(paper)
        }
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
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val header = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(12), 0)
            setBackgroundColor(paper)
        }
        menu = navButton(R.drawable.nav_menu, "打开侧边栏") { showDrawer() }
        header.addView(menu, dp(48), dp(48))
        header.addView(mark(), LinearLayout.LayoutParams(dp(28), dp(28)).apply { leftMargin = dp(3) })
        header.addView(text("Piggy", 18f).apply { typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) },
            LinearLayout.LayoutParams(wrap, wrap).apply { leftMargin = dp(8) })
        header.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        contextMeter = ContextMeter(this).apply { setOnClickListener { showContext() } }
        header.addView(contextMeter, wrap, dp(48))
        root.addView(header, match, dp(48))
        root.addView(View(this).apply { setBackgroundColor(line) }, match, 1)

        chat = column().apply {
            setBackgroundResource(R.drawable.chat_paper)
            setPadding(dp(14), 0, dp(14), dp(8))
        }
        scroll = ScrollView(this).apply { isFillViewport = true; isVerticalScrollBarEnabled = false }
        transcript = column().apply { setPadding(dp(1), dp(14), dp(1), dp(6)) }
        empty = column().apply {
            gravity = Gravity.CENTER
            addView(mark(), dp(58), dp(58))
            addView(text("今天想聊点什么？", 20f), LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(18) })
        }
        transcript.addView(empty, LinearLayout.LayoutParams(match, 0, 1f))
        scroll.addView(transcript)
        chat.addView(scroll, LinearLayout.LayoutParams(match, 0, 1f))
        val composerCard = column().apply {
            background = shape(Color.WHITE, 26, true)
            setPadding(dp(4), dp(3), dp(4), dp(3))
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
            background = android.graphics.drawable.InsetDrawable(pill(), dp(4))
            setOnClickListener { submit() }
        }
        composer.addView(send, LinearLayout.LayoutParams(dp(48), dp(48)).apply { leftMargin = dp(8) })
        composerCard.addView(composer, match, wrap)
        chat.addView(composerCard, LinearLayout.LayoutParams(match, wrap).apply { topMargin = dp(8) })
        root.addView(chat, LinearLayout.LayoutParams(match, 0, 1f))
        chat.visibility = View.GONE

        gate = column().apply { gravity = Gravity.CENTER; setPadding(dp(20), 0, dp(20), 0) }
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
            bubble(turn.getString("answer"), false, client.replyFiles(turn))
        }
        input.setText(client.draft)
        showFile()
        updater.checkOnLaunch()
    }

    private fun navButton(icon: Int, label: String, click: () -> Unit) = ImageButton(this).apply {
        setImageResource(icon)
        contentDescription = label
        scaleType = ImageView.ScaleType.CENTER
        background = RippleDrawable(ColorStateList.valueOf(0x22694D83), null, shape(Color.WHITE, 30))
        setOnClickListener { click() }
    }

    private fun drawerWidth() = minOf(dp(308), resources.displayMetrics.widthPixels - dp(52))

    private fun showDrawer() {
        if (!versionCurrent || drawer != null) return
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
        val dialog = Dialog(this)
        dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        dialog.setTitle("侧边栏")
        val panel = column().apply {
            background = shape(paper, 0)
            setPadding(dp(18), dp(14), dp(18), dp(20))
        }
        ViewCompat.setAccessibilityPaneTitle(panel, "侧边栏")
        val heading = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        heading.addView(mark(), dp(36), dp(36))
        heading.addView(text("Piggy", 20f).apply { typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) },
            LinearLayout.LayoutParams(0, wrap, 1f).apply { leftMargin = dp(10) })
        heading.addView(navButton(R.drawable.nav_close, "关闭侧边栏") { dialog.dismiss() }, dp(48), dp(48))
        panel.addView(heading, match, wrap)
        val current = text("当前对话", 16f, plum).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), 0, dp(12), 0)
            setCompoundDrawablesWithIntrinsicBounds(R.drawable.nav_chat, 0, 0, 0)
            compoundDrawablePadding = dp(12)
            background = RippleDrawable(ColorStateList.valueOf(0x22694D83), shape(lavender, 16), null)
            isSelected = true
            isFocusable = true
            setOnClickListener { dialog.dismiss() }
        }
        panel.addView(current, LinearLayout.LayoutParams(match, dp(48)).apply { topMargin = dp(26) })
        panel.addView(Space(this), LinearLayout.LayoutParams(1, 0, 1f))
        panel.addView(text("v" + BuildConfig.VERSION_NAME, 12f, muted).apply { setPadding(dp(12),0,0,0) })
        dialog.setContentView(panel)
        dialog.window?.apply {
            setGravity(Gravity.LEFT)
            setBackgroundDrawableResource(android.R.color.transparent)
            setDimAmount(.30f)
            setWindowAnimations(R.style.DrawerMotion)
            setLayout(drawerWidth(), match)
        }
        dialog.setCanceledOnTouchOutside(true)
        dialog.setOnDismissListener { drawer = null }
        drawer = dialog
        dialog.show()
    }

    override fun onConfigurationChanged(config: android.content.res.Configuration) {
        super.onConfigurationChanged(config)
        drawer?.window?.setLayout(drawerWidth(), match)
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
            background = shape(Color.rgb(240, 233, 247), 10)
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

    private fun expired(file: JSONObject) =
        file.has("until") && file.optLong("until") <= System.currentTimeMillis()

    private fun openFile(file: JSONObject) {
        if (expired(file)) {
            Toast.makeText(this, "附件已过期", Toast.LENGTH_SHORT).show()
            return
        }
        startActivity(Intent(this, PreviewActivity::class.java).putExtra("file", file.toString()))
    }

    private fun previewView() = ImageView(this).apply {
        adjustViewBounds = true
        scaleType = ImageView.ScaleType.FIT_CENTER
        background = shape(paper, 12)
        clipToOutline = true
    }

    private fun refreshContext() {
        if (readingContext || !versionCurrent || generating) return
        readingContext = true
        client.readContext { value ->
            readingContext = false
            if (!generating) contextMeter.update(value)
        }
    }

    private fun showContext() {
        val usage = contextMeter.usage
        val detail = usage?.detail ?: if (readingContext) "正在读取用量…" else "暂时无法读取用量"
        val scope = if (generating) "本次发送的输入用量。" else
            "包含系统提示词、最近的对话和仍在使用的附件。草稿和新选的附件会在发送时计入。"
        AlertDialog.Builder(this).setTitle("上下文用量").setMessage(detail + "\n\n" + scope)
            .setPositiveButton("知道了", null).apply {
                if (!readingContext && !generating) setNeutralButton("刷新") { _, _ -> refreshContext() }
            }.show()
    }

    private fun showVersion(state: UpdateState) {
        versionCurrent = state == UpdateState.Current
        contextMeter.visibility = if (versionCurrent) View.VISIBLE else View.GONE
        menu.isEnabled = versionCurrent
        if (!versionCurrent) drawer?.dismiss()
        chat.visibility = if (versionCurrent) View.VISIBLE else View.GONE
        gate.visibility = if (versionCurrent) View.GONE else View.VISIBLE
        controls()
        if (versionCurrent) { refreshContext(); toBottom(); return }
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
        if (!user) {
            val role = text("Piggy", 12f, muted)
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
            background = shape(if (user) lavender else Color.WHITE, 20, !user)
            setPadding(dp(5),dp(5),dp(5),dp(5))
            row.addView(this,width,wrap)
            var index = 0
            while (index < files.size) {
                val file = files[index++]
                val image = if (expired(file)) null else ImagePreviews.source(file)
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
                    val nextImage = next?.takeUnless(::expired)?.let { ImagePreviews.source(it) }
                    if (next != null && nextImage != null) {
                        addPhoto(next,nextImage,4)
                        index++
                    }
                    item = photos
                    height = dp(if (photos.childCount == 2) 126 else 172)
                } else if (expired(file)) {
                    item = text(file.getString("name") + " · 附件已过期", 14f, muted).apply {
                        setPadding(dp(10), dp(8), dp(10), dp(8))
                    }
                    height = wrap
                } else {
                    item = documentTile(file,false)
                    height = dp(66)
                }
                addView(item, LinearLayout.LayoutParams(match,height).apply { topMargin = if (childCount == 0) 0 else dp(4) })
            }
        }
        val view = text("", 16f, ink).apply {
            setTextIsSelectable(true)
            movementMethod = TableAwareMovementMethod.create()
            setLinkTextColor(plum)
            setPadding(dp(17), dp(13), dp(17), dp(13))
            setLineSpacing(dp(2).toFloat(), 1f)
            if (files.isEmpty()) background = shape(if (user) lavender else Color.WHITE, 20, !user)
            maxWidth = (resources.displayMetrics.widthPixels * .81f).toInt()
        }
        if (value.isNotEmpty()) renderMessage(view, value)
        if (files.isEmpty() || value.isNotEmpty()) group.addView(view, if (files.isEmpty()) wrap else match, wrap)
        transcript.addView(row, LinearLayout.LayoutParams(match, wrap).apply { bottomMargin = dp(15) })
        return view
    }

    private fun renderMessage(view: TextView, source: String) {
        markdown.setMarkdown(view, source)
        val content = view.text as? Spanned
        // Table rows draw their own cells and need the bubble width even when the prose is short.
        val hasTable = content != null && content.getSpans(0, content.length, TableRowSpan::class.java).isNotEmpty()
        val minimum = if (hasTable) view.maxWidth else 0
        if (view.minWidth != minimum) view.minWidth = minimum
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
        contextMeter.update(null)
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
            renderMessage(reply, source.toString())
            if (follow) toBottom()
        }
        client.send(message, draft, uploaded = { reply.hint = "正在回复…" }, measured = contextMeter::update, delta = { part ->
            reply.hint = ""
            source.append(part)
            if (!scheduled) {
                scheduled = true
                reply.postDelayed(render, 100)
            }
        }, finished = { error ->
            reply.removeCallbacks(render)
            if (error == null) {
                val follow = !scroll.canScrollVertically(1)
                val history = client.recent
                val turn = history.getJSONObject(history.length() - 1)
                transcript.removeViewAt(firstPendingRow + 1)
                bubble(turn.getString("answer"), false, client.replyFiles(turn))
                if (follow) toBottom()
            } else {
                transcript.removeViews(firstPendingRow, transcript.childCount - firstPendingRow)
                if (firstPendingRow == 1) empty.visibility = View.VISIBLE
                sendError.text = error
                sendError.visibility = View.VISIBLE
                input.setText(draft)
                input.setSelection(input.length())
            }
            generating = false
            contextMeter.update(null)
            refreshContext()
            showFile()
            controls()
        })
    }

    override fun onDestroy() {
        drawer?.dismiss()
        updater.close()
        client.close()
        super.onDestroy()
    }
}

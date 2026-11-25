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
import android.text.Editable
import android.text.TextWatcher
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
    private val attachmentActions by lazy { AttachmentActions(this, client) }
    private val markdown by lazy { chatMarkdown(this) }
    private lateinit var menu: ImageButton
    private var drawer: Dialog? = null
    private lateinit var chat: FrameLayout
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
    private lateinit var gateDownload: ProgressBar
    private lateinit var gateProgress: ProgressBar
    private lateinit var client: PiggyClient
    private lateinit var updater: AppUpdater

    private lateinit var contextMeter: ContextMeter
    private var contextEpoch = 0L
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
        client = PiggyClient(this) { updater.check() }
        val header = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(8), 0)
            setBackgroundColor(paper)
        }
        val identity = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        menu = navButton(R.drawable.nav_menu, "打开侧边栏") { showDrawer() }
        identity.addView(menu, dp(48), dp(48))
        identity.addView(mark(), LinearLayout.LayoutParams(dp(28), dp(28)).apply { leftMargin = dp(3) })
        identity.addView(text("Piggy", 18f).apply { typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) },
            LinearLayout.LayoutParams(wrap, wrap).apply { leftMargin = dp(6) })
        val modes = modeSwitch()
        val modeGap = dp(5)
        val leading = object : LinearLayout(this) {
            override fun onMeasure(widthSpec: Int, heightSpec: Int) {
                val natural = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
                identity.measure(natural, natural)
                modes.measure(natural, natural)
                orientation = if (identity.measuredWidth + modeGap + modes.measuredWidth <= View.MeasureSpec.getSize(widthSpec))
                    HORIZONTAL else VERTICAL
                super.onMeasure(widthSpec, heightSpec)
            }
        }.apply { gravity = Gravity.CENTER_VERTICAL }
        leading.addView(identity, wrap, wrap)
        leading.addView(modes, LinearLayout.LayoutParams(wrap, wrap).apply { leftMargin = modeGap })
        header.addView(leading, LinearLayout.LayoutParams(0, wrap, 1f))
        contextMeter = ContextMeter(this).apply { setOnClickListener { showContext() } }
        header.addView(contextMeter, LinearLayout.LayoutParams(wrap, dp(48)).apply { gravity = Gravity.TOP })
        root.addView(header, match, wrap)
        root.addView(View(this).apply { setBackgroundColor(line) }, match, 1)

        chat = FrameLayout(this)
        chat.addView(ImageView(this).apply {
            setImageResource(R.drawable.dusk_lake)
            scaleType = ImageView.ScaleType.CENTER_CROP
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, match, match)
        val chatContent = column().apply {
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
        chatContent.addView(scroll, LinearLayout.LayoutParams(match, 0, 1f))
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
                selecting = true
                controls()
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
        chatContent.addView(composerCard, LinearLayout.LayoutParams(match, wrap).apply { topMargin = dp(8) })
        chat.addView(chatContent, match, match)
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
        gateDownload = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progressTintList = ColorStateList.valueOf(plum)
            progressBackgroundTintList = ColorStateList.valueOf(lavender)
        }
        card.addView(gateDownload, LinearLayout.LayoutParams(match, dp(12)).apply { topMargin = dp(16) })
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
        attachmentActions.awaitingPermission = state?.getString("savingAttachment")?.let { JSONObject(it) }
        client.lastUsage?.let(contextMeter::update)
        updater = AppUpdater(this, ::showVersion)
        renderHistory()
        client.restorePendingIfEmpty()
        input.setText(client.draft)
        input.setSelection(input.length())
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) = client.saveDraft(s.toString())
            override fun afterTextChanged(s: Editable?) {}
        })
        if (client.pendingSeparate && !client.inFlight) showPendingError("上一条消息尚未确认送达")
        showFile()
        updater.checkOnLaunch()
    }

    private fun modeSwitch(): LinearLayout {
        val group = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(48)
            background = android.graphics.drawable.InsetDrawable(shape(0xfff0edf3.toInt(), 18), 0, dp(6), 0, dp(6))
            setPadding(dp(3), 0, dp(3), 0)
        }
        fun select(target: FrameLayout) {
            val selected = target.tag == client.replyMode
            target.isSelected = selected
            val label = target.getChildAt(0) as TextView
            label.setTextColor(if (selected) 0xff49335d.toInt() else 0xff696370.toInt())
            label.typeface = Typeface.create(if (selected) "sans-serif-medium" else "sans-serif", Typeface.NORMAL)
            label.background = shape(if (selected) 0xffe1d2ef.toInt() else Color.TRANSPARENT, 15)
        }
        for ((mode, name) in listOf("chat" to "聊天", "work" to "工作")) {
            val label = text(name, 13f).apply {
                gravity = Gravity.CENTER
                setSingleLine()
                minimumWidth = dp(48)
                minimumHeight = dp(28)
                setPadding(dp(5), dp(2), dp(5), dp(2))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            val target = FrameLayout(this).apply {
                tag = mode
                minimumHeight = dp(48)
                setPadding(0, dp(8), 0, dp(8))
                if (android.os.Build.VERSION.SDK_INT >= 26) defaultFocusHighlightEnabled = false
                isFocusable = true
                contentDescription = name + "模式"
                addView(label, FrameLayout.LayoutParams(wrap, wrap, Gravity.CENTER))
                val mask = android.graphics.drawable.LayerDrawable(arrayOf(shape(Color.WHITE, 15)))
                mask.setLayerGravity(0, Gravity.CENTER)
                foreground = RippleDrawable(ColorStateList.valueOf(0x3377558f), null, mask)
                label.addOnLayoutChangeListener { _, l, t, r, b, _, _, _, _ ->
                    mask.setLayerSize(0, r - l, b - t)
                    // LayerDrawable positions its child when the bounds change.
                    mask.setBounds(0, 0, 0, 0)
                    mask.setBounds(0, 0, width, height)
                }
                setOnClickListener {
                    if (client.replyMode != mode) {
                        client.replyMode = mode
                        for (i in 0 until group.childCount) select(group.getChildAt(i) as FrameLayout)
                        contextEpoch++
                        refreshContext()
                    }
                }
            }
            select(target)
            group.addView(target, wrap, wrap)
        }
        return group
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
            val radius = dp(28).toFloat()
            background = GradientDrawable().apply {
                setColor(paper)
                cornerRadii = floatArrayOf(0f, 0f, radius, radius, radius, radius, 0f, 0f)
            }
            setPadding(dp(18), dp(14), dp(18), dp(20))
        }
        ViewCompat.setAccessibilityPaneTitle(panel, "侧边栏")
        val heading = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        heading.addView(mark(), dp(36), dp(36))
        heading.addView(text(getString(R.string.app_name), 20f).apply { typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) },
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
        fun drawerItem(label: String, icon: Int, destination: Class<out Activity>) {
            val item = text(label, 16f, ink).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(16), 0, dp(12), 0)
                setCompoundDrawablesWithIntrinsicBounds(icon, 0, 0, 0)
                compoundDrawablePadding = dp(12)
                background = RippleDrawable(ColorStateList.valueOf(0x22694D83), shape(paper, 16), null)
                isFocusable = true
                setOnClickListener {
                    dialog.dismiss()
                    startActivity(Intent(this@ChatActivity, destination))
                }
            }
            panel.addView(item, LinearLayout.LayoutParams(match, dp(48)).apply { topMargin = dp(6) })
        }
        drawerItem("经期管理", R.drawable.nav_cycle, CycleActivity::class.java)
        drawerItem("设置", R.drawable.nav_settings, SettingsActivity::class.java)
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

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        attachmentActions.awaitingPermission?.let { out.putString("savingAttachment", it.toString()) }
    }

    override fun onRequestPermissionsResult(request: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(request, permissions, results)
        attachmentActions.onPermissionResult(request, results)
    }

    override fun onConfigurationChanged(config: android.content.res.Configuration) {
        super.onConfigurationChanged(config)
        drawer?.window?.setLayout(drawerWidth(), match)
    }

    private fun showFile() {
        val files = client.attachments
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
        setOnLongClickListener { attachmentActions.showMenu(file); true }
        ImagePreviews.display(this, image, file.getString("name"))
    }

    private fun documentTile(file: JSONObject, draft: Boolean) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        background = shape(if (draft) paper else Color.WHITE, 14, true)
        setPadding(dp(10), dp(6), dp(if (draft) 30 else 10), dp(6))
        contentDescription = "打开附件，" + file.getString("name")
        isFocusable = true
        setOnClickListener { openFile(file) }
        setOnLongClickListener { attachmentActions.showMenu(file); true }
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

    private fun displayUsage(value: ContextUsage) {
        if (contextMeter.usage == value) return
        client.rememberUsage(value)
        contextMeter.update(value)
    }

    private fun refreshContext() {
        if (readingContext || !versionCurrent || generating) return
        val epoch = contextEpoch
        readingContext = true
        client.readContext(client.replyMode) { value ->
            readingContext = false
            if (epoch == contextEpoch) {
                if (value != null) displayUsage(value)
            } else if (!generating) {
                refreshContext()
            }
        }
    }

    private fun showContext() {
        val usage = contextMeter.usage
        val detail = usage?.detail ?: if (readingContext) "正在读取用量…" else "暂时无法读取用量"
        val scope = if (generating) "显示最近一次成功同步的用量，收到本轮计数后更新。" else
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
        if (versionCurrent) {
            if (client.inFlight && !generating) watchSend()
            else if (!generating) renderHistory()
            chat.removeCallbacks(refreshPhrases)
            refreshPhrases.run()
            startInbox()
            refreshContext()
            toBottom()
            return
        }
        ScheduledInbox.suspendPolling(this)
        gateProgress.visibility = if (state == UpdateState.Checking || state is UpdateState.Preparing) View.VISIBLE else View.GONE
        gateDownload.visibility = if (state is UpdateState.Downloading) View.VISIBLE else View.GONE
        gateAction.visibility = View.GONE
        gateDetail.visibility = View.VISIBLE
        when (state) {
            UpdateState.Checking -> {
                gateTitle.text = "正在确认版本"
                gateDetail.visibility = View.GONE
            }
            is UpdateState.Preparing -> {
                gateTitle.text = state.message
                gateDetail.visibility = View.GONE
            }
            is UpdateState.Downloading -> {
                gateTitle.text = "正在更新到 " + state.name
                val percent = (state.received * 100 / state.total).toInt()
                gateDownload.progress = percent
                gateDetail.text = String.format(java.util.Locale.ROOT, "%s · %d%%\n%.1f / %.1f MB",
                    state.mode, percent, state.received / 1e6, state.total / 1e6)
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
            UpdateState.Occupied -> {
                gateTitle.text = "这个 Piggy 已连接其他安装"
                gateDetail.text = "请使用原来的 Piggy。如已换机或重装，请联系管理员。"
                gateButton("重新连接") { updater.check() }
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
        if (requestCode == 302 && resultCode != RESULT_OK) {
            selecting = false
            controls()
        }
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
                if (client.pendingSeparate && !generating) {
                    if (!error.isNullOrEmpty()) Toast.makeText(this, error, Toast.LENGTH_LONG).show()
                } else {
                    sendError.text = error
                    sendError.visibility = if (error.isNullOrEmpty()) View.GONE else View.VISIBLE
                }
            }
        }
        if (requestCode == AppUpdater.PERMISSION_REQUEST && android.os.Build.VERSION.SDK_INT >= 26 &&
            packageManager.canRequestPackageInstalls()) updater.install()
    }

    private fun bubble(value: String, user: Boolean, files: List<JSONObject> = emptyList(), legacyLabel: String = "", stickerId: String = ""): TextView {
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
        }
        fun LinearLayout.addAttachments(batch: List<JSONObject>) {
            var index = 0
            while (index < batch.size) {
                val file = batch[index++]
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
                    val next = batch.getOrNull(index)
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
        fun messageView() = text("", 16f, ink).apply {
            setTextIsSelectable(true)
            movementMethod = TableAwareMovementMethod.create()
            setLinkTextColor(plum)
            setPadding(dp(17), dp(13), dp(17), dp(13))
            setLineSpacing(dp(2).toFloat(), 1f)
            if (files.isEmpty()) background = shape(if (user) lavender else Color.WHITE, 20, !user)
            maxWidth = (resources.displayMetrics.widthPixels * .81f).toInt()
        }
        val view = messageView()
        if (user || files.isEmpty()) {
            group.addAttachments(files)
            if (value.isNotEmpty()) renderMessage(view, value)
            if (value.isNotEmpty() || (files.isEmpty() && stickerId.isEmpty())) group.addView(view, if (files.isEmpty()) wrap else match, wrap)
        } else {
            val anchors = replyPositions(value, files.map { it.optInt("inlineAt", -1) })
            var cursor = 0
            fun addProse(end: Int) {
                val part = value.substring(cursor, end).trim('\n','\r')
                if (part.isNotBlank()) group.addView(messageView().also { renderMessage(it, part) }, match, wrap)
                cursor = end
            }
            for ((offset, items) in files.indices.groupBy { anchors[it] }.toSortedMap()) {
                addProse(offset)
                group.addAttachments(items.map { files[it] })
            }
            addProse(value.length)
        }
        if (stickerId.matches(PiggyClient.STICKER_ID)) {
            val file = JSONObject().put("key",stickerId).put("stickerId",stickerId).put("id",stickerId)
                .put("name","Piggy-"+stickerId.take(8)+".png").put("mime","image/png")
                .put("uri",PiggyServer.url("/mobile/stickers/"+stickerId).toString())
            val sticker = ImageView(this).apply {
                contentDescription = "Piggy 表情"
                isFocusable = true
                scaleType = ImageView.ScaleType.FIT_CENTER
                setOnClickListener { openFile(file) }
                setOnLongClickListener { attachmentActions.showMenu(file); true }
            }
            row.addView(sticker, LinearLayout.LayoutParams(dp(132),dp(132)).apply { topMargin=dp(3) })
            client.fetchReply(file) { uri, error ->
                if (!isDestroyed && uri != null) ImagePreviews.display(sticker,uri,"Piggy 表情")
                else if (uri == null && !isDestroyed) {
                    sticker.setImageResource(R.drawable.piggy_portrait)
                    sticker.contentDescription = error ?: "表情暂时无法加载"
                }
            }
        }
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
        val enabled = versionCurrent && !generating && !selecting && !client.pendingSeparate
        attach.isEnabled = versionCurrent && !selecting
        send.isEnabled = enabled
        send.alpha = if (enabled) 1f else .55f
        input.isEnabled = versionCurrent
    }
    private fun showPendingError(error: String) {
        sendError.text = "$error · 点此处理上一条消息"
        sendError.visibility = View.VISIBLE
        sendError.setOnClickListener {
            if (!client.pendingSeparate || generating || selecting || !versionCurrent) return@setOnClickListener
            AlertDialog.Builder(this).setTitle("上一条消息")
                .setMessage((listOf(client.pendingDraft) + client.pendingAttachments.map { it.optString("name") })
                    .filter { it.isNotBlank() }.joinToString("\n"))
                .setPositiveButton("重试") { _, _ -> submit(true) }
                .setNegativeButton("放弃上一条") { _, _ ->
                    client.dismissPending()
                    sendError.visibility = View.GONE
                    showFile()
                    controls()
                }.setNeutralButton("返回", null).show()
        }
    }

    private fun submit(retry: Boolean = false) {
        val draft = if (retry) client.pendingDraft else input.text.toString().trim()
        val files = if (retry) client.pendingAttachments else client.attachments
        val message = draft.ifEmpty {
            when (files.size) { 0 -> ""; 1 -> "请帮我看看这个文件。"; else -> "请帮我看看这些文件。" }
        }
        if (message.isEmpty() || generating || !versionCurrent || (!retry && !send.isEnabled)) return
        if (!client.beginSend(message, draft, retry)) {
            sendError.text = "无法在本机保存待发送消息"
            sendError.visibility = View.VISIBLE
            return
        }
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
        if (!retry) input.setText("")
        watchSend()
        if (generating) ReplyNotifications.askOnce(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == ReplyNotifications.OPEN_REPLY) toBottom()
    }

    private fun renderHistory() {
        transcript.removeViews(1, transcript.childCount - 1)
        empty.visibility = View.VISIBLE
        renderedInbox = client.inboxCursor
        val recent = client.recent
        for (i in 0 until recent.length()) {
            val turn = recent.getJSONObject(i)
            if (!turn.optBoolean("proactive")) bubble(turn.getString("text"), true, PiggyClient.turnFiles(turn), turn.optString("filename"))
            bubble(turn.getString("answer"), false, client.replyFiles(turn),stickerId=turn.optString("stickerId"))
        }
    }

    private var replyWait: ReplyWait? = null
    private var chatVisible = false
    private var renderedInbox = -1L
    private val inboxUpdated: () -> Unit = {
        if (chatVisible && versionCurrent && !generating && !client.inFlight && renderedInbox != client.inboxCursor) {
            renderHistory()
            toBottom()
            refreshContext()
        }
    }
    private val inboxRejected: () -> Unit = { updater.check() }

    private fun startInbox() {
        if (!versionCurrent || !chatVisible) return
        ReplyNotifications.askOnce(this)
        ScheduledInbox.start(this, inboxUpdated, inboxRejected)
        inboxUpdated()
    }
    private val refreshPhrases = object : Runnable {
        override fun run() {
            if (chatVisible) chat.postDelayed(this, ReplyPhrases.refresh(this@ChatActivity))
        }
    }
    override fun onStart() {
        super.onStart()
        chatVisible = true
        ReplyNotifications.chatStarted(this)
        if (versionCurrent) refreshPhrases.run()
        startInbox()
        replyWait?.visible(true)
    }
    override fun onStop() {
        chatVisible = false
        ReplyNotifications.chatStopped()
        chat.removeCallbacks(refreshPhrases)
        ScheduledInbox.hide(inboxUpdated)
        replyWait?.visible(false)
        super.onStop()
    }

    private var sendListener: ChatSendService.Listener? = null

    private fun watchSend() {
        val id = client.pendingId ?: run { client.endFlight(); showPendingError("请重试上一条消息"); return }
        generating = true
        contextEpoch++
        controls()
        sendError.visibility = View.GONE
        showFile()
        val files = client.pendingAttachments
        bubble(client.pendingDraft, true, files)
        val reply = bubble("", false)
        val indicator = ReplyWait(reply)
        replyWait = indicator
        indicator.visible(chatVisible)
        indicator.show(if (files.isEmpty()) ReplyPhrases.WAITING else "正在发送附件…", false)
        toBottom()
        var source: CharSequence = ""
        var scheduled = false
        val render = Runnable {
            scheduled = false
            val follow = !scroll.canScrollVertically(1)
            renderMessage(reply, source.toString())
            if (follow) toBottom()
        }
        val observer = object : ChatSendService.Listener {
            override fun progress(partial: CharSequence, status: String, usage: ContextUsage?) {
                source = partial
                indicator.show(status, partial.isNotEmpty())
                usage?.let(::displayUsage)
                if (!scheduled) { scheduled = true; reply.postDelayed(render, 100) }
            }
            override fun finished(error: String?, outdated: Boolean) {
                indicator.visible(false)
                replyWait = null
                reply.removeCallbacks(render)
                ChatSendService.listener = null
                sendListener = null
                val follow = !scroll.canScrollVertically(1)
                renderHistory()
                if (error == null) {
                    if (follow) toBottom()
                } else {
                    sendError.text = error
                    sendError.visibility = View.VISIBLE
                    if (!selecting) client.restorePendingIfEmpty()
                    if (client.pendingSeparate) showPendingError(error)
                    else {
                        input.setText(client.draft)
                        input.setSelection(input.length())
                    }
                }
                generating = false
                refreshContext()
                showFile()
                controls()
                if (outdated) updater.check()
            }
        }
        sendListener = observer
        ChatSendService.listener = observer
        try {
            ChatSendService.launch(this, id)
        } catch (error: IllegalStateException) {
            client.endFlight()
            observer.finished("发送服务未能启动，请重试", false)
        }
    }

    override fun onDestroy() {
        if (ChatSendService.listener === sendListener) ChatSendService.listener = null
        drawer?.dismiss()
        updater.close()
        client.close()
        super.onDestroy()
    }
}

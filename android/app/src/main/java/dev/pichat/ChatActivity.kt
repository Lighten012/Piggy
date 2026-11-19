package dev.pichat

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.InputFilter
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.*

class ChatActivity : Activity() {
    private lateinit var transcript: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var input: EditText
    private lateinit var send: Button
    private lateinit var reset: Button
    private lateinit var agent: MobileAgent
    private var pendingResponse: TextView? = null
    private var pendingDraft = ""
    private val ink = Color.rgb(26, 45, 40)
    private val paper = Color.rgb(249, 249, 245)
    private val green = Color.rgb(31, 91, 74)
    private fun dp(n: Int) = (resources.displayMetrics.density * n + .5f).toInt()
    private fun shape(color: Int, radius: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius).toFloat()
    }
    private fun label(value: String, size: Float) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(ink)
    }
    private fun button(value: String) = Button(this).apply {
        text = value
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = shape(green, 16)
        minWidth = 0
        minimumWidth = 0
        setPadding(dp(14), 0, dp(14), 0)
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(paper)
            isFocusableInTouchMode = true
            setPadding(dp(18), dp(12), dp(18), dp(12))
        }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        val title = label("Piggy", 31f).apply { typeface = Typeface.create("serif", Typeface.BOLD) }
        header.addView(title, LinearLayout.LayoutParams(0, -2, 1f))
        reset = button("新对话").apply {
            background = shape(Color.rgb(227, 237, 229), 16)
            setTextColor(green)
            setOnClickListener {
                agent.reset()
                transcript.removeAllViews()
                input.setText("")
                input.requestFocus()
            }
        }
        header.addView(reset, LinearLayout.LayoutParams(-2, dp(46)))
        root.addView(header)
        transcript = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(24), 0, dp(12))
        }
        scroll = ScrollView(this).apply { addView(transcript) }
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        val composer = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        input = EditText(this).apply {
            hint = "输入消息…"
            textSize = 17f
            setTextColor(ink)
            background = shape(Color.WHITE, 16)
            filters = arrayOf(InputFilter.LengthFilter(8000))
            maxLines = 4
            setPadding(dp(14), dp(10), dp(14), dp(10))
        }
        composer.addView(input, LinearLayout.LayoutParams(0, -2, 1f))
        send = button("发送").apply { setOnClickListener { submit() } }
        composer.addView(send, LinearLayout.LayoutParams(-2, dp(48)).apply { leftMargin = dp(8) })
        root.addView(composer)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
            View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(paper)
            fitsSystemWindows = true
            addView(root)
        })
        controls(false)
        agent = MobileAgent(this, onReady = { controls(true) }, onDelta = { delta ->
            pendingResponse?.append(delta)
            toBottom()
        }, onFinished = { error ->
            if (error.isNotEmpty()) {
                pendingResponse?.text = error
                input.setText(pendingDraft)
                input.setSelection(input.length())
            }
            pendingResponse = null
            pendingDraft = ""
            controls(true)
        }, onInitFailure = {
            controls(false)
            bubble("无法启动内置 Pi 运行时，请重新打开应用。", false)
        })

    }

    private fun bubble(text: String, user: Boolean): TextView {
        val view = label(text, 17f).apply {
            setTextIsSelectable(true)
            setPadding(dp(15), dp(12), dp(15), dp(12))
            background = shape(if (user) Color.rgb(222, 238, 226) else Color.WHITE, 16)
            maxWidth = (resources.displayMetrics.widthPixels * .82).toInt()
        }
        transcript.addView(view, LinearLayout.LayoutParams(-2, -2).apply {
            gravity = if (user) Gravity.END else Gravity.START
            bottomMargin = dp(12)
        })
        toBottom()
        return view
    }

    private fun toBottom() = scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }

    private fun submit() {
        val message = input.text.toString().trim()
        if (message.isEmpty() || !send.isEnabled) return
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
        controls(false)
        pendingDraft = message
        input.setText("")
        bubble(message, true)
        pendingResponse = bubble("", false).apply { hint = "正在回复…" }
        agent.prompt(message)
    }

    private fun controls(enabled: Boolean) {
        send.isEnabled = enabled
        reset.isEnabled = enabled
        input.isEnabled = enabled
    }

    override fun onDestroy() {
        agent.close()
        super.onDestroy()
    }
}

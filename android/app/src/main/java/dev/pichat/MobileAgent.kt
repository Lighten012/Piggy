package dev.pichat

import android.app.Activity
import com.caoccao.javet.annotations.V8Function
import com.caoccao.javet.enums.V8AwaitMode
import com.caoccao.javet.interop.NodeRuntime
import com.caoccao.javet.interop.V8Host
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import java.net.URL
import java.net.UnknownHostException
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLException

class MobileAgent(
    private val activity: Activity,
    private val onReady: () -> Unit,
    private val onDelta: (String) -> Unit,
    private val onFinished: (String) -> Unit,
    private val onInitFailure: () -> Unit
) {
    private val engineThread = Executors.newSingleThreadScheduledExecutor()
    private val networkThread = Executors.newSingleThreadExecutor()
    private var engine: NodeRuntime? = null
    private var pending = false
    @Volatile private var closed = false
    @Volatile private var connection: HttpsURLConnection? = null

    init {
        engineThread.execute {
            try {
                val runtime = V8Host.getNodeI18nInstance().createV8Runtime<NodeRuntime>()
                engine = runtime
                runtime.createV8ValueObject().use { bridge ->
                    bridge.bind(Bridge())
                    runtime.globalObject.use { it.set("PiggyNative", bridge) }
                }
                val script = activity.assets.open("piggy.js").bufferedReader().use { it.readText() }
                runtime.getExecutor(script).executeVoid()
                runtime.await(V8AwaitMode.RunNoWait)
            } catch (e: Exception) {
                android.util.Log.w("Piggy", "Engine initialization: " + e.javaClass.simpleName + " " + e.message.orEmpty().lineSequence().first().take(180))
                ui(onInitFailure)
            } catch (e: LinkageError) {
                ui(onInitFailure)
            }
        }
    }

    fun prompt(text: String) = dispatch {
        pending = true
        it.getExecutor("PiggyAgent.prompt(" + JSONObject.quote(text) + ")").executeVoid()
        pump()
    }
    fun reset() = dispatch { it.getExecutor("PiggyAgent.reset()").executeVoid() }

    // Node timers and promises run on the same thread as the embedded runtime.
    private fun pump() {
        if (!pending || closed) return
        engine?.await(V8AwaitMode.RunNoWait)
        if (pending && !closed) engineThread.schedule({ pump() }, 20, TimeUnit.MILLISECONDS)
    }
    private fun dispatch(action: (NodeRuntime) -> Unit) {
        synchronized(this) {
            if (!closed) engineThread.execute {
                if (!closed) try {
                    engine?.let(action)
                } catch (e: Exception) {
                    pending = false
                    ui { onFinished("Pi 执行失败，请新建对话后重试") }
                }
            }
        }
    }
    private fun ui(action: () -> Unit) = activity.runOnUiThread { if (!closed) action() }
    private fun event(id: Int, kind: String, value: String = "") = dispatch {
        val js = "PiggyAgent.network($id," + JSONObject.quote(kind) + "," + JSONObject.quote(value) + ")"
        it.getExecutor(js).executeVoid()
    }
    inner class Bridge {
        @V8Function fun ready() = ui(onReady)
        @V8Function fun delta(text: String) = ui { onDelta(text) }
        @V8Function fun finished(error: String) {
            pending = false
            ui { onFinished(error) }
        }
        @V8Function fun request(id: Int, body: String) {
            synchronized(this@MobileAgent) {
                if (!closed) networkThread.execute { stream(id, body) }
            }
        }
    }
    private fun stream(id: Int, body: String) {
        if (closed) return
        val http = URL("https://api.openai.com/v1/chat/completions").openConnection() as HttpsURLConnection
        connection = http
        try {
            http.requestMethod = "POST"
            http.instanceFollowRedirects = false
            http.connectTimeout = 20000
            http.readTimeout = 90000
            http.doOutput = true
            val key = activity.assets.open("personal.key").bufferedReader().use { it.readText().trim() }
            http.setRequestProperty("Authorization", "Bearer $key")
            http.setRequestProperty("Content-Type", "application/json")
            http.setRequestProperty("Accept", "text/event-stream")
            val bytes = body.toByteArray(Charsets.UTF_8)
            http.setFixedLengthStreamingMode(bytes.size)
            http.outputStream.use { it.write(bytes) }
            val status = http.responseCode
            if (status !in 200..299) {
                event(id, "error", "OpenAI 返回 HTTP $status，请检查密钥、额度及网络")
                return
            }
            event(id, "headers")
            var sawEnd = false
            http.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                for (line in lines) {
                    if (closed) return
                    event(id, "chunk", line + "\n")
                    if (line.trim() == "data: [DONE]") sawEnd = true
                }
            }
            if (sawEnd) event(id, "end") else event(id, "error", "回复传输中断，请重试")
        } catch (e: Exception) {
            val detail = when (e) {
                is SSLException -> "无法验证 OpenAI 的 HTTPS 连接"
                is UnknownHostException -> "无法解析 OpenAI 地址，请检查网络"
                else -> "连接 OpenAI 失败，请检查网络后重试"
            }
            event(id, "error", detail)
        } finally {
            http.disconnect()
            connection = null
        }
    }
    @Synchronized fun close() {
        if (closed) return
        closed = true
        connection?.disconnect()
        networkThread.shutdownNow()
        engineThread.execute {
            pending = false
            engine?.close()
        }
        engineThread.shutdown()
    }
}

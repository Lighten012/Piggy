package dev.pichat

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

internal object CycleSync {
    private val worker = Executors.newSingleThreadExecutor()
    private val networkLock = Any()
    private val main = Handler(Looper.getMainLooper())
    private var observer: ((String?) -> Unit)? = null

    @Synchronized fun session(context: Context): String {
        val prefs = context.getSharedPreferences("conversation", Context.MODE_PRIVATE)
        return prefs.getString("session", null) ?: UUID.randomUUID().toString().also {
            check(prefs.edit().putString("session", it).commit())
        }
    }

    fun iso(day: Int): String = CivilDay.calendar(day).run {
        String.format(Locale.ROOT, "%04d-%02d-%02d", get(Calendar.YEAR), get(Calendar.MONTH) + 1, get(Calendar.DATE))
    }
    private fun day(date: String): Int {
        val parts = date.split("-")
        return CivilDay.of(parts[0].toInt(), parts[1].toInt(), parts[2].toInt())
    }
    private fun queue(p: SharedPreferences) = JSONArray(p.getString("pending", "[]"))
    private fun prefs(context: Context): SharedPreferences {
        val p = context.getSharedPreferences("cycle_calendar", Context.MODE_PRIVATE)
        if (!p.contains("seq")) {
            val pending = JSONArray()
            fun add(op: JSONObject) { pending.put(op.put("seq", pending.length() + 1)) }
            if (p.contains("length")) add(settings(p.getInt("length", 28), p.getInt("duration", 5)))
            p.getStringSet("starts", emptySet()).orEmpty().map { it.toInt() }.sorted().forEach { start ->
                val op = record("period", start)
                if (p.contains("end_$start")) op.put("end", iso(p.getInt("end_$start", start)))
                add(op)
            }
            check(p.edit().putLong("seq", pending.length().toLong()).putString("pending", pending.toString()).commit())
        }
        return p
    }
    fun record(kind: String, start: Int) = JSONObject().put("kind", kind).put("start", iso(start))
    fun settings(length: Int, duration: Int) = JSONObject().put("kind", "settings").put("length", length).put("duration", duration)

    // Queue and visible local edit are committed together, even if the app exits offline.
    @Synchronized fun edit(context: Context, op: JSONObject, update: (SharedPreferences.Editor) -> Unit) {
        val p = prefs(context)
        val seq = p.getLong("seq", 0) + 1
        val editor = p.edit().putLong("seq", seq).putString("pending", queue(p).put(op.put("seq", seq)).toString())
        update(editor)
        check(editor.commit())
        refresh(context)
    }
    fun observe(listener: ((String?) -> Unit)?) { observer = listener }
    fun afterChat(context: Context) { main.post { if (observer != null) refresh(context) } }
    fun refresh(context: Context) {
        val app = context.applicationContext
        worker.execute {
            val status = runCatching { sync(app, false) }.exceptionOrNull()?.localizedMessage
            main.post { observer?.invoke(status) }
        }
    }
    fun sync(context: Context, onlyPending: Boolean) {
        synchronized(networkLock) {
            var problem: String? = null
            do {
                val batch = synchronized(this) {
                    val pending = queue(prefs(context))
                    if (onlyPending && pending.length() == 0) return
                    JSONArray().apply { for (i in 0 until minOf(100, pending.length())) put(pending.get(i)) }
                }
                val request = JSONObject().put("session", session(context)).put("timeZone", TimeZone.getDefault().id).put("changes", batch)
                val http = PiggyServer.url("/mobile/cycle").openConnection() as HttpsURLConnection
                val state = try {
                    http.requestMethod = "POST"
                    http.doOutput = true
                    http.connectTimeout = 10000
                    http.readTimeout = 15000
                    http.setRequestProperty("X-Piggy-Version-Code", BuildConfig.VERSION_CODE.toString())
                    http.setRequestProperty("Content-Type", "application/json")
                    http.outputStream.use { it.write(request.toString().toByteArray()) }
                    if (http.responseCode !in 200..299) throw IOException("日历尚未同步，请稍后重试")
                    JSONObject(http.inputStream.bufferedReader().use { it.readText() })
                } finally { http.disconnect() }
                val errors = state.getJSONArray("errors")
                if (errors.length() > 0) problem = errors.getString(0)
                val more = synchronized(this) {
                    val p = prefs(context)
                    val pending = queue(p)
                    val remaining = JSONArray()
                    for (i in 0 until pending.length()) {
                        val op = pending.getJSONObject(i)
                        if (op.getLong("seq") > state.getLong("through")) remaining.put(op)
                    }
                    val editor = p.edit().putString("pending", remaining.toString())
                    if (remaining.length() == 0) {
                        val starts = mutableSetOf<String>()
                        p.all.keys.filter { it.startsWith("end_") }.forEach { editor.remove(it) }
                        val periods = state.getJSONArray("periods")
                        for (i in 0 until periods.length()) {
                            val period = periods.getJSONObject(i)
                            val start = day(period.getString("start"))
                            starts.add(start.toString())
                            if (!period.isNull("end")) editor.putInt("end_$start", day(period.getString("end")))
                        }
                        editor.putStringSet("starts", starts).putInt("length", state.getInt("length")).putInt("duration", state.getInt("duration"))
                    }
                    check(editor.commit())
                    remaining.length() > 0
                }
            } while (more)
            if (problem != null) throw IOException(problem)
        }
    }
}

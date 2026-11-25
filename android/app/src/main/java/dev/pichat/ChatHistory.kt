package dev.pichat

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

/** Append-only local transcript. Row IDs are contiguous, so page reads use the primary key. */
internal class ChatHistory private constructor(context: Context) :
    SQLiteOpenHelper(context, "chat-history.db", null, 1) {
    companion object {
        const val PAGE_SIZE = 24
        private var instance: ChatHistory? = null

        @Synchronized fun get(context: Context): ChatHistory {
            instance?.let { return it }
            val history = ChatHistory(context.applicationContext)
            val prefs = context.getSharedPreferences("conversation", Context.MODE_PRIVATE)
            prefs.getString("recent", null)?.let { saved ->
                val rows = JSONArray(saved)
                val db = history.writableDatabase
                db.beginTransaction()
                try {
                    for (i in 0 until rows.length()) history.append(rows.getJSONObject(i), "legacy:$i")
                    db.setTransactionSuccessful()
                } finally { db.endTransaction() }
                check(prefs.edit().remove("recent").commit())
            }
            instance = history
            return history
        }
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE turns(seq INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, body TEXT NOT NULL)")
        db.execSQL("CREATE TABLE file_refs(uri TEXT PRIMARY KEY NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) = Unit

    fun append(turn: JSONObject, fallback: String? = null) {
        val token = when {
            turn.optBoolean("proactive") && turn.has("id") -> "inbox:" + turn.getLong("id")
            turn.optString("request").isNotEmpty() -> turn.getString("request")
            else -> requireNotNull(fallback)
        }
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.execSQL("INSERT OR IGNORE INTO turns(token, body) VALUES(?,?)", arrayOf(token, turn.toString()))
            for (file in PiggyClient.turnFiles(turn)) {
                val uri = file.optString("uri")
                if (uri.isNotEmpty()) db.execSQL("INSERT OR IGNORE INTO file_refs VALUES(?)", arrayOf(uri))
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    fun size(): Int = readableDatabase.rawQuery("SELECT COALESCE(MAX(seq),0) FROM turns", null).use {
        it.moveToFirst(); it.getInt(0)
    }

    fun page(start: Int): List<JSONObject> = readableDatabase.rawQuery(
        "SELECT body FROM turns WHERE seq>? ORDER BY seq LIMIT $PAGE_SIZE", arrayOf(start.toString())
    ).use { rows -> buildList { while (rows.moveToNext()) add(JSONObject(rows.getString(0))) } }

    fun byRequest(id: String): JSONObject? = readableDatabase.rawQuery(
        "SELECT body FROM turns WHERE token=?", arrayOf(id)
    ).use { if (it.moveToFirst()) JSONObject(it.getString(0)) else null }

    fun references(uri: String): Boolean = readableDatabase.rawQuery(
        "SELECT 1 FROM file_refs WHERE uri=?", arrayOf(uri)
    ).use { it.moveToFirst() }
}

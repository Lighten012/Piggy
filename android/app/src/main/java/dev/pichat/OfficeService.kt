package dev.pichat

import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.*
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import org.libreoffice.kit.Document
import org.libreoffice.kit.LibreOfficeKit
import org.libreoffice.kit.Office

/** Each open preview owns one native document. All JNI calls run on the same thread. */
class OfficeService : Service() {
    private val thread = HandlerThread("office-reader")
    private lateinit var messenger: Messenger
    private var office: Office? = null
    private val documents = mutableMapOf<String, OpenDocument>()
    private var pixels = ByteBuffer.allocateDirect(0)

    private class OpenDocument(val doc: Document) {
        val kind = doc.documentTypeNative
        // Writer is a continuous canvas; its page rectangles locate individual
        // pages. Calc and Impress expose a separate coordinate system per part.
        val pages =
            if (kind == 0)
                doc.partPageRectangles.orEmpty().split(';').mapNotNull { entry ->
                    val rect = entry.split(',').mapNotNull { it.trim().toIntOrNull() }
                    if (rect.size == 4 && rect[2] > 0 && rect[3] > 0)
                        Rect(rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3])
                    else null
                }
            else emptyList()
        val count = if (kind == 0) maxOf(1, pages.size) else maxOf(1, doc.parts)
        var active = -1

        fun select(index: Int) {
            require(index in 0 until count)
            if (kind != 0 && active != index) doc.setPart(index)
            active = index
        }

        fun area(index: Int): Rect =
            pages.getOrNull(index)
                ?: Rect(
                    0,
                    0,
                    doc.documentWidth.coerceIn(1, Int.MAX_VALUE.toLong()).toInt(),
                    doc.documentHeight.coerceIn(1, Int.MAX_VALUE.toLong()).toInt(),
                )
    }

    override fun onCreate() {
        super.onCreate()
        thread.start()
        messenger =
            Messenger(
                Handler(thread.looper) { msg ->
                    val reply = Message.obtain()
                    try {
                        reply.data = handle(msg.what, msg.data)
                    } catch (e: Exception) {
                        reply.data.putString("error", e.localizedMessage ?: "文档无法读取")
                    } catch (e: LinkageError) {
                        reply.data.putString("error", "本机文档引擎无法启动")
                    }
                    try {
                        msg.replyTo?.send(reply)
                    } catch (_: RemoteException) {}
                    true
                }
            )
    }

    private fun handle(command: Int, data: Bundle): Bundle {
        val id = requireNotNull(data.getString("session"))
        val result = Bundle()
        if (command == OfficeReader.CLOSE) {
            documents.remove(id)?.doc?.destroy()
            return result
        }
        if (command == OfficeReader.OPEN) {
            val path = requireNotNull(data.getString("path"))
            val handle = engine().documentLoadNative(path) ?: throw IOException("无法读取原件，文件可能已加密或损坏")
            val doc = Document(handle)
            try {
                doc.initializeForRendering()
                val open = OpenDocument(doc)
                documents[id] = open
                result.putInt("count", open.count)
                result.putInt("kind", open.kind)
            } catch (e: Exception) {
                doc.destroy()
                throw e
            }
            return result
        }
        val open = documents.getValue(id)
        if (command == OfficeReader.SHEETS) {
            val offset = data.getInt("offset")
            require(open.kind == 1 && offset in 0 until open.count)
            result.putStringArray(
                "names",
                (offset until minOf(offset + 64, open.count))
                    .map { open.doc.getPartName(it).orEmpty().ifEmpty { "工作表 ${it+1}" } }
                    .toTypedArray(),
            )
            return result
        }
        val part = data.getInt("part")
        open.select(part)
        val region = open.area(part)
        if (command == OfficeReader.PAGE) {
            result.putInt("width", region.width())
            result.putInt("height", region.height())
            if (open.kind == 1) result.putString("name", open.doc.getPartName(part))
            return result
        }
        require(command == OfficeReader.PAINT)
        val w = data.getInt("w")
        val h = data.getInt("h")
        require(w > 0 && h > 0 && w.toLong() * h <= 2400000)
        val bytes = w * h * 4
        if (pixels.capacity() < bytes) pixels = ByteBuffer.allocateDirect(bytes)
        pixels.clear()
        open.doc.paintTileNative(
            pixels,
            w,
            h,
            region.left + data.getInt("x"),
            region.top + data.getInt("y"),
            data.getInt("dw"),
            data.getInt("dh"),
        )
        val image = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        image.copyPixelsFromBuffer(pixels)
        result.putParcelable("pixels", image)
        return result
    }

    private fun engine(): Office {
        office?.let {
            return it
        }
        OfficeRuntime.load(this)
        val root = File(filesDir, "office-profile").apply { mkdirs() }
        val profileCache = File(root, "cache").apply { mkdirs() }
        fun unpack(path: String, dest: File) {
            val children = assets.list(path).orEmpty()
            if (children.isEmpty()) {
                assets.open(path).use { input -> dest.outputStream().use { input.copyTo(it) } }
            } else {
                dest.mkdirs()
                for (child in children) unpack(path + "/" + child, File(dest, child))
            }
        }
        val marker = File(root, "ready-" + OfficeRuntime.version)
        if (!marker.isFile) {
            unpack("unpack", root)
            marker.writeText("1")
        }
        LibreOfficeKit.putenv("SAL_DISABLE_MACROS=1")
        LibreOfficeKit.putenv("SAL_LOK_OPTIONS=compact_fonts")
        check(
            LibreOfficeKit.initializeNative(
                root.path,
                profileCache.path,
                applicationInfo.sourceDir,
                assets,
            )
        )
        return Office(checkNotNull(LibreOfficeKit.getLibreOfficeKitHandle())).also { office = it }
    }

    override fun onBind(intent: Intent): IBinder = messenger.binder

    override fun onDestroy() {
        super.onDestroy()
        Process.killProcess(Process.myPid())
    }
}

package dev.pichat

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors

internal class AttachmentSaver(private val activity: Activity, private val client: PiggyClient) {
    private companion object {
        const val STORAGE_REQUEST = 72
        val writer = Executors.newSingleThreadExecutor()
    }
    var awaitingPermission: JSONObject? = null
    fun label(file: JSONObject) = if (ImagePreviews.source(file) != null) "保存到相册" else "保存到下载目录"
    private fun toast(message: String) = Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()

    fun save(file: JSONObject) {
        if (file.optLong("until", Long.MAX_VALUE) <= System.currentTimeMillis()) {
            toast("附件已过期")
            return
        }
        if (Build.VERSION.SDK_INT < 29 && activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            awaitingPermission = file
            activity.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), STORAGE_REQUEST)
            return
        }
        toast("正在保存…")
        val context = activity.applicationContext
        writer.execute {
            val message = try {
                val uri = if (file.has("key")) client.cachedReply(file) else Uri.parse(file.getString("uri"))
                val album = ImagePreviews.source(file) != null
                val folder = if (album) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS
                val name = File(file.getString("name").replace('\\', '/')).name.takeUnless { it.isBlank() || it == "." || it == ".." } ?: "附件"
                val declared = file.optString("mime")
                val mime = if (album && !declared.startsWith("image/"))
                    android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(File(name).extension.lowercase()) ?: "image/jpeg"
                else declared.ifBlank { "application/octet-stream" }
                saveCopy(context, uri, folder, name, mime, album)
                if (album) "已保存到系统相册 · Piggy" else "已保存到下载目录 · Piggy"
            } catch (_: Exception) { "保存失败，请检查原件和手机存储空间后重试" }
            activity.runOnUiThread { Toast.makeText(context, message, Toast.LENGTH_LONG).show() }
        }

    }

    fun onPermissionResult(request: Int, results: IntArray) {
        if (request != STORAGE_REQUEST) return
        val file = awaitingPermission
        awaitingPermission = null
        if (file != null && results.firstOrNull() == PackageManager.PERMISSION_GRANTED) save(file)
        else toast("未取得存储权限，文件未保存")
    }

    @Suppress("DEPRECATION")
    private fun saveCopy(context: Context, source: Uri, folder: String, name: String, mime: String, image: Boolean) {
        val resolver = context.contentResolver
        val input = resolver.openInputStream(source) ?: throw IOException("原文件不可用")
        input.use { stream ->
            if (Build.VERSION.SDK_INT >= 29) {
                val collection = if (image) MediaStore.Images.Media.EXTERNAL_CONTENT_URI else MediaStore.Downloads.EXTERNAL_CONTENT_URI
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/Piggy")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val dest = resolver.insert(collection, values) ?: throw IOException("无法创建文件")
                try {
                    val out = resolver.openOutputStream(dest) ?: throw IOException("无法写入文件")
                    out.use { stream.copyTo(it) }
                    values.clear()
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    check(resolver.update(dest, values, null, null) == 1)
                } catch (e: Exception) {
                    resolver.delete(dest, null, null)
                    throw e
                }
            } else {
                val dir = File(Environment.getExternalStoragePublicDirectory(folder), "Piggy")
                check(dir.mkdirs() || dir.isDirectory)
                var dest = File(dir, name)
                var number = 1
                while (!dest.createNewFile()) {
                    val original = File(name)
                    val extension = original.extension.let { if (it.isEmpty()) "" else "." + it }
                    dest = File(dir, original.nameWithoutExtension + " (" + number++ + ")" + extension)
                }
                try { dest.outputStream().use { stream.copyTo(it) } }
                catch (e: Exception) { dest.delete(); throw e }
                MediaScannerConnection.scanFile(context, arrayOf(dest.path), arrayOf(mime), null)
            }
        }
    }
}

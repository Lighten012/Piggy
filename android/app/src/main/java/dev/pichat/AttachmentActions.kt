package dev.pichat

import android.Manifest
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
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

internal class AttachmentActions(private val activity: Activity, private val client: PiggyClient) {
    private companion object {
        const val STORAGE_REQUEST = 72
        val writer = Executors.newSingleThreadExecutor()
    }
    var awaitingPermission: JSONObject? = null
    private fun label(file: JSONObject) = if (ImagePreviews.source(file) != null) "保存到相册" else "保存到下载目录"
    private fun toast(message: String) = Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()

    fun showMenu(file: JSONObject, original: Uri? = null) {
        if (file.optLong("until", Long.MAX_VALUE) <= System.currentTimeMillis()) {
            toast("附件已过期")
            return
        }
        AlertDialog.Builder(activity)
            .setTitle(file.getString("name"))
            .setItems(arrayOf(label(file), "用其他应用打开", "分享…")) { _, choice ->
                when (choice) {
                    0 -> save(file)
                    1 -> chooseApp(file, original, Intent.ACTION_VIEW)
                    2 -> chooseApp(file, original, Intent.ACTION_SEND)
                }
            }
            .show()
    }

    private fun chooseApp(file: JSONObject, original: Uri?, action: String) {
        fun launch(uri: Uri) {
            if (activity.isFinishing || activity.isDestroyed) return
            val name = file.getString("name")
            val type = fileType(file)
            val target = Intent(action).apply {
                if (action == Intent.ACTION_SEND) {
                    this.type = type
                    putExtra(Intent.EXTRA_STREAM, uri)
                } else setDataAndType(uri, type)
                clipData = ClipData.newRawUri(name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            try {
                val title = if (action == Intent.ACTION_VIEW) "选择打开方式" else null
                activity.startActivity(Intent.createChooser(target, title))
            } catch (_: ActivityNotFoundException) {
                toast("没有可用的应用")
            } catch (_: SecurityException) {
                toast("无法向其他应用提供原件，请检查文件读取权限")
            }
        }
        if (original != null) launch(original)
        else if (file.has("key")) {
            client.fetchReply(file) { uri, error ->
                if (uri != null) launch(uri) else toast(error ?: "文件下载失败")
            }
        } else launch(Uri.parse(file.getString("uri")))
    }

    private fun fileType(file: JSONObject): String {
        val declared = file.optString("mime")
        if (declared.isNotBlank() && declared != "application/octet-stream") return declared
        val extension = File(file.getString("name")).extension.lowercase()
        return android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
            ?: "application/octet-stream"
    }

    private fun save(file: JSONObject) {
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
                saveCopy(context, uri, folder, name, fileType(file), album)
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

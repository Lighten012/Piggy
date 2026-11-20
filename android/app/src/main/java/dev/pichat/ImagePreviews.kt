package dev.pichat

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.util.AtomicFile
import android.view.View
import android.widget.ImageView
import com.bumptech.glide.Glide
import com.bumptech.glide.load.engine.DiskCacheStrategy
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

internal object ImagePreviews {
    private val imageExtensions = setOf("jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif")
    private const val edge = 480

    fun source(file: JSONObject): Uri? {
        val extension = file.optString("name").substringAfterLast('.', "").lowercase()
        return if (file.optString("mime").startsWith("image/") || extension in imageExtensions)
            Uri.parse(file.getString("uri")) else null
    }

    private fun path(context: Context, id: String) =
        File(File(context.noBackupFilesDir, "image-previews"), "$id.webp")

    fun saved(context: Context, id: String): Uri? =
        if (id.isEmpty()) null else path(context, id).takeIf { it.isFile }?.let { Uri.fromFile(it) }

    fun display(view: ImageView, uri: Uri?, label: String) {
        val glide = Glide.with(view)
        if (uri == null) {
            glide.clear(view)
            view.visibility = View.GONE
            return
        }
        view.visibility = View.VISIBLE
        view.contentDescription = "图片预览，$label"
        glide.asBitmap().load(uri).fitCenter().override(edge)
            .diskCacheStrategy(DiskCacheStrategy.NONE).into(view)
    }

    fun enlarge(view: ImageView, original: Uri, thumbnail: Uri?, name: String) {
        val glide = Glide.with(view)
        val screen = view.resources.displayMetrics
        val request = glide.asBitmap().fitCenter().override(screen.widthPixels, screen.heightPixels)
            .diskCacheStrategy(DiskCacheStrategy.NONE)
        view.contentDescription = "图片，$name"
        request.clone().load(original).error(request.clone().load(thumbnail)
            .error(android.R.drawable.ic_menu_gallery)).into(view)
    }

    // Generate the bounded local history thumbnail off the UI thread.
    fun save(context: Context, attachment: JSONObject) {
        val uri = source(attachment) ?: return
        val id = attachment.getString("id")
        val file = path(context,id)
        val glide = Glide.with(context.applicationContext)
        val target = glide.asBitmap().load(uri).fitCenter().override(edge)
            .diskCacheStrategy(DiskCacheStrategy.NONE).submit()
        try {
            val bitmap = target.get(12, TimeUnit.SECONDS)
            file.parentFile?.mkdirs()
            val atomic = AtomicFile(file)
            val out = atomic.startWrite()
            try {
                @Suppress("DEPRECATION")
                check(bitmap.compress(Bitmap.CompressFormat.WEBP, 84, out))
                atomic.finishWrite(out)
            } catch (e: Exception) {
                atomic.failWrite(out)
                throw e
            }
        } catch (_: Exception) {
            // The retained document URI can still be used when no thumbnail was saved.
        } finally {
            glide.clear(target)
        }
    }

    fun discard(context: Context, id: String?) {
        if (!id.isNullOrEmpty()) AtomicFile(path(context,id)).delete()
    }
}

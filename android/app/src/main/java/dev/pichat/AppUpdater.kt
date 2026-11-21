package dev.pichat

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

sealed class UpdateState {
    object Checking : UpdateState()
    object Current : UpdateState()
    data class Downloading(val name: String) : UpdateState()
    data class Ready(val name: String) : UpdateState()
    data class Failed(val message: String) : UpdateState()
}

class AppUpdater(private val activity: Activity, private val changed: (UpdateState) -> Unit) {
    private val worker = Executors.newSingleThreadExecutor()
    private var checking = false
    @Volatile private var closed = false
    private var verified: File? = null

    private val manager = activity.packageManager
    private val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    private val installed = manager.getPackageInfo(activity.packageName, flags)
    private fun version(info: PackageInfo) = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    private val cache = File(activity.cacheDir, "updates")

    fun checkOnLaunch() {
        if (confirmedInProcess) changed(UpdateState.Current) else check()
    }

    fun check() {
        if (checking || closed) return
        confirmedInProcess = false
        checking = true
        verified = null
        changed(UpdateState.Checking)
        worker.execute {
            val result = runCatching { findUpdate() }
            activity.runOnUiThread {
                if (closed) return@runOnUiThread
                checking = false
                result.onSuccess { update ->
                    confirmedInProcess = update == null
                    verified = update?.second
                    changed(if (update == null) UpdateState.Current else UpdateState.Ready(update.first))
                }.onFailure {
                    changed(UpdateState.Failed(it.localizedMessage ?: "无法连接更新服务"))
                }
            }
        }
    }

    private fun <T> read(url: URL, consume: (InputStream) -> T): T {
        val connection = url.openConnection() as HttpsURLConnection
        try {
            connection.connectTimeout = 10000
            connection.readTimeout = 30000
            connection.instanceFollowRedirects = false
            check(connection.responseCode == 200) { "更新服务器返回 HTTP ${connection.responseCode}" }
            return connection.inputStream.use(consume)
        } finally { connection.disconnect() }
    }

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        return signatures.orEmpty().map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
    }
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private fun checkAPK(file: File, code: Long, size: Long, sha: String, signer: String) {
        check(file.length() == size) { "更新包长度不符" }
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buf = ByteArray(32768)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        check(hex(digest.digest()) == sha) { "更新包校验失败" }
        val apk = manager.getPackageArchiveInfo(file.absolutePath, flags)
        check(apk != null && apk.packageName == activity.packageName && version(apk) == code &&
            signers(apk) == setOf(signer) && signers(installed) == setOf(signer)) { "更新包的应用、版本或签名不匹配" }
    }

    private fun findUpdate(): Pair<String, File>? {
        val root = PiggyServer.ORIGIN + "/updates/android/"
        val abi = OfficeRuntime.deviceAbi
        val manifest = read(URL(root + "latest.json?abi=$abi")) { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(2048)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                check(out.size() + n <= 16384) { "无效的版本信息" }
                out.write(buf, 0, n)
            }
            JSONObject(out.toString("UTF-8"))
        }
        check(manifest.getString("packageName") == activity.packageName) { "版本信息属于其他应用" }
        val code = manifest.getLong("versionCode")
        check(code >= version(installed)) { "服务器尚未发布此版本，请稍后重试" }
        if (code == version(installed) && OfficeRuntime.bundledAbi(activity) == abi) {
            cache.listFiles()?.filter { it.extension == "apk" }?.forEach { it.delete() }
            return null
        }
        check(manifest.getInt("minSdk") <= Build.VERSION.SDK_INT) { "此版本需要更高版本的 Android" }
        val digest = manifest.getString("sha256")
        val size = manifest.getLong("size")
        val signer = manifest.getString("signerSha256")
        check(digest.matches(Regex("[0-9a-f]{64}")) && size in 1..134217728L && signers(installed) == setOf(signer)) { "更新清单校验失败" }
        val name = manifest.getString("versionName")
        activity.runOnUiThread { if (!closed) changed(UpdateState.Downloading(name)) }
        cache.mkdirs()
        val file = File(cache, "$digest.apk")
        if (file.isFile && runCatching { checkAPK(file, code, size, digest, signer) }.isFailure) file.delete()
        if (!file.isFile) {
            val temp = File.createTempFile("download-", ".apk", cache)
            try {
                read(URL(root + "$digest.apk?abi=$abi&v=$code")) { input ->
                    temp.outputStream().use { out ->
                        var total = 0L
                        val buf = ByteArray(32768)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            total += n
                            check(!closed && total <= size) { "更新下载已中断" }
                            out.write(buf, 0, n)
                        }
                    }
                }
                checkAPK(temp, code, size, digest, signer)
                check(temp.renameTo(file)) { "无法保存更新包" }
            } finally { temp.delete() }
        }
        return name to file
    }

    fun install() {
        val file = verified
        if (file == null || !file.isFile) { check(); return }
        try {
            if (Build.VERSION.SDK_INT >= 26 && !manager.canRequestPackageInstalls()) {
                activity.startActivityForResult(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.packageName)), PERMISSION_REQUEST)
                return
            }
            val content = FileProvider.getUriForFile(activity, activity.packageName + ".updates", file)
            activity.startActivity(Intent(Intent.ACTION_VIEW)
                .setDataAndType(content, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (e: Exception) { changed(UpdateState.Failed("无法打开系统安装器，请重试")) }
    }

    fun close() { closed = true; worker.shutdownNow() }
    companion object {
        const val PERMISSION_REQUEST = 301
        // Main thread only. A new process or a server-mandated check must verify again.
        private var confirmedInProcess = false
    }
}

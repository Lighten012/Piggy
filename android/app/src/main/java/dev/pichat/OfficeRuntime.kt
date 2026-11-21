package dev.pichat

import android.content.Context
import android.os.Build
import java.io.File
import java.util.zip.ZipInputStream

internal object OfficeRuntime {
    const val version = "26.2.7.3"
    private val libraries =
        listOf(
            "nspr4",
            "plds4",
            "plc4",
            "nssutil3",
            "freebl3",
            "sqlite3",
            "softokn3",
            "nss3",
            "nssckbi",
            "nssdbm3",
            "smime3",
            "ssl3",
            "c++_shared",
            "lo-native-code",
        )

    fun bundledAbi(context: Context) =
        context.assets.open("office-abi").bufferedReader().use { it.readText().trim() }

    val deviceAbi: String
        get() = Build.SUPPORTED_ABIS.first()

    fun load(context: Context) {
        val abi = bundledAbi(context)
        check(abi == deviceAbi) { "请更新到与本机处理器匹配的安装包" }
        val parent = File(context.noBackupFilesDir, "office-engine").apply { mkdirs() }
        val target = File(parent, "$version-$abi")
        if (!target.isDirectory) {
            val stage = File(parent, "unpacking")
            stage.deleteRecursively()
            check(stage.mkdir())
            val entries = libraries.associateBy { "lib/$abi/lib$it.so" }
            val extracted = mutableSetOf<String>()
            ZipInputStream(context.assets.open("office.lopack").buffered()).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val lib = entries[entry.name] ?: continue
                    val file = File(stage, "lib$lib.so")
                    file.outputStream().use { zip.copyTo(it) }
                    check(file.setReadOnly())
                    extracted.add(lib)
                }
            }
            check(extracted.size == libraries.size && stage.renameTo(target)) { "本机文档引擎安装不完整" }
            parent.listFiles()?.filter { it != target }?.forEach { it.deleteRecursively() }
        }
        for (lib in libraries) System.load(File(target, "lib$lib.so").absolutePath)
    }
}

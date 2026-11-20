package dev.pichat

import android.content.Context
import java.net.URI
import java.net.URL

object PiggyServer {
    private const val initial = "https://38.14.232.112:8888"
    fun origin(context: Context): String =
        context.getSharedPreferences("server", Context.MODE_PRIVATE).getString("origin", initial) ?: initial

    fun save(context: Context, address: String) {
        val uri = URI(address.trim())
        require(uri.scheme.equals("https", true) && !uri.host.isNullOrEmpty() &&
                uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                (uri.path.isNullOrEmpty() || uri.path == "/") &&
                (uri.port == -1 || uri.port in 1..65535)) { "请填写 HTTPS 服务器地址，可包含端口" }
        val origin = URI("https", null, uri.host, uri.port, null, null, null).toASCIIString()
        check(context.getSharedPreferences("server", Context.MODE_PRIVATE).edit().putString("origin", origin).commit())
    }

    fun url(context: Context, path: String) = URL(origin(context) + path)
}

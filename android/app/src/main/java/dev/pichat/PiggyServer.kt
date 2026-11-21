package dev.pichat

import java.net.URL

object PiggyServer {
    val ORIGIN = BuildConfig.SERVER_ORIGIN
    fun url(path: String) = URL(ORIGIN + path)
}

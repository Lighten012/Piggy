package dev.pichat

import java.net.URL

object PiggyServer {
    const val ORIGIN = "https://38.14.232.112:8888"
    fun url(path: String) = URL(ORIGIN + path)
}

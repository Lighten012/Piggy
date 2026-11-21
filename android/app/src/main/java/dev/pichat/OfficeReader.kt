package dev.pichat

import android.content.*
import android.os.*
import java.io.Closeable
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

internal class OfficeReader(private val context: Context) : Closeable {
    companion object {
        const val OPEN = 1
        const val PAGE = 2
        const val PAINT = 3
        const val CLOSE = 4
        const val SHEETS = 5
    }

    private val id = UUID.randomUUID().toString()
    private val connected = CountDownLatch(1)
    private val replies = ArrayBlockingQueue<Bundle>(1)
    @Volatile private var remote: Messenger? = null
    @Volatile private var closed = false
    private val incoming =
        Messenger(
            Handler(Looper.getMainLooper()) { msg ->
                replies.offer(msg.data)
                true
            }
        )
    private val connection =
        object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                remote = Messenger(binder)
                connected.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName) {
                remote = null
                connected.countDown()
                replies.offer(Bundle().apply { putString("error", "本机文档引擎已关闭，请返回后重试") })
            }
        }

    init {
        check(
            context.bindService(
                Intent(context, OfficeService::class.java),
                connection,
                Context.BIND_AUTO_CREATE,
            )
        ) {
            "无法启动文档引擎"
        }
    }

    // Calls are serialized by PreviewActivity's reader executor.
    fun request(command: Int, data: Bundle = Bundle()): Bundle {
        check(!closed && connected.await(15, TimeUnit.SECONDS)) { "文档引擎启动超时" }
        val service = remote ?: throw IOException("文档引擎已关闭")
        data.putString("session", id)
        service.send(
            Message.obtain(null, command).apply {
                this.data = data
                replyTo = incoming
            }
        )
        val response =
            replies.poll(90, TimeUnit.SECONDS)
                ?: run {
                    close()
                    throw IOException("读取原件超时")
                }
        response.getString("error")?.let { throw IOException(it) }
        return response
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        try {
            remote?.send(
                Message.obtain(null, CLOSE).apply {
                    data = Bundle().apply { putString("session", id) }
                }
            )
        } catch (_: RemoteException) {}
        context.unbindService(connection)
        connected.countDown()
        replies.offer(Bundle().apply { putString("error", "预览已关闭") })
    }
}

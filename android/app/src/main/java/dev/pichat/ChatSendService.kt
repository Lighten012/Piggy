package dev.pichat

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.PersistableBundle

/** Owns the active upload and reply independently of the chat Activity. All observer calls use the main thread. */
class ChatSendService : JobService() {
    interface Listener {
        fun progress(partial: CharSequence, status: String, usage: ContextUsage?)
        fun finished(error: String?, outdated: Boolean)
    }

    companion object {
        var listener: Listener? = null
        private const val SEND_JOB = 1
        private val partial = StringBuilder()
        private var status = "正在发送…"
        private var usage: ContextUsage? = null
        private var running: String? = null

        fun launch(context: Context, id: String) {
            if (running == id) {
                notifyProgress()
                return
            }
            val jobs = context.getSystemService(JobScheduler::class.java)
            if (jobs.getPendingJob(SEND_JOB)?.extras?.getString("request") == id) return
            val builder = JobInfo.Builder(SEND_JOB, ComponentName(context, ChatSendService::class.java))
                .setExtras(PersistableBundle().apply { putString("request", id) })
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            if (Build.VERSION.SDK_INT >= 31 &&
                jobs.schedule(builder.setExpedited(true).build()) == JobScheduler.RESULT_SUCCESS) return
            if (Build.VERSION.SDK_INT >= 31) builder.setExpedited(false)
            check(jobs.schedule(builder.setOverrideDeadline(0).build()) == JobScheduler.RESULT_SUCCESS) {
                "无法安排消息发送"
            }
        }

        private fun notifyProgress() { listener?.progress(partial, status, usage) }
    }

    private var activeClient: PiggyClient? = null

    override fun onStartJob(params: JobParameters): Boolean {
        var outdated = false
        val client = PiggyClient(this) { outdated = true }
        val id = params.extras.getString("request")
        if (id == null || client.pendingId != id || !client.inFlight) {
            if (id != null) finishIfSaved(client, id)
            client.close()
            return false
        }
        activeClient = client
        running = id
        partial.clear()
        status = if (client.pendingAttachments.isEmpty()) ReplyPhrases.WAITING else "正在发送附件…"
        usage = null
        notifyProgress()
        client.send(client.pendingText, client.pendingDraft, status = {
            partial.clear()
            status = it
            notifyProgress()
        }, measured = {
            usage = it
            client.rememberUsage(it)
            notifyProgress()
        }, delta = {
            partial.append(it)
            notifyProgress()
        }, finished = { error, savedReply ->
            running = null
            client.endFlight()
            activeClient = null
            if (error == null && !outdated && savedReply != null) ReplyNotifications.onReplySaved(this, savedReply)
            jobFinished(params, false)
            client.close()
            listener?.finished(error, outdated)
        })
        return true
    }

    // A stop can race the local commit before its main-thread completion callback.
    private fun finishIfSaved(client: PiggyClient, id: String) {
        val history = client.recent
        val turn = history.optJSONObject(history.length() - 1) ?: return
        if (turn.optString("request") == id) {
            ReplyNotifications.onReplySaved(this, turn)
            listener?.finished(null, false)
        }
    }

    override fun onStopJob(params: JobParameters): Boolean {
        val client = activeClient ?: return false
        activeClient = null
        running = null
        partial.clear()
        client.close()
        val id = params.extras.getString("request") ?: return false
        if (client.inFlight && client.pendingId == id) {
            status = "正在等待重新连接…"
            notifyProgress()
            return true
        }
        if (client.inFlight && client.pendingId == null) {
            client.endFlight()
            listener?.finished("回复未完成，请重试", false)
        } else finishIfSaved(client, id)
        return false
    }

    override fun onDestroy() {
        activeClient?.close()
        activeClient = null
        running = null
        super.onDestroy()
    }
}

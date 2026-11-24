package dev.pichat

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper

/** All state is owned by the main thread. Activity and system job share one cursor and fetch. */
internal object ScheduledInbox {
    private const val JOB_ID = 2
    private val main = Handler(Looper.getMainLooper())
    private var client: PiggyClient? = null
    private var foreground: (() -> Unit)? = null
    private var rejected: (() -> Unit)? = null
    private var polling = false
    private var fetching = false
    private var jobDone: (() -> Unit)? = null
    private lateinit var app: Context
    private val tick = Runnable { fetch() }

    fun start(context: Context, changed: () -> Unit, denied: () -> Unit) {
        app = context.applicationContext
        foreground = changed
        rejected = denied
        polling = true
        val jobs = app.getSystemService(JobScheduler::class.java)
        if (jobs.getPendingJob(JOB_ID) == null) {
            jobs.schedule(JobInfo.Builder(JOB_ID, ComponentName(app, InboxJobService::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60_000L)
                .build())
        }
        fetch()
    }

    fun hide(changed: () -> Unit) {
        if (foreground === changed) {
            foreground = null
            rejected = null
        }
    }

    fun suspendPolling(context: Context) {
        polling = false
        main.removeCallbacks(tick)
        context.getSystemService(JobScheduler::class.java).cancel(JOB_ID)
    }

    fun runJob(context: Context, done: () -> Unit) {
        app = context.applicationContext
        jobDone = done
        fetch()
    }

    fun stopJob() {
        jobDone = null
        if (!polling) {
            client?.close()
            client = null
            fetching = false
        }
    }

    private fun fetch() {
        main.removeCallbacks(tick)
        if (fetching || (!polling && jobDone == null)) return
        fetching = true
        val receiver = client ?: PiggyClient(app) {}.also { client = it }
        receiver.syncInbox { changed, blocked ->
            fetching = false
            val done = jobDone
            jobDone = null
            done?.invoke()
            if (blocked) {
                suspendPolling(app)
                rejected?.invoke()
            } else if (changed) {
                foreground?.invoke()
            }
            if (polling) {
                main.postDelayed(tick, if (changed) 500L else if (foreground != null) 15_000L else 30_000L)
            } else {
                receiver.close()
                if (client === receiver) client = null
            }
        }
    }
}

class InboxJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        ScheduledInbox.runJob(this) { jobFinished(params, false) }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        ScheduledInbox.stopJob()
        return false
    }
}

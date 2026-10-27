package app.zest.downloader.engine

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.zest.downloader.R
import app.zest.downloader.ZestApp
import app.zest.downloader.data.Download
import app.zest.downloader.data.Kind
import app.zest.downloader.data.Status
import app.zest.downloader.ui.MainActivity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Runs the queue. A foreground service, so Android lets downloads continue
 * with the screen off or the app swiped away — with one quiet notification
 * that shows overall progress, and a separate one for each finished file.
 */
class DownloadService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val jobs = mutableMapOf<String, Job>()
    private val app get() = application as ZestApp
    private lateinit var nm: NotificationManager
    private var netWatch: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        nm = getSystemService(NotificationManager::class.java)
        startInForeground()
        // Keep the notification honest while anything runs
        scope.launch {
            while (true) {
                delay(1000)
                val active = app.store.items.value.filter { it.status == Status.RUNNING }
                if (active.isNotEmpty()) nm.notify(ONGOING, ongoing(active))
            }
        }
    }

    private fun startInForeground() {
        val n = ongoing(emptyList())
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
        ServiceCompat.startForeground(this, ONGOING, n, type)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(EXTRA_ID)
        when (intent?.action) {
            ACT_PAUSE -> id?.let { pause(it) }
            ACT_PAUSE_ALL -> app.store.items.value.filter { it.active }.forEach { pause(it.id) }
            ACT_CANCEL -> id?.let { cancel(it) }
            ACT_RESUME -> id?.let { app.store.update(it) { d -> d.copy(status = Status.QUEUED, error = null) } }
        }
        schedule()
        return START_NOT_STICKY
    }

    @Synchronized
    private fun schedule() {
        val prefs = app.settings.now
        val items = app.store.items.value
        val running = jobs.keys.size
        // Offline, or on mobile data with Wi-Fi only on: hold the queue and
        // start the moment a usable network appears — like IDM, not a failure
        if (!online() || (prefs.wifiOnly && metered())) {
            if (items.any { it.status == Status.QUEUED }) {
                watchNetwork()
                nm.notify(ONGOING, NotificationCompat.Builder(this, ZestApp.CH_PROGRESS).setSmallIcon(R.drawable.ic_stat_zest)
                    .setContentTitle(if (!online()) "Waiting for internet" else "Waiting for Wi-Fi")
                    .setContentText("${items.count { it.status == Status.QUEUED }} download(s) will start automatically")
                    .setOngoing(true).setSilent(true).setContentIntent(openApp()).build())
            } else if (running == 0) stopIfIdle()
            return
        }
        items.filter { it.status == Status.QUEUED && it.id !in jobs }
            .sortedBy { it.createdAt }
            .take((prefs.parallel - running).coerceAtLeast(0))
            .forEach { start(it) }
        stopIfIdle()
    }

    private fun start(d: Download) {
        app.store.update(d.id) { it.copy(status = Status.RUNNING, error = null) }
        jobs[d.id] = scope.launch {
            try {
                val report: (Download) -> Unit = { u -> app.store.update(d.id) { cur -> if (cur.status == Status.RUNNING) u.copy(status = Status.RUNNING) else cur } }
                val done = when (d.kind) {
                    Kind.HTTP -> app.http.run(d, app.settings.now.connections, report)
                    Kind.MEDIA -> app.media.run(d, report)
                }
                app.store.update(d.id) { done }
                notifyDone(done)
            } catch (e: CancellationException) {
                // Paused or cancelled — whoever stopped it already set the status
            } catch (e: Throwable) {
                // Stopping yt-dlp surfaces as its own exception, not a cancellation;
                // a pause or a cancel is not a failure
                val now = app.store.get(d.id)
                if (now == null || now.status == Status.PAUSED) return@launch
                if (!online()) {
                    app.store.update(d.id) { it.copy(status = Status.QUEUED, speed = 0, etaSec = -1) }
                    return@launch
                }
                app.store.update(d.id) { it.copy(status = Status.ERROR, error = e.message ?: e.javaClass.simpleName, speed = 0, etaSec = -1) }
                notifyFailed(d.copy(error = e.message))
            } finally {
                synchronized(this@DownloadService) { jobs.remove(d.id) }
                schedule()
            }
        }
    }

    private fun pause(id: String) {
        app.store.update(id) { if (it.active) it.copy(status = Status.PAUSED, speed = 0, etaSec = -1) else it }
        stopJob(id)
    }

    private fun cancel(id: String) {
        stopJob(id)
        app.http.partsDir(id).deleteRecursively()
        app.media.workDir(id).deleteRecursively()
        app.store.remove(id)
    }

    private fun stopJob(id: String) {
        app.media.stop(id)
        jobs.remove(id)?.cancel()
    }

    private fun stopIfIdle() {
        if (jobs.isEmpty() && app.store.items.value.none { it.status == Status.QUEUED }) {
            netWatch?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
            netWatch = null
            app.store.flush()
            nm.cancel(ONGOING)
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun online(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun watchNetwork() {
        if (netWatch != null) return
        val cm = getSystemService(ConnectivityManager::class.java)
        netWatch = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) { scope.launch { delay(800); schedule() } }
            override fun onCapabilitiesChanged(network: android.net.Network, caps: NetworkCapabilities) { scope.launch { schedule() } }
        }.also { cm.registerDefaultNetworkCallback(it) }
    }

    private fun metered(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return true
        return !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    // ── Notifications ──

    private fun openApp(): PendingIntent = PendingIntent.getActivity(this, 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)

    private fun action(act: String, id: String? = null, req: Int): PendingIntent = PendingIntent.getService(this, req,
        Intent(this, DownloadService::class.java).setAction(act).putExtra(EXTRA_ID, id), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun ongoing(active: List<Download>): Notification {
        val b = NotificationCompat.Builder(this, ZestApp.CH_PROGRESS)
            .setSmallIcon(R.drawable.ic_stat_zest)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setContentIntent(openApp())
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        if (active.isEmpty()) return b.setContentTitle("Zest").setContentText("Starting…").setProgress(0, 0, true).build()
        val top = active.first()
        val total = active.sumOf { it.totalBytes }; val got = active.sumOf { it.downloadedBytes }
        val speed = active.sumOf { it.speed }
        val title = if (active.size == 1) top.displayName else "Downloading ${active.size} files"
        val pct = if (total > 0) (got * 100 / total).toInt() else 0
        val text = buildString {
            if (total > 0) append("${Files.human(got)} of ${Files.human(total)}") else append(Files.human(got))
            if (speed > 0) append(" · ${Files.human(speed)}/s")
            if (active.size == 1 && top.etaSec >= 0) append(" · ${Files.eta(top.etaSec)}")
        }
        return b.setContentTitle(title).setContentText(text)
            .setProgress(100, pct, total <= 0)
            .addAction(0, if (active.size == 1) "Pause" else "Pause all",
                if (active.size == 1) action(ACT_PAUSE, top.id, 1) else action(ACT_PAUSE_ALL, null, 2))
            .build()
    }

    @SuppressLint("MissingPermission")
    private fun notifyDone(d: Download) {
        val open = d.output?.let {
            PendingIntent.getActivity(this, d.id.hashCode(), Files.openIntent(this, it, d.mime), PendingIntent.FLAG_IMMUTABLE)
        }
        nm.notify(d.id.hashCode(), NotificationCompat.Builder(this, ZestApp.CH_DONE)
            .setSmallIcon(R.drawable.ic_stat_zest)
            .setContentTitle("Download complete")
            .setContentText(d.displayName)
            .setSubText(Files.human(d.totalBytes))
            .setContentIntent(open ?: openApp())
            .setAutoCancel(true)
            .apply { if (open != null) addAction(0, "Open", open) }
            .build())
    }

    private fun notifyFailed(d: Download) {
        nm.notify(d.id.hashCode(), NotificationCompat.Builder(this, ZestApp.CH_DONE)
            .setSmallIcon(R.drawable.ic_stat_zest)
            .setContentTitle("Download failed")
            .setContentText(d.displayName)
            .setStyle(NotificationCompat.BigTextStyle().bigText("${d.displayName}\n${d.error ?: ""}"))
            .setContentIntent(openApp())
            .setAutoCancel(true)
            .build())
    }

    override fun onDestroy() {
        app.store.flush()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val ONGOING = 1
        private const val EXTRA_ID = "id"
        const val ACT_KICK = "kick"
        const val ACT_PAUSE = "pause"
        const val ACT_PAUSE_ALL = "pauseAll"
        const val ACT_RESUME = "resume"
        const val ACT_CANCEL = "cancel"

        fun send(ctx: Context, action: String, id: String? = null) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, DownloadService::class.java).setAction(action).putExtra(EXTRA_ID, id))
        }
    }
}

package app.zest.downloader

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import app.zest.downloader.data.Download
import app.zest.downloader.data.DownloadStore
import app.zest.downloader.data.Kind
import app.zest.downloader.data.Settings
import app.zest.downloader.engine.DownloadService
import app.zest.downloader.engine.HttpEngine
import app.zest.downloader.engine.MediaEngine
import app.zest.downloader.engine.Sites
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class ZestApp : Application() {
    lateinit var store: DownloadStore
    lateinit var settings: Settings
    lateinit var http: HttpEngine
    lateinit var media: MediaEngine
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        store = DownloadStore(this)
        settings = Settings(this)
        val client = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .followRedirects(true)
            .retryOnConnectionFailure(true)
            .build()
        http = HttpEngine(this, client)
        media = MediaEngine(this)
        channels()

        scope.launch {
            // Unpack yt-dlp early so the first video is not also the slowest
            runCatching { media.ensureReady() }
            // Sites change how they serve video every few weeks; an old yt-dlp
            // stops working on them. Keep it current, at most once a day.
            val p = settings.now
            if (p.autoUpdateYtDlp && System.currentTimeMillis() - p.ytDlpCheckedAt > 24L * 3600 * 1000) {
                runCatching { media.update() }.onSuccess { settings.set { it.copy(ytDlpCheckedAt = System.currentTimeMillis()) } }
            }
        }
    }

    private fun channels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_PROGRESS, "Downloads in progress", NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
        })
        nm.createNotificationChannel(NotificationChannel(CH_DONE, "Finished downloads", NotificationManager.IMPORTANCE_DEFAULT))
    }

    /**
     * The one way anything gets downloaded: from the share sheet, the
     * in-app browser, a pasted link or the clipboard offer.
     */
    fun enqueue(
        url: String,
        quality: String = "best",
        playlist: Boolean = false,
        title: String = "",
        thumbnail: String? = null,
        headers: Map<String, String> = emptyMap(),
        fileName: String = "",
        forceFile: Boolean = false,
    ): Download {
        val kind = if (!forceFile && Sites.isMedia(url)) Kind.MEDIA else Kind.HTTP
        val d = Download(url = url, kind = kind, title = title, quality = quality, playlist = playlist,
            thumbnail = thumbnail, headers = headers, fileName = fileName)
        store.add(d)
        DownloadService.send(this, DownloadService.ACT_KICK)
        return d
    }

    companion object {
        const val CH_PROGRESS = "progress"
        const val CH_DONE = "done"
        fun of(ctx: Context) = ctx.applicationContext as ZestApp
    }
}

package app.zest.downloader.engine

import android.content.Context
import app.zest.downloader.data.Download
import app.zest.downloader.data.Status
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.io.IOException

/** What a video page offers, before anything is downloaded */
data class Probe(
    val url: String,
    val title: String,
    val thumbnail: String?,
    val uploader: String?,
    val duration: Long,
    /** Heights that actually exist, tallest first */
    val heights: List<Int>,
    val playlistTitle: String? = null,
    val playlistCount: Int = 0,
)

/**
 * YouTube, Instagram, TikTok and the rest, through yt-dlp running on the phone.
 *
 * These sites serve video as segmented streams behind signed URLs; there is
 * no file to fetch until yt-dlp resolves one. ffmpeg (bundled) joins the
 * separate video and audio streams that anything above 720p arrives as.
 */
class MediaEngine(private val ctx: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val ready = Mutex()
    @Volatile private var initialised = false

    suspend fun ensureReady() = ready.withLock {
        if (initialised) return@withLock
        withContext(Dispatchers.IO) {
            YoutubeDL.getInstance().init(ctx)
            FFmpeg.getInstance().init(ctx)
        }
        initialised = true
    }

    fun version(): String? = runCatching { YoutubeDL.getInstance().version(ctx) }.getOrNull()

    /** Replace yt-dlp with the newest release. Returns the version now installed. */
    suspend fun update(): String? = withContext(Dispatchers.IO) {
        ensureReady()
        YoutubeDL.getInstance().updateYoutubeDL(ctx, YoutubeDL.UpdateChannel.STABLE)
        version()
    }

    suspend fun probe(url: String, headers: Map<String, String> = emptyMap()): Probe = withContext(Dispatchers.IO) {
        ensureReady()
        val req = YoutubeDLRequest(url).apply {
            addOption("-J"); addOption("--no-playlist"); addOption("--no-warnings")
        }
        withCookies(url, headers, req) {
            val res = YoutubeDL.getInstance().execute(req, null, null)
            val o = json.parseToJsonElement(res.out).jsonObject
            val heights = (o["formats"] as? JsonArray).orEmpty().mapNotNull { f ->
                val fo = f.jsonObject
                val v = fo["vcodec"]?.jsonPrimitive?.contentOrNull
                if (v == null || v == "none") null else fo["height"]?.jsonPrimitive?.intOrNull
            }.filter { it >= 144 }.distinct().sortedDescending()
            var probe = Probe(
                url = url,
                title = o.str("title") ?: url,
                thumbnail = o.str("thumbnail"),
                uploader = o.str("uploader") ?: o.str("channel"),
                duration = o["duration"]?.jsonPrimitive?.doubleOrNull?.toLong() ?: 0,
                heights = heights,
            )
            if (Sites.hasPlaylist(url)) probe = probe.copy(playlistTitle = "Playlist", playlistCount = playlistCount(url))
            probe
        }
    }

    /** How many entries a playlist has, read flat so it costs one request */
    private fun playlistCount(url: String): Int = runCatching {
        val req = YoutubeDLRequest(url).apply { addOption("--flat-playlist"); addOption("-J"); addOption("--yes-playlist"); addOption("--no-warnings") }
        val o = json.parseToJsonElement(YoutubeDL.getInstance().execute(req, null, null).out).jsonObject
        (o["entries"] as? JsonArray)?.size ?: o["playlist_count"]?.jsonPrimitive?.intOrNull ?: 0
    }.getOrDefault(0)

    fun workDir(id: String) = File(ctx.cacheDir, "media/$id")

    suspend fun run(d: Download, report: (Download) -> Unit): Download = withContext(Dispatchers.IO) {
        ensureReady()
        val out = workDir(d.id).apply { mkdirs() }
        val req = YoutubeDLRequest(d.url).apply {
            addOption(if (d.playlist) "--yes-playlist" else "--no-playlist")
            addOption("-f", selector(d.quality))
            // Prefer H.264 + AAC wherever the source has it: the MP4 every phone and
            // player can play. YouTube only offers VP9/AV1 above 1080p, so 2K/4K keep those.
            val h = d.quality.toIntOrNull()
            addOption("-S", if (h != null && h > 1080) "res,acodec:m4a" else "vcodec:h264,res,acodec:m4a")
            if (d.quality == "audio") { addOption("-x"); addOption("--audio-format", "m4a") }
            else addOption("--merge-output-format", "mp4")
            addOption("-o", out.absolutePath + "/" + if (d.playlist) "%(playlist_title).80B/%(playlist_index)s - %(title).120B.%(ext)s" else "%(title).150B.%(ext)s")
            addOption("--no-mtime")
            addOption("--continue")
            addOption("--concurrent-fragments", "4")
            addOption("--newline")
            d.headers["User-Agent"]?.let { addOption("--user-agent", it) }
            d.headers["Referer"]?.let { addOption("--referer", it) }
        }

        var cur = d.copy(status = Status.RUNNING, error = null)
        report(cur)
        // A merged download reports twice: the video stream, then the audio.
        // Bank the first so the bar never runs backwards.
        var banked = 0L; var phaseTotal = 0L; var lastPct = 0f
        var lastReport = 0L
        val response = withCookies(d.url, d.headers, req) {
            YoutubeDL.getInstance().execute(req, d.id) { pct, eta, line ->
                Regex("Downloading item (\\d+) of (\\d+)").find(line)?.let {
                    cur = cur.copy(item = it.groupValues[1].toInt(), itemCount = it.groupValues[2].toInt())
                }
                val total = Regex("of\\s+~?\\s*([\\d.]+)\\s*([KMGT]?i?B)").find(line)?.let { size(it.groupValues[1], it.groupValues[2]) }
                val speed = Regex("at\\s+([\\d.]+)\\s*([KMGT]?i?B)/s").find(line)?.let { size(it.groupValues[1], it.groupValues[2]) }
                if (pct < lastPct - 30 && phaseTotal > 0) banked += phaseTotal   // a new phase started
                if (total != null) phaseTotal = total
                lastPct = pct
                val now = System.currentTimeMillis()
                if (now - lastReport > 400) {
                    lastReport = now
                    val got = banked + (phaseTotal * pct / 100f).toLong()
                    cur = cur.copy(
                        downloadedBytes = got,
                        totalBytes = (banked + phaseTotal).coerceAtLeast(got),
                        speed = speed ?: cur.speed,
                        etaSec = eta,
                    )
                    report(cur)
                }
            }
        }
        if (response.exitCode != 0) throw IOException(friendly(response.err))

        // Publish everything yt-dlp produced into Downloads/Zest, keeping playlist folders
        val files = out.walkTopDown().filter { it.isFile && !it.name.endsWith(".part") && !it.name.endsWith(".ytdl") && !it.name.endsWith(".txt") }.toList()
        if (files.isEmpty()) throw IOException("yt-dlp finished but produced no file")
        var first: String? = null
        var size = 0L
        for (f in files) {
            val sub = f.parentFile?.takeIf { it != out }?.name ?: ""
            val uri = Files.publish(ctx, f.name, Files.mimeFor(f.name, "video/mp4"), listOf(f), sub)
            if (first == null) first = uri
            size += f.length()
        }
        out.deleteRecursively()
        cur.copy(
            status = Status.DONE, output = first,
            fileName = if (d.playlist && files.size > 1) (files.first().parentFile?.name ?: cur.title)
                       else Files.displayName(ctx, first!!, files.first().name),
            mime = Files.mimeFor(files.first().name, "video/mp4"),
            downloadedBytes = size, totalBytes = size, speed = 0, etaSec = -1, finishedAt = System.currentTimeMillis(),
        )
    }

    fun stop(id: String) { runCatching { YoutubeDL.getInstance().destroyProcessById(id) } }

    /** The browser's session goes to yt-dlp as a cookie file, never as a raw header */
    private inline fun <T> withCookies(url: String, headers: Map<String, String>, req: YoutubeDLRequest, block: () -> T): T {
        val cookie = headers["Cookie"]
        val host = runCatching { android.net.Uri.parse(url).host }.getOrNull()
        if (cookie.isNullOrBlank() || host.isNullOrBlank()) return block()
        val jar = File.createTempFile("cookies", ".txt", ctx.cacheDir)
        jar.writeText(buildString {
            append("# Netscape HTTP Cookie File\n")
            val domain = "." + host.removePrefix("www.").removePrefix("m.")
            cookie.split(';').map { it.trim() }.filter { it.contains('=') }.forEach {
                append("$domain\tTRUE\t/\tTRUE\t0\t${it.substringBefore('=')}\t${it.substringAfter('=')}\n")
            }
        })
        req.addOption("--cookies", jar.absolutePath)
        return try { block() } finally { jar.delete() }
    }

    private fun selector(q: String) = when (q) {
        "audio" -> "ba[ext=m4a]/ba/b"
        "best" -> "bv*+ba/b"
        else -> "bv*[height<=$q]+ba/b[height<=$q]/bv*+ba/b"
    }

    private fun size(n: String, unit: String): Long {
        val v = n.toDoubleOrNull() ?: return 0
        val m = when (unit.uppercase().replace("I", "")) { "KB" -> 1024.0; "MB" -> 1024.0 * 1024; "GB" -> 1024.0 * 1024 * 1024; else -> 1.0 }
        return (v * m).toLong()
    }

    private fun JsonObject.str(k: String) = this[k]?.jsonPrimitive?.contentOrNull

    companion object {
        /** yt-dlp's last error line, turned into something a person can act on */
        fun friendly(err: String?): String {
            val line = err?.lines()?.lastOrNull { it.contains("ERROR") }?.substringAfter("ERROR:")?.trim() ?: err?.lines()?.lastOrNull { it.isNotBlank() } ?: "yt-dlp failed"
            return when {
                line.contains("Sign in", true) || line.contains("login", true) -> "This video needs you to be signed in. Open it in Zest's browser, log in, and try again."
                line.contains("Private", true) -> "This video is private."
                line.contains("unavailable", true) -> "This video is unavailable — removed, region-locked, or members-only."
                line.contains("Unsupported URL", true) -> "This link isn't a video Zest can read."
                else -> line.take(220)
            }
        }
    }
}

private fun JsonArray?.orEmpty(): JsonArray = this ?: JsonArray(emptyList())
@Suppress("unused") private fun JsonObject.long(k: String) = this[k]?.jsonPrimitive?.longOrNull

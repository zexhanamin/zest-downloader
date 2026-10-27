package app.zest.downloader.engine

import android.content.Context
import app.zest.downloader.data.Download
import app.zest.downloader.data.Status
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.coroutineContext

/**
 * Multi-connection HTTP downloads with real resume.
 *
 * The file is split into byte ranges fetched in parallel, each into its own
 * part file under the app's private storage, beside a small state.json.
 * Pausing keeps the parts; resuming asks each range for only what it is
 * still missing. A server that ignores Range gets one plain stream instead
 * of a corrupt file. When every range is complete, the parts are joined in
 * the same pass that writes the result into Downloads/Zest.
 */
class HttpEngine(private val ctx: Context, private val client: OkHttpClient) {

    @Serializable
    private data class Chunk(val start: Long, val end: Long)          // end inclusive, -1 = unknown
    @Serializable
    private data class State(val url: String, val total: Long, val ranges: Boolean, val name: String, val mime: String, val chunks: List<Chunk>)

    private val json = Json { ignoreUnknownKeys = true }

    fun partsDir(id: String) = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "parts/$id")

    suspend fun run(d: Download, connections: Int, report: (Download) -> Unit): Download = withContext(Dispatchers.IO) {
        val dir = partsDir(d.id).apply { mkdirs() }
        val stateFile = File(dir, "state.json")
        val state = stateFile.takeIf { it.exists() }?.let { runCatching { json.decodeFromString<State>(it.readText()) }.getOrNull() }
            ?: probe(d, connections).also { stateFile.writeText(json.encodeToString(it)) }

        var cur = d.copy(fileName = d.fileName.ifBlank { state.name }, mime = state.mime, totalBytes = state.total.coerceAtLeast(0), status = Status.RUNNING, error = null)
        report(cur)

        val parts = state.chunks.indices.map { File(dir, "p$it") }
        // A server without range support cannot continue a part — start those over
        if (!state.ranges) parts.forEach { if (it.exists()) it.delete() }
        val got = AtomicLong(parts.sumOf { if (it.exists()) it.length() else 0L })

        coroutineScope {
            val ticker = launch {
                var last = got.get(); var lastT = System.nanoTime(); var speed = 0.0
                while (isActive) {
                    delay(500)
                    val now = got.get(); val t = System.nanoTime()
                    val inst = (now - last) / ((t - lastT) / 1e9)
                    speed = if (speed == 0.0) inst else speed * 0.6 + inst * 0.4
                    last = now; lastT = t
                    val eta = if (speed > 1 && state.total > 0) ((state.total - now) / speed).toLong() else -1
                    cur = cur.copy(downloadedBytes = now, speed = speed.toLong(), etaSec = eta)
                    report(cur)
                }
            }
            try {
                state.chunks.mapIndexed { i, c -> async { fetch(state, c, parts[i], d, got) } }.awaitAll()
            } finally {
                ticker.cancel()
            }
        }

        // Every range must be exactly the size it claimed, or the join would be corrupt
        if (state.total > 0) {
            val sum = parts.sumOf { it.length() }
            if (sum != state.total) throw IOException("Download ended short (${Files.human(sum)} of ${Files.human(state.total)})")
        }
        val output = Files.publish(ctx, cur.fileName, cur.mime, parts)
        dir.deleteRecursively()
        val size = if (state.total > 0) state.total else got.get()
        cur.copy(status = Status.DONE, output = output, fileName = Files.displayName(ctx, output, cur.fileName), downloadedBytes = size, totalBytes = size, speed = 0, etaSec = -1, finishedAt = System.currentTimeMillis())
    }

    /** Ask for one byte: a 206 tells us the size and that ranges work */
    private fun probe(d: Download, connections: Int): State {
        val req = request(d.url, d.headers).header("Range", "bytes=0-0").build()
        val call = try { client.newCall(req).execute() } catch (e: IOException) { throw IOException(netError(e), e) }
        call.use { res ->
            if (!res.isSuccessful) throw IOException(httpError(res.code))
            val finalUrl = res.request.url.toString()
            val type = res.header("Content-Type")?.substringBefore(';')?.trim()?.lowercase() ?: ""
            val disp = res.header("Content-Disposition")
            // A login wall or an error page answers with HTML; saving that as the file is the
            // classic corrupt download. Only accept HTML when the link itself names an .html file.
            if (type == "text/html" && disp == null && !finalUrl.substringBefore('?').endsWith(".html")) {
                throw IOException("This link opens a web page, not a file. Open it in Zest's browser and tap the file there.")
            }
            val ranges = res.code == 206
            val total = if (ranges) res.header("Content-Range")?.substringAfter('/')?.toLongOrNull() ?: -1
                        else res.body?.contentLength() ?: -1
            val name = d.fileName.ifBlank { Files.nameFrom(finalUrl, disp, type) }
            val mime = type.takeIf { it.isNotBlank() && it != "application/octet-stream" } ?: Files.mimeFor(name)
            val n = if (ranges && total > 4L * 1024 * 1024) connections.coerceIn(1, 16).coerceAtMost((total / (1024 * 1024)).toInt().coerceAtLeast(1)) else 1
            val chunks = if (n == 1) listOf(Chunk(0, if (total > 0) total - 1 else -1)) else {
                val size = total / n
                (0 until n).map { i -> Chunk(i * size, if (i == n - 1) total - 1 else (i + 1) * size - 1) }
            }
            return State(finalUrl, total, ranges, name, mime, chunks)
        }
    }

    private suspend fun fetch(state: State, c: Chunk, part: File, d: Download, got: AtomicLong) {
        val want = if (c.end >= 0) c.end - c.start + 1 else -1
        var attempt = 0
        while (true) {
            coroutineContext.ensureActive()
            val have = if (part.exists()) part.length() else 0L
            if (want >= 0 && have >= want) return
            try {
                val b = request(state.url, d.headers)
                if (state.ranges) b.header("Range", "bytes=${c.start + have}-${if (c.end >= 0) c.end else ""}")
                client.newCall(b.build()).execute().use { res ->
                    if (!res.isSuccessful) throw IOException(httpError(res.code))
                    // Asked for a range, got the whole file: appending it would corrupt the part
                    if (state.ranges && res.code != 206) throw IOException("The server stopped honouring byte ranges")
                    val body = res.body ?: throw IOException("Empty response")
                    FileOutputStream(part, true).use { out ->
                        val buf = ByteArray(1 shl 16)
                        val input = body.byteStream()
                        while (true) {
                            coroutineContext.ensureActive()
                            val r = input.read(buf)
                            if (r < 0) break
                            out.write(buf, 0, r)
                            got.addAndGet(r.toLong())
                        }
                    }
                }
                if (want < 0) return                         // unknown size: the stream ending is the end
                attempt = 0
            } catch (e: IOException) {
                attempt++
                if (attempt > 6) throw IOException(netError(e), e)
                delay(1500L * attempt)                          // the bytes already written are kept
            }
        }
    }

    private fun request(url: String, headers: Map<String, String>): Request.Builder {
        val b = Request.Builder().url(url).header("User-Agent", headers["User-Agent"] ?: UA).header("Accept-Encoding", "identity")
        headers.forEach { (k, v) -> if (k != "User-Agent" && v.isNotBlank()) b.header(k, v) }
        return b
    }

    private fun netError(e: IOException): String = when (e) {
        is java.net.UnknownHostException -> "No internet connection — it will resume when you're back online."
        is java.net.SocketTimeoutException -> "The server stopped responding. Tap retry to continue from where it stopped."
        is java.net.ConnectException -> "Couldn't reach the server. Check your connection and tap retry."
        else -> e.message ?: "Network error"
    }

    private fun httpError(code: Int) = when (code) {
        401, 403 -> "The server refused (HTTP $code). The link may need you to be signed in, or it expired."
        404 -> "File not found on the server (HTTP 404)."
        410 -> "The link has expired (HTTP 410)."
        in 500..599 -> "The server had a problem (HTTP $code). Try again later."
        else -> "HTTP $code"
    }

    companion object {
        const val UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
    }
}

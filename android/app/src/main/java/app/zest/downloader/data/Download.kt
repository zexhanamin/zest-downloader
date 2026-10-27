package app.zest.downloader.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

enum class Kind { HTTP, MEDIA }
enum class Status { QUEUED, RUNNING, PAUSED, DONE, ERROR }

@Serializable
data class Download(
    val id: String = UUID.randomUUID().toString().take(12),
    val url: String,
    val kind: Kind,
    val title: String = "",
    val fileName: String = "",
    val mime: String = "",
    val totalBytes: Long = 0,
    val downloadedBytes: Long = 0,
    val status: Status = Status.QUEUED,
    val error: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val finishedAt: Long = 0,
    /** yt-dlp quality: "best", a height like "1080", or "audio" */
    val quality: String = "best",
    val playlist: Boolean = false,
    /** content:// or file:// of the finished file (or folder, for a playlist) */
    val output: String? = null,
    val thumbnail: String? = null,
    /** Cookie / Referer / User-Agent captured where the link was found */
    val headers: Map<String, String> = emptyMap(),
    // Live numbers, not worth persisting
    @Transient val speed: Long = 0,
    @Transient val etaSec: Long = -1,
    @Transient val item: Int = 0,
    @Transient val itemCount: Int = 0,
) {
    val progress: Float get() = if (totalBytes > 0) (downloadedBytes.toFloat() / totalBytes).coerceIn(0f, 1f) else 0f
    val active: Boolean get() = status == Status.QUEUED || status == Status.RUNNING
    val displayName: String get() = fileName.ifBlank { title.ifBlank { url.substringAfterLast('/').substringBefore('?').ifBlank { url } } }
}

/**
 * Every download the app knows about, kept in memory as a StateFlow and
 * written to disk shortly after it changes — so a crash or a reboot
 * comes back to the same list, with unfinished ones parked as paused.
 */
@OptIn(FlowPreview::class)
class DownloadStore(context: Context) {
    private val file = File(context.filesDir, "downloads.json")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _items = MutableStateFlow(load())
    val items: StateFlow<List<Download>> = _items.asStateFlow()

    init {
        _items.drop(1).debounce(400).onEach { save(it) }.launchIn(scope)
    }

    private fun load(): List<Download> = try {
        if (!file.exists()) emptyList()
        else json.decodeFromString<List<Download>>(file.readText()).map {
            // Whatever was running when the process died is paused now, not "running" forever
            if (it.status == Status.RUNNING || it.status == Status.QUEUED) it.copy(status = Status.PAUSED) else it
        }
    } catch (_: Exception) { emptyList() }

    private fun save(list: List<Download>) {
        try {
            val tmp = File(file.parentFile, "downloads.json.tmp")
            tmp.writeText(json.encodeToString(list))
            tmp.renameTo(file)
        } catch (_: Exception) { }
    }

    fun get(id: String): Download? = _items.value.firstOrNull { it.id == id }

    fun add(d: Download) = _items.update { listOf(d) + it }

    fun update(id: String, f: (Download) -> Download) =
        _items.update { list -> list.map { if (it.id == id) f(it) else it } }

    fun remove(id: String) = _items.update { list -> list.filterNot { it.id == id } }

    fun clearFinished() = _items.update { list -> list.filterNot { it.status == Status.DONE } }

    /** Flush now — called when the service stops, so nothing waits on the debounce */
    fun flush() = save(_items.value)
}

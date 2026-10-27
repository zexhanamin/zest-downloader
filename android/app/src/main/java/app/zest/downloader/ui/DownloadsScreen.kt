package app.zest.downloader.ui

import android.widget.Toast
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.zest.downloader.ZestApp
import app.zest.downloader.data.Download
import app.zest.downloader.data.Kind
import app.zest.downloader.data.Status
import app.zest.downloader.engine.DownloadService
import app.zest.downloader.engine.Files
import coil.compose.AsyncImage

private enum class Filter(val label: String) { ALL("All"), ACTIVE("Active"), PAUSED("Paused"), DONE("Done"), FAILED("Failed") }

@Composable
fun DownloadsScreen(clipOffer: String?, onClipDownload: (String) -> Unit, onClipDismiss: () -> Unit, contentPadding: PaddingValues) {
    val ctx = LocalContext.current
    val app = ZestApp.of(ctx)
    val items by app.store.items.collectAsState()
    var filter by rememberSaveable { mutableStateOf(Filter.ALL) }
    var query by rememberSaveable { mutableStateOf("") }
    var confirm by remember { mutableStateOf<Download?>(null) }

    val shown = items.filter {
        when (filter) {
            Filter.ALL -> true
            Filter.ACTIVE -> it.active
            Filter.PAUSED -> it.status == Status.PAUSED
            Filter.DONE -> it.status == Status.DONE
            Filter.FAILED -> it.status == Status.ERROR
        }
    }.filter { query.isBlank() || it.displayName.contains(query, true) || it.url.contains(query, true) }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = contentPadding.calculateTopPadding() + 8.dp, bottom = contentPadding.calculateBottomPadding() + 96.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (clipOffer != null) item { ClipBanner(clipOffer, { onClipDownload(clipOffer) }, onClipDismiss) }
        item {
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), placeholder = { Text("Search downloads") },
                leadingIcon = { Icon(Icons.Rounded.Search, null) }, singleLine = true, shape = RoundedCornerShape(14.dp),
                trailingIcon = { if (query.isNotEmpty()) IconButton({ query = "" }) { Icon(Icons.Rounded.Close, null) } })
        }
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(Filter.entries.toList()) { f ->
                    val n = when (f) { Filter.ALL -> items.size; Filter.ACTIVE -> items.count { it.active }; Filter.PAUSED -> items.count { it.status == Status.PAUSED }
                        Filter.DONE -> items.count { it.status == Status.DONE }; Filter.FAILED -> items.count { it.status == Status.ERROR } }
                    FilterChip(filter == f, { filter = f }, label = { Text(if (n > 0) "${f.label} $n" else f.label) }, shape = RoundedCornerShape(10.dp))
                }
            }
        }
        if (shown.isEmpty()) item { Empty(items.isEmpty()) }
        items(shown, key = { it.id }) { d -> DownloadCard(d, onDelete = { confirm = d }) }
    }

    confirm?.let { d ->
        var withFile by remember { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("Remove download?") },
            text = {
                Column {
                    Text(d.displayName, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (d.status == Status.DONE && d.output != null) Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(withFile, { withFile = it }); Text("Also delete the file from the phone")
                    }
                }
            },
            confirmButton = {
                TextButton({
                    if (d.active || d.status == Status.PAUSED) DownloadService.send(ctx, DownloadService.ACT_CANCEL, d.id)
                    else {
                        if (withFile) d.output?.let { Files.delete(ctx, it) }
                        app.store.remove(d.id)
                    }
                    confirm = null
                }) { Text("Remove", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton({ confirm = null }) { Text("Keep") } },
        )
    }
}

@Composable
private fun ClipBanner(url: String, onDownload: () -> Unit, onDismiss: () -> Unit) {
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.primaryContainer) {
        Row(Modifier.padding(start = 14.dp, end = 6.dp, top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.ContentPaste, null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("Copied link", style = MaterialTheme.typography.titleSmall)
                Text(url, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onPrimaryContainer)
            }
            TextButton(onDownload) { Text("Download", fontWeight = FontWeight.Bold) }
            IconButton(onDismiss) { Icon(Icons.Rounded.Close, null) }
        }
    }
}

@Composable
private fun Empty(nothingAtAll: Boolean) {
    Column(Modifier.fillMaxWidth().padding(top = 56.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(64.dp).clip(RoundedCornerShape(20.dp)).background(Brush.linearGradient(listOf(Zest.Accent, Zest.AccentDeep))), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Download, null, tint = Color.White, modifier = Modifier.size(32.dp))
        }
        Text(if (nothingAtAll) "Nothing downloaded yet" else "Nothing here", style = MaterialTheme.typography.titleMedium)
        if (nothingAtAll) Text("Share a link to Zest from any app,\nor tap + to paste one.", style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DownloadCard(d: Download, onDelete: () -> Unit) {
    val ctx = LocalContext.current
    val open = {
        if (d.status == Status.DONE && d.output != null) {
            try { ctx.startActivity(Files.openIntent(ctx, d.output, d.mime)) }
            catch (_: Exception) { Toast.makeText(ctx, "No app on this phone opens this file type", Toast.LENGTH_SHORT).show() }
        }
    }
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).combinedClickable(onClick = open, onLongClick = onDelete)) {
        Column(Modifier.padding(14.dp).animateContentSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Thumb(d)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(d.displayName, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(3.dp))
                    Text(sub(d), style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace, fontSize = 11.5.sp),
                        color = when (d.status) { Status.ERROR -> MaterialTheme.colorScheme.error; Status.DONE -> if (MaterialTheme.colorScheme.background.luminance() > 0.5f) Zest.OkOnLight else Zest.Ok
                            Status.PAUSED -> Zest.Warn; else -> MaterialTheme.colorScheme.onSurfaceVariant },
                        maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Actions(d, onDelete)
            }
            if (d.status != Status.DONE) {
                val color = when (d.status) { Status.ERROR -> MaterialTheme.colorScheme.error; Status.PAUSED -> Zest.Warn; else -> MaterialTheme.colorScheme.primary }
                if (d.status == Status.RUNNING && d.totalBytes <= 0) LinearProgressIndicator(Modifier.fillMaxWidth().height(5.dp).clip(CircleShape), color = color)
                else LinearProgressIndicator({ d.progress }, Modifier.fillMaxWidth().height(5.dp).clip(CircleShape), color = color, trackColor = MaterialTheme.colorScheme.surfaceContainerHighest, drawStopIndicator = {})
            }
        }
    }
}

@Composable
private fun Thumb(d: Download) {
    val ext = Files.ext(d.displayName).uppercase().take(4).ifBlank { if (d.kind == Kind.MEDIA) "MP4" else "FILE" }
    val bg = when (ext) {
        "MP4", "MKV", "WEBM", "MOV" -> listOf(Color(0xFF7B5CFF), Color(0xFF4318B7))
        "MP3", "M4A", "OPUS", "WAV" -> listOf(Color(0xFF5BD98A), Color(0xFF2B8A57))
        "PDF" -> listOf(Color(0xFFFF6B6B), Color(0xFFC2304A))
        "ZIP", "RAR", "7Z" -> listOf(Color(0xFFF7B267), Color(0xFFE06C2B))
        "APK" -> listOf(Color(0xFF8BD17C), Color(0xFF3E8E41))
        else -> listOf(Color(0xFF8C8AB0), Color(0xFF55556A))
    }
    Box(Modifier.size(52.dp).clip(RoundedCornerShape(13.dp)).background(Brush.linearGradient(bg)), contentAlignment = Alignment.Center) {
        if (d.thumbnail != null) AsyncImage(d.thumbnail, null, Modifier.size(52.dp), contentScale = ContentScale.Crop)
        else Text(ext, color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 12.sp)
    }
}

@Composable
private fun Actions(d: Download, onDelete: () -> Unit) {
    val ctx = LocalContext.current
    when (d.status) {
        Status.RUNNING, Status.QUEUED -> IconButton({ DownloadService.send(ctx, DownloadService.ACT_PAUSE, d.id) }) { Icon(Icons.Rounded.Pause, "Pause") }
        Status.PAUSED -> IconButton({ DownloadService.send(ctx, DownloadService.ACT_RESUME, d.id) }) { Icon(Icons.Rounded.PlayArrow, "Resume", tint = MaterialTheme.colorScheme.primary) }
        Status.ERROR -> IconButton({ DownloadService.send(ctx, DownloadService.ACT_RESUME, d.id) }) { Icon(Icons.Rounded.Refresh, "Retry", tint = MaterialTheme.colorScheme.primary) }
        Status.DONE -> IconButton(onDelete) { Icon(Icons.Rounded.Delete, "Remove", tint = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

private fun sub(d: Download): String = when (d.status) {
    Status.DONE -> "${Files.human(d.totalBytes)} · Done"
    Status.ERROR -> d.error ?: "Failed"
    Status.PAUSED -> if (d.totalBytes > 0) "Paused · ${Files.human(d.downloadedBytes)} of ${Files.human(d.totalBytes)}" else "Paused"
    Status.QUEUED -> "Waiting…"
    Status.RUNNING -> buildString {
        if (d.itemCount > 1) append("${d.item}/${d.itemCount} · ")
        if (d.totalBytes > 0) append("${Files.human(d.downloadedBytes)} / ${Files.human(d.totalBytes)}") else append(if (d.downloadedBytes > 0) Files.human(d.downloadedBytes) else "Starting…")
        if (d.speed > 0) append(" · ${Files.human(d.speed)}/s")
        if (d.etaSec >= 0) append(" · ${Files.eta(d.etaSec)}")
    }
}

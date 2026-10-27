package app.zest.downloader.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Audiotrack
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.HighQuality
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.zest.downloader.ZestApp
import app.zest.downloader.engine.Files
import app.zest.downloader.engine.MediaEngine
import app.zest.downloader.engine.Probe
import app.zest.downloader.engine.Sites
import coil.compose.AsyncImage

/**
 * What to do with a link: for a video page, look it up and offer the
 * qualities it really has; for anything else, one button.
 * Used by the share sheet, the paste box and the in-app browser alike.
 */
private val STANDARD = listOf(2160, 1440, 1080, 720, 480, 360, 240, 144)

@Composable
fun LinkSheet(url: String, headers: Map<String, String> = emptyMap(), onDone: (started: Boolean) -> Unit) {
    val ctx = LocalContext.current
    val app = ZestApp.of(ctx)
    val media = Sites.isMedia(url)
    var probe by remember(url) { mutableStateOf<Probe?>(null) }
    var error by remember(url) { mutableStateOf<String?>(null) }
    var quality by remember(url) { mutableStateOf("best") }
    var playlist by remember(url) { mutableStateOf(false) }

    LaunchedEffect(url) {
        if (media) runCatching { app.media.probe(url, headers) }
            .onSuccess { p ->
                probe = p
                // Start on the best quality up to 1080p — the sweet spot for a phone
                quality = p.heights.filter { it in STANDARD }.firstOrNull { it <= 1080 }?.toString()
                    ?: p.heights.firstOrNull { it in STANDARD }?.toString() ?: "best"
            }
            .onFailure { error = MediaEngine.friendly(it.message) }
    }

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 16.dp).navigationBarsPadding(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(if (media) "Download video" else "Download file", style = MaterialTheme.typography.titleLarge)
        Text(url, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)

        if (!media) {
            Button(onClick = { app.enqueue(url, headers = headers); onDone(true) }, Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(14.dp)) {
                Icon(Icons.Rounded.Download, null); Spacer(Modifier.width(8.dp)); Text("Download")
            }
            return@Column
        }

        val p = probe
        when {
            error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            p == null -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.5.dp)
                Text("Reading the video…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AsyncImage(p.thumbnail, null, Modifier.width(132.dp).aspectRatio(16 / 9f).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceVariant), contentScale = ContentScale.Crop)
                    Column(Modifier.weight(1f)) {
                        Text(p.title, style = MaterialTheme.typography.titleSmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(Sites.site(url), p.uploader, if (p.duration > 0) "%d:%02d".format(p.duration / 60, p.duration % 60) else null).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                }
                val options = p.heights.filter { it in STANDARD }.map { h ->
                    h.toString() to "${h}p" + when (h) { 2160 -> "  ·  4K"; 1440 -> "  ·  2K"; 1080 -> "  ·  Full HD"; 720 -> "  ·  HD"; else -> "" }
                }.ifEmpty { listOf("best" to "Best available") } + listOf("audio" to "Audio only  ·  m4a")
                Column(Modifier.clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
                    options.forEach { (value, label) ->
                        val on = quality == value
                        Row(
                            Modifier.fillMaxWidth().clickable { quality = value }
                                .background(if (on) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh)
                                .padding(horizontal = 16.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(if (value == "audio") Icons.Rounded.Audiotrack else Icons.Rounded.HighQuality, null,
                                tint = if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(label, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium, modifier = Modifier.weight(1f))
                            if (on) Box(Modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(MaterialTheme.colorScheme.primary))
                        }
                    }
                }
                if (p.playlistCount > 1) Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { playlist = !playlist }.padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(playlist, { playlist = it })
                    Icon(Icons.AutoMirrored.Rounded.PlaylistPlay, null); Spacer(Modifier.width(8.dp))
                    Text("Whole playlist — ${p.playlistCount} videos")
                }
                Button(onClick = {
                    app.enqueue(url, quality, playlist, p.title, p.thumbnail, headers)
                    onDone(true)
                }, Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(14.dp)) {
                    Icon(Icons.Rounded.Download, null); Spacer(Modifier.width(8.dp))
                    Text(if (playlist) "Download ${p.playlistCount} videos" else "Download")
                }
            }
        }
        if (error != null) Button(onClick = { app.enqueue(url, headers = headers, forceFile = true); onDone(true) }, Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp)) {
            Text("Try as a plain file instead")
        }
        Text("Saved to Downloads/${Files.FOLDER}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

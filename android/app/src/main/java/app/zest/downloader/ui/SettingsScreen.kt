package app.zest.downloader.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.zest.downloader.BuildConfig
import app.zest.downloader.ZestApp
import app.zest.downloader.data.ThemeMode
import app.zest.downloader.engine.Files
import app.zest.downloader.engine.Sites
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun SettingsScreen(contentPadding: PaddingValues) {
    val ctx = LocalContext.current
    val app = ZestApp.of(ctx)
    val p by app.settings.prefs.collectAsState()
    val scope = rememberCoroutineScope()
    var ytdlp by remember { mutableStateOf<String?>(null) }
    var updating by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { ytdlp = withContext(Dispatchers.IO) { runCatching { app.media.ensureReady(); app.media.version() }.getOrNull() } }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)
        .padding(top = contentPadding.calculateTopPadding() + 8.dp, bottom = contentPadding.calculateBottomPadding() + 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {

        Group("Appearance") {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                ThemeMode.entries.forEachIndexed { i, m ->
                    SegmentedButton(p.theme == m, { app.settings.set { it.copy(theme = m) } }, SegmentedButtonDefaults.itemShape(i, ThemeMode.entries.size)) {
                        Text(when (m) { ThemeMode.SYSTEM -> "System"; ThemeMode.DARK -> "Dark"; ThemeMode.LIGHT -> "Light" })
                    }
                }
            }
        }

        Group("Downloads") {
            Label("Connections per file", "${p.connections}")
            Slider(p.connections.toFloat(), { v -> app.settings.set { it.copy(connections = v.toInt()) } }, valueRange = 1f..16f, steps = 14)
            Hint("Big files are split into this many pieces downloaded at once. 8 is a good default.")
            Label("Files at the same time", "${p.parallel}")
            Slider(p.parallel.toFloat(), { v -> app.settings.set { it.copy(parallel = v.toInt()) } }, valueRange = 1f..5f, steps = 3)
            Toggle("Only on Wi-Fi", "Wait for Wi-Fi before starting, to save mobile data", p.wifiOnly) { v -> app.settings.set { it.copy(wifiOnly = v) } }
            Hint("Files are saved to Downloads/${Files.FOLDER}.")
        }

        Group("Video engine") {
            Label("yt-dlp", ytdlp ?: "…")
            Hint("Downloads from ${Sites.names.joinToString(", ")}. Sites change every few weeks, so it updates itself once a day.")
            Toggle("Update automatically", null, p.autoUpdateYtDlp) { v -> app.settings.set { it.copy(autoUpdateYtDlp = v) } }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(enabled = !updating, onClick = {
                    updating = true; note = null
                    scope.launch {
                        val before = ytdlp
                        val r = runCatching { app.media.update() }
                        updating = false
                        r.onSuccess { v -> ytdlp = v; note = if (v == before) "Already up to date" else "Updated to $v"; app.settings.set { it.copy(ytDlpCheckedAt = System.currentTimeMillis()) } }
                            .onFailure { note = "Couldn't update: ${it.message}" }
                    }
                }, shape = RoundedCornerShape(12.dp)) { Text("Check for updates") }
                Spacer(Modifier.width(12.dp))
                if (updating) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }

        Group("About") {
            Label("Zest Downloader", "v${BuildConfig.VERSION_NAME}")
            Hint("Free and open source. No ads, no accounts, no tracking.")
            OutlinedButton({ ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/zexhanamin/zest-downloader")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) },
                shape = RoundedCornerShape(12.dp)) { Text("GitHub") }
            OutlinedButton({ app.store.clearFinished() }, shape = RoundedCornerShape(12.dp)) { Text("Clear finished from the list") }
        }
    }
}

@Composable
private fun Group(title: String, content: @Composable () -> Unit) {
    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
            content()
        }
    }
}

@Composable private fun Label(a: String, b: String) = Row(Modifier.fillMaxWidth()) {
    Text(a, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f)); Text(b, style = MaterialTheme.typography.labelLarge)
}
@Composable private fun Hint(t: String) = Text(t, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
@Composable private fun Toggle(t: String, sub: String?, on: Boolean, set: (Boolean) -> Unit) = Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    Column(Modifier.weight(1f)) { Text(t, style = MaterialTheme.typography.bodyMedium); sub?.let { Hint(it) } }
    Switch(on, set)
}

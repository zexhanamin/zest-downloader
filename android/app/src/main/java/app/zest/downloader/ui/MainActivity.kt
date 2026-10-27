package app.zest.downloader.ui

import android.Manifest
import android.content.ClipboardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import app.zest.downloader.R
import app.zest.downloader.ZestApp
import app.zest.downloader.engine.Sites
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val app = ZestApp.of(this)
        setContent {
            val prefs by app.settings.prefs.collectAsState()
            val dark = isDark(prefs.theme)
            // Status-bar icons follow the app's theme, not the phone's: a light Zest
            // on a dark-mode phone otherwise gets white icons on a white bar
            LaunchedEffect(dark) {
                val t = android.graphics.Color.TRANSPARENT
                val style = if (dark) SystemBarStyle.dark(t) else SystemBarStyle.light(t, t)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }
            ZestTheme(prefs.theme) { Main() }
        }
    }
}

private enum class Tab(val label: String) { DOWNLOADS("Downloads"), BROWSER("Browser"), SETTINGS("Settings") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Main() {
    val ctx = LocalContext.current
    val app = ZestApp.of(ctx)
    var tab by rememberSaveable { mutableStateOf(Tab.DOWNLOADS) }
    var sheet by remember { mutableStateOf<Pair<String, Map<String, String>>?>(null) }
    var adding by remember { mutableStateOf(false) }
    var clip by remember { mutableStateOf<String?>(null) }
    val browser = remember { BrowserState(ctx) { url, headers -> sheet = url to headers } }
    // A short screen (a phone on its side) has no room for a floating button over the list
    val short = LocalConfiguration.current.screenHeightDp < 480

    // Notifications are how a running download shows itself; ask once
    val notifPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val storagePerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
        if (Build.VERSION.SDK_INT < 29) storagePerm.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
    }

    // Copied a link somewhere else? Offer it the moment Zest is opened.
    // Android only lets the app in front read the clipboard, so this is the moment.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        clip = null
        val cm = ctx.getSystemService(ClipboardManager::class.java)
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            val text = runCatching { cm.primaryClip?.getItemAt(0)?.coerceToText(ctx)?.toString() }.getOrNull()
            val url = Sites.firstUrl(text)
            if (url != null && url != app.settings.now.lastClipOffer && app.store.items.value.none { it.url == url }) clip = url
        }, 350)
    }

    Scaffold(
        topBar = {
            if (tab != Tab.BROWSER) TopAppBar(title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Image(painterResource(R.drawable.zest_logo), null, Modifier.size(30.dp).clip(RoundedCornerShape(9.dp)))
                    Spacer(Modifier.width(10.dp))
                    Text(if (tab == Tab.SETTINGS) "Settings" else "Zest", style = MaterialTheme.typography.headlineSmall)
                }
            }, actions = {
                if (tab == Tab.DOWNLOADS && short) TextButton({ adding = true }) { Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(6.dp)); Text("Add link") }
            })
        },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(tab == t, { tab = t }, label = { Text(t.label) }, icon = {
                        Icon(when (t) { Tab.DOWNLOADS -> Icons.Rounded.Download; Tab.BROWSER -> Icons.Rounded.Language; Tab.SETTINGS -> Icons.Rounded.Settings }, null)
                    })
                }
            }
        },
        floatingActionButton = {
            if (tab == Tab.DOWNLOADS && !short) ExtendedFloatingActionButton(onClick = { adding = true }, icon = { Icon(Icons.Rounded.Add, null) }, text = { Text("Add link") },
                containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary, shape = RoundedCornerShape(18.dp))
        },
    ) { pad ->
        when (tab) {
            Tab.DOWNLOADS -> DownloadsScreen(clip,
                onClipDownload = { u -> app.settings.set { it.copy(lastClipOffer = u) }; clip = null; sheet = u to emptyMap() },
                onClipDismiss = { app.settings.set { it.copy(lastClipOffer = clip ?: "") }; clip = null }, pad)
            Tab.BROWSER -> BrowserScreen(browser, pad)
            Tab.SETTINGS -> SettingsScreen(pad)
        }
    }

    if (adding) AddLinkSheet(onDismiss = { adding = false }) { url -> adding = false; sheet = url to emptyMap() }

    sheet?.let { (url, headers) ->
        ModalBottomSheet(onDismissRequest = { sheet = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            LinkSheet(url, headers) { started -> sheet = null; if (started) tab = Tab.DOWNLOADS }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddLinkSheet(onDismiss: () -> Unit, onUrl: (String) -> Unit) {
    val ctx = LocalContext.current
    var text by remember { mutableStateOf("") }
    LaunchedEffect(Unit) {
        delay(150)
        Sites.firstUrl(runCatching { ctx.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(ctx)?.toString() }.getOrNull())?.let { text = it }
    }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 20.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Add a link", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), placeholder = { Text("https://…") }, singleLine = true, shape = RoundedCornerShape(14.dp),
                trailingIcon = {
                    TextButton({
                        Sites.firstUrl(runCatching { ctx.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(ctx)?.toString() }.getOrNull())?.let { text = it }
                    }) { Icon(Icons.Rounded.ContentPaste, null); Spacer(Modifier.width(4.dp)); Text("Paste") }
                })
            Text("Files, videos from ${Sites.names.take(3).joinToString(", ")} and more, or a whole YouTube playlist.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button({ Sites.firstUrl(text)?.let(onUrl) }, Modifier.fillMaxWidth().height(52.dp), enabled = Sites.firstUrl(text) != null, shape = RoundedCornerShape(14.dp)) {
                Text("Continue")
            }
        }
    }
}

package app.zest.downloader.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.zest.downloader.ZestApp
import app.zest.downloader.engine.Files

/** The JavaScript button calls this; it never runs on the UI thread, so it posts there */
class ZestJsBridge(private val onPage: (url: String) -> Unit, private val onFile: (url: String, title: String) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    @JavascriptInterface
    fun download(kind: String, url: String, title: String) {
        main.post { if (kind == "file") onFile(url, title) else onPage(url) }
    }
}

/**
 * Browser state lives with the activity, not the screen: switching to the
 * Downloads tab and back must not reload the page you were watching.
 */
class BrowserState(ctx: Context, onMedia: (url: String, headers: Map<String, String>) -> Unit) {
    var url by mutableStateOf("")
    var title by mutableStateOf("")
    var progress by mutableStateOf(0f)
    var home by mutableStateOf(true)
    private val app = ZestApp.of(ctx)
    private val script: String = ctx.assets.open("zest-inject.js").bufferedReader().use { it.readText() }

    fun headersFor(target: String, ua: String? = null): Map<String, String> = buildMap {
        CookieManager.getInstance().getCookie(target)?.let { put("Cookie", it) }
        web.url?.let { put("Referer", it) }
        put("User-Agent", ua ?: web.settings.userAgentString)
    }

    @SuppressLint("SetJavaScriptEnabled")
    val web: WebView = WebView(ctx).apply {
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        // Dark until a page paints, so an empty WebView never flashes white
        setBackgroundColor(android.graphics.Color.parseColor("#0F0E14"))
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.setSupportZoom(true); settings.builtInZoomControls = true; settings.displayZoomControls = false
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

        addJavascriptInterface(ZestJsBridge(
            onPage = { onMedia(it, headersFor(it)) },
            onFile = { u, t ->
                app.enqueue(u, headers = headersFor(u), forceFile = true, title = t)
                Toast.makeText(ctx, "Downloading in Zest", Toast.LENGTH_SHORT).show()
            },
        ), "ZestBridge")

        // Every download a page starts is Zest's — the phone version of the extension's capture
        setDownloadListener { dl, ua, disposition, mime, _ ->
            // guessFileName tacks ".bin" onto anything served as octet-stream; read the
            // name the way the desktop app does instead
            val name = Files.nameFrom(dl, disposition, mime?.takeUnless { it.startsWith("application/octet-stream") })
            app.enqueue(dl, headers = headersFor(dl, ua), fileName = name, forceFile = true)
            Toast.makeText(ctx, "Zest is downloading $name", Toast.LENGTH_SHORT).show()
        }

        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.scheme == "http" || u.scheme == "https") return false
                // intent://, market:// … hand those to the phone, unless it is a site trying to bounce us into its app
                if (u.scheme == "intent" && (u.toString().contains("youtube") || u.toString().contains("instagram") || u.toString().contains("tiktok"))) return true
                runCatching { ctx.startActivity(Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                return true
            }
            override fun onPageStarted(view: WebView, u: String, favicon: Bitmap?) { this@BrowserState.url = u; home = false }
            override fun onPageFinished(view: WebView, u: String) {
                this@BrowserState.url = u; this@BrowserState.title = view.title ?: ""
                view.evaluateJavascript(script, null)
            }
            override fun doUpdateVisitedHistory(view: WebView, u: String, isReload: Boolean) { this@BrowserState.url = u }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, p: Int) {
                this@BrowserState.progress = p / 100f
                // Single-page sites (YouTube) navigate without a page load; inject as the page fills
                if (p > 60) view.evaluateJavascript(script, null)
            }
            override fun onReceivedTitle(view: WebView, t: String?) { this@BrowserState.title = t ?: "" }
        }
    }

    fun go(input: String) {
        val t = input.trim()
        if (t.isEmpty()) return
        val target = when {
            t.startsWith("http://") || t.startsWith("https://") -> t
            t.contains('.') && !t.contains(' ') -> "https://$t"
            else -> "https://www.google.com/search?q=" + java.net.URLEncoder.encode(t, "UTF-8")
        }
        home = false
        web.loadUrl(target)
    }
}

private val QUICK = listOf(
    "YouTube" to "https://m.youtube.com", "Instagram" to "https://www.instagram.com", "TikTok" to "https://www.tiktok.com",
    "Facebook" to "https://m.facebook.com", "X" to "https://x.com", "Reddit" to "https://www.reddit.com",
    "Vimeo" to "https://vimeo.com", "Google" to "https://www.google.com",
)

@Composable
fun BrowserScreen(state: BrowserState, contentPadding: PaddingValues) {
    val focus = LocalFocusManager.current
    var typing by androidx.compose.runtime.remember { mutableStateOf(false) }
    var field by androidx.compose.runtime.remember { mutableStateOf("") }
    BackHandler(enabled = !state.home) { if (state.web.canGoBack()) state.web.goBack() else state.home = true }

    Column(Modifier.fillMaxSize().padding(top = contentPadding.calculateTopPadding(), bottom = contentPadding.calculateBottomPadding())) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!state.home) IconButton({ if (state.web.canGoBack()) state.web.goBack() else state.home = true }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") }
            TextField(
                value = if (typing) field else state.url.removePrefix("https://").removePrefix("www."),
                onValueChange = { field = it },
                modifier = Modifier.weight(1f).height(52.dp).onFocusChanged { if (it.isFocused && !typing) { typing = true; field = state.url } else if (!it.isFocused) typing = false },
                placeholder = { Text("Search or type a link") },
                leadingIcon = { Icon(Icons.Rounded.Language, null, Modifier.size(20.dp)) },
                singleLine = true, shape = RoundedCornerShape(26.dp),
                colors = TextFieldDefaults.colors(focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { state.go(field); focus.clearFocus() }),
            )
            if (!state.home) {
                IconButton({ state.web.reload() }) { Icon(Icons.Rounded.Refresh, "Reload") }
                IconButton({ state.home = true }) { Icon(Icons.Rounded.Home, "Home") }
            }
        }
        if (!state.home && state.progress < 1f) LinearProgressIndicator({ state.progress }, Modifier.fillMaxWidth().height(2.dp), drawStopIndicator = {})

        Box(Modifier.fillMaxSize()) {
            // The home grid replaces the WebView rather than covering it: an empty
            // WebView under an overlay painted white over the address bar
            if (state.home) Home { state.go(it) }
            // clipToBounds: a WebView with no page paints its background with drawColor,
            // which fills the whole clip, and Compose does not clip a view to its own
            // bounds — so an empty WebView painted over the address bar and the status bar.
            else AndroidView(
                factory = { (state.web.parent as? ViewGroup)?.removeView(state.web); state.web },
                modifier = Modifier.fillMaxSize().clipToBounds(),
            )
        }
    }
}

@Composable
private fun Home(open: (String) -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Browse & download", style = MaterialTheme.typography.headlineSmall)
            Text("Open any site here. Every file you download is caught by Zest, and videos get a Download button right on the player.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            LazyVerticalGrid(GridCells.Fixed(4), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(QUICK) { (name, url) ->
                    Column(Modifier.clip(RoundedCornerShape(16.dp)).clickable { open(url) }.padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.size(54.dp).clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
                            Text(name.take(1), fontWeight = FontWeight.ExtraBold, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
                        }
                        Spacer(Modifier.height(6.dp))
                        Text(name, style = MaterialTheme.typography.labelMedium, maxLines = 1)
                    }
                }
            }
        }
    }
}

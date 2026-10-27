package app.zest.downloader.share

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import app.zest.downloader.ZestApp
import app.zest.downloader.engine.Sites
import app.zest.downloader.ui.LinkSheet
import app.zest.downloader.ui.ZestTheme

/**
 * "Share → Zest" from any app. For a video it floats the quality picker
 * over the app you shared from; for a plain file link it just starts.
 * Either way you never leave what you were doing.
 */
class ShareActivity : ComponentActivity() {
    @OptIn(ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = ZestApp.of(this)
        val url = when (intent?.action) {
            Intent.ACTION_SEND -> Sites.firstUrl(intent.getStringExtra(Intent.EXTRA_TEXT)) ?: Sites.firstUrl(intent.getStringExtra(Intent.EXTRA_SUBJECT))
            Intent.ACTION_VIEW -> intent.dataString
            else -> null
        }
        if (url == null) {
            Toast.makeText(this, "No link to download in what was shared", Toast.LENGTH_SHORT).show()
            finish(); return
        }
        // "Open with Zest" on a file link: nothing to choose, so don't ask
        if (intent.action == Intent.ACTION_VIEW && !Sites.isMedia(url)) {
            app.enqueue(url, forceFile = true)
            Toast.makeText(this, "Downloading in Zest", Toast.LENGTH_SHORT).show()
            finish(); return
        }
        setContent {
            val prefs by app.settings.prefs.collectAsState()
            ZestTheme(prefs.theme) {
                ModalBottomSheet(onDismissRequest = { finish() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
                    LinkSheet(url) { started ->
                        if (started) Toast.makeText(this@ShareActivity, "Downloading in Zest", Toast.LENGTH_SHORT).show()
                        finish()
                    }
                }
            }
        }
    }
}

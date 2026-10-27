package app.zest.downloader.data

import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class ThemeMode { SYSTEM, DARK, LIGHT }

data class Prefs(
    val theme: ThemeMode = ThemeMode.SYSTEM,
    /** Parallel byte-range connections per file */
    val connections: Int = 8,
    /** Files downloading at the same time */
    val parallel: Int = 3,
    val wifiOnly: Boolean = false,
    val autoUpdateYtDlp: Boolean = true,
    val ytDlpCheckedAt: Long = 0,
    /** Last clipboard link offered, so the same one is not offered twice */
    val lastClipOffer: String = "",
    /** The floating download button (also needs Zest switched on in Accessibility) */
    val floatingButton: Boolean = true,
    /** Where the user dragged the floating button to; -1 until they do */
    val bubbleY: Int = -1,
)

class Settings(context: Context) {
    private val sp = context.getSharedPreferences("zest", Context.MODE_PRIVATE)
    private val _prefs = MutableStateFlow(read())
    val prefs: StateFlow<Prefs> = _prefs.asStateFlow()
    val now: Prefs get() = _prefs.value

    private fun read() = Prefs(
        theme = runCatching { ThemeMode.valueOf(sp.getString("theme", "SYSTEM")!!) }.getOrDefault(ThemeMode.SYSTEM),
        connections = sp.getInt("connections", 8).coerceIn(1, 16),
        parallel = sp.getInt("parallel", 3).coerceIn(1, 5),
        wifiOnly = sp.getBoolean("wifiOnly", false),
        autoUpdateYtDlp = sp.getBoolean("autoUpdateYtDlp", true),
        ytDlpCheckedAt = sp.getLong("ytDlpCheckedAt", 0),
        lastClipOffer = sp.getString("lastClipOffer", "") ?: "",
        floatingButton = sp.getBoolean("floatingButton", true),
        bubbleY = sp.getInt("bubbleY", -1),
    )

    fun set(f: (Prefs) -> Prefs) {
        val p = f(_prefs.value)
        sp.edit {
            putString("theme", p.theme.name)
            putInt("connections", p.connections)
            putInt("parallel", p.parallel)
            putBoolean("wifiOnly", p.wifiOnly)
            putBoolean("autoUpdateYtDlp", p.autoUpdateYtDlp)
            putLong("ytDlpCheckedAt", p.ytDlpCheckedAt)
            putString("lastClipOffer", p.lastClipOffer)
            putBoolean("floatingButton", p.floatingButton)
            putInt("bubbleY", p.bubbleY)
        }
        _prefs.value = p
    }
}

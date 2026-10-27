package app.zest.downloader.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import app.zest.downloader.data.ThemeMode

/** The desktop app's tokens, from index.html — one look across both */
object Zest {
    val Accent = Color(0xFF6D5DFC)
    val AccentDeep = Color(0xFF4E3FE0)
    val Lavender = Color(0xFFCFC6FF)
    val Ok = Color(0xFF5BD98A)
    /** The same green, deep enough to read on white */
    val OkOnLight = Color(0xFF248A4E)
    val Bad = Color(0xFFF46B6B)
    val Warn = Color(0xFFF7C46B)
}

private val Dark = darkColorScheme(
    primary = Zest.Accent, onPrimary = Color.White,
    primaryContainer = Color(0xFF2A2550), onPrimaryContainer = Zest.Lavender,
    secondary = Zest.Lavender, onSecondary = Color(0xFF16122E),
    background = Color(0xFF0F0E14), onBackground = Color(0xFFEDEDF0),
    surface = Color(0xFF16151C), onSurface = Color(0xFFEDEDF0),
    surfaceVariant = Color(0xFF1E1E24), onSurfaceVariant = Color(0xFF8888A0),
    surfaceContainer = Color(0xFF18181C), surfaceContainerHigh = Color(0xFF1E1E24),
    surfaceContainerHighest = Color(0xFF26262E), surfaceContainerLow = Color(0xFF141319),
    outline = Color(0xFF2A2A34), outlineVariant = Color(0xFF23232C),
    error = Zest.Bad,
)

private val Light = lightColorScheme(
    primary = Color(0xFF5B4DF0), onPrimary = Color.White,
    primaryContainer = Color(0xFFE6E2FF), onPrimaryContainer = Color(0xFF2B2170),
    secondary = Color(0xFF5B4DF0), onSecondary = Color.White,
    background = Color(0xFFF2F2F5), onBackground = Color(0xFF1A1A1E),
    surface = Color(0xFFFFFFFF), onSurface = Color(0xFF1A1A1E),
    surfaceVariant = Color(0xFFF0F0F5), onSurfaceVariant = Color(0xFF6B6B80),
    surfaceContainer = Color(0xFFFFFFFF), surfaceContainerHigh = Color(0xFFF7F7FA),
    surfaceContainerHighest = Color(0xFFEDEDF2), surfaceContainerLow = Color(0xFFF7F7FA),
    outline = Color(0xFFE0E0EA), outlineVariant = Color(0xFFEBEBF2),
    error = Color(0xFFD64545),
)

private val Type = Typography(
    headlineSmall = TextStyle(fontWeight = FontWeight.ExtraBold, fontSize = 24.sp, letterSpacing = (-0.5).sp),
    titleLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 20.sp, letterSpacing = (-0.3).sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
    bodyMedium = TextStyle(fontSize = 14.sp),
    bodySmall = TextStyle(fontSize = 12.5.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp),
)

@Composable
fun isDark(mode: ThemeMode) = when (mode) {
    ThemeMode.DARK -> true
    ThemeMode.LIGHT -> false
    ThemeMode.SYSTEM -> isSystemInDarkTheme()
}

@Composable
fun ZestTheme(mode: ThemeMode, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isDark(mode)) Dark else Light, typography = Type, content = content)
}

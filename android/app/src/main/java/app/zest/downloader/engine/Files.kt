package app.zest.downloader.engine

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.URLDecoder

/** Where finished downloads go: the public Downloads/Zest folder every file manager shows */
object Files {
    const val FOLDER = "Zest"

    /** Strip path tricks and characters no filesystem accepts; keep the name readable */
    fun sanitize(raw: String, fallback: String = "download"): String {
        var s = raw.substringAfterLast('/').substringAfterLast('\\')
        s = s.replace(Regex("[\\u0000-\\u001f\\u007f]"), "")
        s = s.replace(Regex("[<>:\"|?*]"), "_")
        s = s.trimStart('.').trimEnd('.', ' ').trim()
        if (s.isBlank()) s = fallback
        if (s.length > 180) {
            val ext = s.substringAfterLast('.', "").take(12)
            s = s.take(180 - ext.length - 1) + if (ext.isNotEmpty()) ".$ext" else ""
        }
        return s
    }

    fun ext(name: String) = name.substringAfterLast('.', "").lowercase()

    fun mimeFor(name: String, fallback: String = "application/octet-stream"): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext(name)) ?: fallback

    /** A file name from Content-Disposition (RFC 5987 first), else the URL path */
    fun nameFrom(url: String, disposition: String?, mime: String?): String {
        disposition?.let { cd ->
            Regex("filename\\*\\s*=\\s*[^']*''([^;]+)", RegexOption.IGNORE_CASE).find(cd)?.let {
                return sanitize(decode(it.groupValues[1].trim()))
            }
            Regex("filename\\s*=\\s*\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(cd)?.let {
                val n = it.groupValues[1].trim()
                if (n.isNotBlank()) return sanitize(decode(n))
            }
        }
        var n = sanitize(decode(Uri.parse(url).lastPathSegment ?: ""), "")
        if (n.isBlank()) n = "download"
        if (!n.contains('.') && mime != null) {
            MimeTypeMap.getSingleton().getExtensionFromMimeType(mime.substringBefore(';').trim())?.let { n = "$n.$it" }
        }
        return n
    }

    private fun decode(s: String) = try { URLDecoder.decode(s, "UTF-8") } catch (_: Exception) { s }

    /**
     * Write a finished download into Downloads/Zest[/sub] from one or more
     * sources in order — several sources is how a multi-connection download
     * is joined, in the same pass that publishes it. Returns the file's URI.
     */
    fun publish(ctx: Context, name: String, mime: String, sources: List<File>, sub: String = ""): String {
        val rel = Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER + if (sub.isNotBlank()) "/" + sanitize(sub) else ""
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, rel)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = ctx.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("Android refused to create the file in Downloads")
            try {
                resolver.openOutputStream(uri)!!.use { out -> sources.forEach { f -> f.inputStream().use { it.copyTo(out, 1 shl 16) } } }
                resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            } catch (e: Exception) {
                resolver.delete(uri, null, null)
                throw e
            }
            uri.toString()
        } else {
            @Suppress("DEPRECATION")
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), rel.removePrefix(Environment.DIRECTORY_DOWNLOADS + "/"))
            dir.mkdirs()
            val target = unique(dir, name)
            target.outputStream().use { out -> sources.forEach { f -> f.inputStream().use { it.copyTo(out, 1 shl 16) } } }
            MediaScannerConnection.scanFile(ctx, arrayOf(target.absolutePath), arrayOf(mime), null)
            Uri.fromFile(target).toString()
        }
    }

    private fun unique(dir: File, name: String): File {
        var f = File(dir, name)
        if (!f.exists()) return f
        val base = name.substringBeforeLast('.')
        val ext = name.substringAfterLast('.', "")
        var i = 1
        while (f.exists()) { f = File(dir, if (ext.isEmpty()) "$base ($i)" else "$base ($i).$ext"); i++ }
        return f
    }

    /** The name Android actually gave a published file — it adds " (1)" on a clash */
    fun displayName(ctx: Context, output: String, fallback: String): String {
        val uri = Uri.parse(output)
        if (uri.scheme == "file") return File(uri.path!!).name
        return runCatching {
            ctx.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull() ?: fallback
    }

    /** An intent that opens a finished download in whatever app handles it */
    fun openIntent(ctx: Context, output: String, mime: String): Intent {
        var uri = Uri.parse(output)
        if (uri.scheme == "file") uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", File(uri.path!!))
        return Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime.ifBlank { "*/*" })
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /** Remove a finished download's file from storage */
    fun delete(ctx: Context, output: String) {
        val uri = Uri.parse(output)
        try {
            if (uri.scheme == "file") File(uri.path!!).delete() else ctx.contentResolver.delete(uri, null, null)
        } catch (_: Exception) { }
    }

    fun human(bytes: Long): String {
        if (bytes <= 0) return "0 B"
        val u = arrayOf("B", "KB", "MB", "GB", "TB")
        var v = bytes.toDouble(); var i = 0
        while (v >= 1024 && i < u.size - 1) { v /= 1024; i++ }
        return if (i == 0) "$bytes B" else String.format("%.1f %s", v, u[i])
    }

    fun eta(sec: Long): String = when {
        sec < 0 -> ""
        sec < 60 -> "${sec}s left"
        sec < 3600 -> "${sec / 60}m ${sec % 60}s left"
        else -> "${sec / 3600}h ${(sec % 3600) / 60}m left"
    }

    fun copy(input: InputStream, out: OutputStream) = input.copyTo(out, 1 shl 16)
}

/** The sites whose pages are videos rather than files — the same nine as the desktop app */
object Sites {
    private val HOSTS = listOf(
        "YouTube" to Regex("(^|\\.)(youtube\\.com|youtu\\.be|youtube-nocookie\\.com)$"),
        "Instagram" to Regex("(^|\\.)instagram\\.com$"),
        "TikTok" to Regex("(^|\\.)tiktok\\.com$"),
        "Facebook" to Regex("(^|\\.)(facebook\\.com|fb\\.watch)$"),
        "X" to Regex("(^|\\.)(twitter\\.com|x\\.com)$"),
        "Reddit" to Regex("(^|\\.)(reddit\\.com|redd\\.it)$"),
        "Vimeo" to Regex("(^|\\.)vimeo\\.com$"),
        "Dailymotion" to Regex("(^|\\.)(dailymotion\\.com|dai\\.ly)$"),
        "Twitch" to Regex("(^|\\.)twitch\\.tv$"),
    )
    val names = HOSTS.map { it.first }

    fun site(url: String): String? {
        val host = runCatching { Uri.parse(url).host?.lowercase() }.getOrNull() ?: return null
        return HOSTS.firstOrNull { it.second.containsMatchIn(host) }?.first
    }

    fun isMedia(url: String) = site(url) != null

    /** A YouTube link carrying list= (but not a "Mix", which never ends) */
    fun hasPlaylist(url: String): Boolean {
        val list = runCatching { Uri.parse(url).getQueryParameter("list") }.getOrNull() ?: return false
        return site(url) == "YouTube" && !list.startsWith("RD")
    }

    /** Pull the first http(s) link out of shared text ("Check this out https://…") */
    fun firstUrl(text: String?): String? =
        text?.let { Regex("https?://[^\\s<>\"']+").find(it)?.value?.trimEnd('.', ',', ')', ']') }
}

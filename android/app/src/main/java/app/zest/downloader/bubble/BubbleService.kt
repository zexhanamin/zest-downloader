package app.zest.downloader.bubble

import android.accessibilityservice.AccessibilityService
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.Outline
import android.os.Handler
import android.os.Looper
import android.provider.Settings as SysSettings
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.Toast
import app.zest.downloader.R
import app.zest.downloader.ZestApp
import app.zest.downloader.engine.Sites
import app.zest.downloader.share.ShareActivity
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * The floating download button.
 *
 * A small tab rests on the screen's edge while a video app or a browser is in
 * front. One touch slides it out; a second takes the video on screen: in a
 * browser it reads the address bar, in an app it presses the app's own Share
 * and picks "Download with Zest" — the same quality sheet a manual share gets.
 * It tucks itself back after a few seconds, and can be dragged up and down.
 *
 * It needs Android's accessibility permission for exactly two things: to know
 * which app is in front, and to read or press those buttons. It reads nothing
 * else and keeps nothing.
 */
class BubbleService : AccessibilityService() {

    private val main = Handler(Looper.getMainLooper())
    private val scope = MainScope()
    private lateinit var wm: WindowManager
    private var view: FrameLayout? = null
    private var lp: WindowManager.LayoutParams? = null
    private var open = false
    private var anim: ValueAnimator? = null
    private var frontPkg: String? = null
    private var enabled = true

    private val dp get() = resources.displayMetrics.density
    private val size get() = (52 * dp).toInt()
    /** How much of the button shows while tucked away */
    private val peek get() = (16 * dp).toInt()
    private val tuck = Runnable { slide(false) }

    override fun onServiceConnected() {
        wm = getSystemService(WindowManager::class.java)
        val app = ZestApp.of(this)
        // Whatever is already open when the service starts counts too, not just what opens next
        frontPkg = rootInActiveWindow?.packageName?.toString()
        scope.launch {
            app.settings.prefs.collect { p -> enabled = p.floatingButton; Log.i(TAG, "enabled=$enabled"); refresh() }
        }
    }

    override fun onAccessibilityEvent(e: AccessibilityEvent) {
        if (e.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = e.packageName?.toString() ?: return
        // The shade, the keyboard and our own sheets come and go over an app without replacing it
        if (pkg in PASS_THROUGH) return
        // Our own windows (this button, the quality sheet) report as Zest; only Zest's main screen means Zest is in front
        if (pkg == packageName && e.className?.toString()?.endsWith(".MainActivity") != true) return
        if (pkg.contains("inputmethod") || pkg.contains("keyboard")) return
        frontPkg = pkg
        refresh()
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        scope.cancel()
        hide()
        super.onDestroy()
    }

    private fun wanted() = enabled && frontPkg.let { it != null && (it in VIDEO_APPS || it in BROWSERS.keys) }

    private fun refresh() = if (wanted()) show() else hide()

    // ── the button ──

    @SuppressLint("ClickableViewAccessibility")
    private fun show() {
        if (view != null) return
        // Just the Zest mark, no ring around it: a rounded square with a soft shadow
        val icon = ImageView(this).apply {
            setImageResource(R.drawable.zest_logo)
            scaleType = ImageView.ScaleType.FIT_CENTER
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(v: View, o: Outline) = o.setRoundRect(0, 0, v.width, v.height, 13 * dp)
            }
            clipToOutline = true
            elevation = 8 * dp
            contentDescription = "Download this video with Zest"
        }
        val inset = (5 * dp).toInt()
        val frame = FrameLayout(this).apply {
            addView(icon, FrameLayout.LayoutParams(size - 2 * inset, size - 2 * inset).apply { setMargins(inset, inset, inset, inset) }); alpha = 0.75f
        }
        val params = WindowManager.LayoutParams(size, size, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS, PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.END or Gravity.TOP
            x = -(size - peek)
            y = ZestApp.of(this@BubbleService).settings.now.bubbleY.takeIf { it >= 0 } ?: (resources.displayMetrics.heightPixels * 0.42f).toInt()
        }
        var downY = 0f; var startY = 0; var moved = false
        frame.setOnTouchListener { _, ev ->
            when (ev.action) {
                MotionEvent.ACTION_DOWN -> { downY = ev.rawY; startY = params.y; moved = false; main.removeCallbacks(tuck) }
                MotionEvent.ACTION_MOVE -> {
                    val dy = ev.rawY - downY
                    if (abs(dy) > 12 * dp) moved = true
                    if (moved) { params.y = (startY + dy).toInt().coerceIn(0, resources.displayMetrics.heightPixels - size); runCatching { wm.updateViewLayout(frame, params) } }
                }
                MotionEvent.ACTION_UP -> {
                    if (moved) ZestApp.of(this).settings.set { it.copy(bubbleY = params.y) }
                    else if (!open) slide(true) else grab()
                    if (open) main.postDelayed(tuck, 4000)
                }
            }
            true
        }
        runCatching { wm.addView(frame, params) }.onFailure { Log.w(TAG, "couldn't add the button", it); return }
        Log.i(TAG, "button shown")
        view = frame; lp = params; open = false
    }

    private fun hide() {
        main.removeCallbacks(tuck)
        anim?.cancel()
        view?.let { runCatching { wm.removeView(it) } }
        view = null; lp = null; open = false
    }

    /** Out to full size, or back to a sliver on the edge */
    private fun slide(out: Boolean) {
        val v = view ?: return; val p = lp ?: return
        open = out
        anim?.cancel()
        anim = ValueAnimator.ofInt(p.x, if (out) (6 * dp).toInt() else -(size - peek)).apply {
            duration = 220; interpolator = DecelerateInterpolator()
            addUpdateListener { p.x = it.animatedValue as Int; runCatching { wm.updateViewLayout(v, p) } }
            start()
        }
        v.animate().alpha(if (out) 1f else 0.75f).setDuration(220).start()
        if (out) main.postDelayed(tuck, 4000)
    }

    // ── taking the video ──

    private fun grab() {
        slide(false)
        val root = rootInActiveWindow ?: return say("Open a video first")
        val pkg = root.packageName?.toString()

        // A browser: the address bar already says where the video is
        BROWSERS[pkg]?.let { ids ->
            val text = ids.firstNotNullOfOrNull { id -> root.findAccessibilityNodeInfosByViewId("$pkg:id/$id").firstOrNull()?.text?.toString() }
            val url = text?.let { if (it.startsWith("http")) it else "https://$it" }?.let(Sites::firstUrl)
            if (url != null) return open(url)
        }

        // An app: press its own Share, then pick Zest in whatever sheet opens
        val share = find(root) { n -> label(n).let { l -> SHARE_WORDS.any { w -> l == w || l.startsWith("$w ") } } }
            ?: return say("Couldn't find this video's Share button — open the video first")
        click(share)
        pickZest(System.currentTimeMillis() + 5000, scrolled = 0)
    }

    /**
     * Wait for the app's share sheet, then take the shortest way from it to Zest:
     * Zest itself if it is listed; otherwise "Copy link" and let Zest read it;
     * otherwise "More", which opens Android's full list, where Zest always is.
     */
    private fun pickZest(deadline: Long, scrolled: Int, triedMore: Boolean = false) {
        main.postDelayed({
            val nodes = windows.mapNotNull { it.root } + listOfNotNull(rootInActiveWindow)
            val hit = { words: List<String> -> nodes.firstNotNullOfOrNull { r -> find(r) { n -> label(n) in words } } }
            val zest = hit(listOf(ZEST_LABEL.lowercase(), "zest"))
            val copy = if (zest == null) hit(COPY_WORDS) else null
            val more = if (zest == null && copy == null && !triedMore) hit(listOf("more", "more options", "more apps")) else null
            when {
                zest != null -> click(zest)
                copy != null -> { click(copy); main.postDelayed({ openFromClipboard() }, 350) }
                more != null -> { click(more); pickZest(deadline, scrolled, triedMore = true) }
                System.currentTimeMillis() > deadline -> say("Tap \"$ZEST_LABEL\" in the share menu")
                else -> {
                    // In Android's own list Zest can be further down: page it along, then look again
                    var s = scrolled
                    if (triedMore && s < 6) nodes.firstNotNullOfOrNull { r -> find(r) { it.isScrollable } }?.let {
                        if (it.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) s += 1
                    }
                    pickZest(deadline, s, triedMore)
                }
            }
        }, 450)
    }

    /** The link is on the clipboard now; only an app in front may read it, so Zest's sheet does */
    private fun openFromClipboard() {
        startActivity(Intent(this, ShareActivity::class.java).putExtra(ShareActivity.EXTRA_FROM_CLIPBOARD, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun open(url: String) {
        startActivity(Intent(this, ShareActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun say(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun label(n: AccessibilityNodeInfo) = (n.contentDescription ?: n.text)?.toString()?.trim()?.lowercase() ?: ""

    /** Depth-first, visible nodes only */
    private fun find(n: AccessibilityNodeInfo?, depth: Int = 0, pred: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (n == null || depth > 60 || !n.isVisibleToUser) return null
        if (pred(n)) return n
        for (i in 0 until n.childCount) find(n.getChild(i), depth + 1, pred)?.let { return it }
        return null
    }

    /** Labels often sit on a child of the thing that takes the press */
    private fun click(n: AccessibilityNodeInfo) {
        var c: AccessibilityNodeInfo? = n
        while (c != null && !c.isClickable) c = c.parent
        (c ?: n).performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }

    companion object {
        private const val TAG = "ZestBubble"
        const val ZEST_LABEL = "Download with Zest"
        private val COPY_WORDS = listOf("copy link", "copy", "copy url", "copy link address")
        private val SHARE_WORDS = listOf("share", "send post", "share post", "share video", "share reel")
        private val PASS_THROUGH = setOf("com.android.systemui", "android", "com.android.intentresolver", "com.google.android.apps.nexuslauncher")
        val VIDEO_APPS = setOf(
            "com.google.android.youtube", "app.revanced.android.youtube", "com.instagram.android", "com.zhiliaoapp.musically",
            "com.ss.android.ugc.trill", "com.facebook.katana", "com.facebook.lite", "com.twitter.android", "com.reddit.frontpage",
            "com.vimeo.android.videoapp", "com.dailymotion.dailymotion", "tv.twitch.android.app",
        )
        /** Each browser's address-bar view ids */
        val BROWSERS = mapOf(
            "com.android.chrome" to listOf("url_bar"), "com.chrome.beta" to listOf("url_bar"),
            "com.brave.browser" to listOf("url_bar"), "com.microsoft.emmx" to listOf("url_bar"),
            "com.opera.browser" to listOf("url_field"), "com.sec.android.app.sbrowser" to listOf("location_bar_edit_text"),
            "org.mozilla.firefox" to listOf("mozac_browser_toolbar_url_view", "url_bar_title"),
            "com.kiwibrowser.browser" to listOf("url_bar"), "com.vivaldi.browser" to listOf("url_bar"),
        )

        /** Whether the user has switched this service on in Android's accessibility settings */
        fun isOn(ctx: Context): Boolean {
            val me = ComponentName(ctx, BubbleService::class.java).flattenToString()
            val list = SysSettings.Secure.getString(ctx.contentResolver, SysSettings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return list.split(':').any { it.equals(me, ignoreCase = true) }
        }
    }
}

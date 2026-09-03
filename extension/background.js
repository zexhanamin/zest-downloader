/* ═══════════════════════════════════════════════
   Zest Downloader — extension/background.js
   MV3 Service Worker.
   Captures ALL download types:
   1. Direct file links (.zip, .rar, .mp4 etc)
   2. Token/redirect URLs (Content-Disposition)
   3. Magnet links (click + window.open)
   4. Blob URLs
   5. Dynamic JS-generated downloads
   6. Right-click context menu
═══════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────
// 127.0.0.1, not "localhost" — on some Windows setups localhost resolves to
// ::1 first and the app only listens on the IPv4 loopback.
const ZEST_BRIDGE_URL = 'http://127.0.0.1:6543';
const BRIDGE_TIMEOUT  = 4000;
const PING_ALARM      = 'zest-bridge-ping';

// File extensions to always capture
const CAPTURE_EXTS = new Set([
  // Archives
  'zip','rar','7z','tar','gz','bz2','xz','zst','tar.gz','tar.bz2',
  // Executables
  'exe','msi','dmg','pkg','deb','rpm','appimage','apk','ipa',
  // Video
  'mp4','mkv','avi','mov','wmv','flv','webm','m4v','ts','vob','mpg','mpeg',
  // Audio
  'mp3','flac','wav','aac','ogg','m4a','opus','wma',
  // Disk images
  'iso','img','bin','nrg',
  // Documents
  'pdf','epub','mobi',
  // Torrents
  'torrent',
]);

// MIME types that always mean binary download
const DOWNLOAD_MIMES = new Set([
  'application/octet-stream',
  'application/x-bittorrent',
  'application/zip','application/x-zip-compressed',
  'application/x-rar-compressed','application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-tar','application/gzip',
  'application/x-msdownload','application/x-msdos-program',
  'application/vnd.android.package-archive',
  'application/x-apple-diskimage',
  'application/x-iso9660-image',
  'application/pdf',
  'video/mp4','video/x-matroska','video/x-msvideo',
  'video/quicktime','video/webm','video/mpeg',
  'audio/mpeg','audio/flac','audio/wav','audio/aac',
  'audio/ogg','audio/x-m4a','audio/opus',
]);

// ─────────────────────────────────────────────
//  Storage helpers
// ─────────────────────────────────────────────
async function getSetting(key, fallback) {
  try {
    const res = await chrome.storage.local.get(key);
    return res[key] !== undefined ? res[key] : fallback;
  } catch (_) { return fallback; }
}

async function setSetting(key, value) {
  try { await chrome.storage.local.set({ [key]: value }); } catch (_) {}
}

// ─────────────────────────────────────────────
//  URL analysis helpers
// ─────────────────────────────────────────────
function isMagnet(url = '') {
  return url.startsWith('magnet:');
}

function getExtFromUrl(url = '') {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const parts = path.split('.');
    if (parts.length < 2) return '';
    return parts.pop().split('/')[0]; // handle trailing slashes
  } catch (_) { return ''; }
}

function getExtFromFilename(filename = '') {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function shouldCaptureUrl(url = '') {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return false;
  if (isMagnet(url)) return true;
  const ext = getExtFromUrl(url);
  return CAPTURE_EXTS.has(ext);
}

function shouldCaptureMime(mime = '') {
  const clean = mime.split(';')[0].trim().toLowerCase();
  return clean && DOWNLOAD_MIMES.has(clean);
}

function shouldCaptureFilename(filename = '') {
  if (!filename) return false;
  const base = filename.split(/[\\/]/).pop();
  const ext  = getExtFromFilename(base);
  return CAPTURE_EXTS.has(ext);
}

// Background XHR/fetch — never real user file downloads
/**
 * Request types that can be a download the user actually asked for.
 *
 * This has to be an allowlist. A denylist misses things, and the miss is
 * expensive: Gmail serves every inline image with
 * `Content-Disposition: attachment; filename="unnamed.png"`, so with `image`
 * left in, restoring a Gmail tab — on a new tab, a browser restart, or a PC
 * boot — fires off a download for every picture on the page.
 *
 * A real download is a top-level navigation or a request the page made
 * outside the normal resource pipeline. Everything else (images, media,
 * scripts, stylesheets, fonts, frames, XHR) is a page sub-resource and is
 * never a file the user chose to save.
 */
const DOWNLOADABLE_REQ_TYPES = new Set(['main_frame', 'other']);

// Known API endpoint slugs (Google, analytics, etc.)
const API_SLUGS = new Set([
  'batchexecute', 'browserinfo', 'redirect', 'log', 'collect',
  'beacon', 'sync', 'rpc', 'graphql', 'api', 'track', 'analytics',
  'gen_204', 'playlog', 'active', 'callback', 'jsc', 'complete',
]);

function getUrlSlug(url = '') {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '');
    return (p.split('/').filter(Boolean).pop() || '').split('?')[0].toLowerCase();
  } catch (_) { return ''; }
}

/**
 * @param {string}  url
 * @param {boolean} [confirmedFile] - the browser already told us this is a
 *   file: a real filename, or Content-Disposition: attachment.
 *
 * The extensionless-path rule is a guess used when nothing else is known.
 * Plenty of genuine downloads live on extensionless paths
 * (/cba/student/transcript, /tunnel/?id=…), so once the browser has
 * confirmed a file, that guess must not overrule it — only the explicit
 * API slug list still applies.
 */
function isApiLikeUrl(url = '', confirmedFile = false) {
  if (!url || isMagnet(url)) return false;
  const slug = getUrlSlug(url);
  if (API_SLUGS.has(slug)) return true;
  if (confirmedFile) return false;
  try {
    const u = new URL(url);
    // Extensionless short paths are usually API calls, not files
    if (!u.pathname.includes('.') && slug && slug.length < 48) return true;
  } catch (_) { return true; }
  return false;
}

/** Only http(s) and magnet can be handed to Zest — it cannot fetch blob:/data: */
function isFetchableByZest(url = '') {
  if (isMagnet(url)) return true;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch (_) { return false; }
}

/** Only capture when URL, filename, or magnet clearly indicates a real file */
function isRealFileDownload({ url, filename = '', mime = '' }) {
  if (isMagnet(url)) return true;
  if (shouldCaptureUrl(url)) return true;
  if (filename && shouldCaptureFilename(filename)) return true;
  // MIME alone is not enough — APIs often return octet-stream
  if (mime && shouldCaptureMime(mime) && filename && shouldCaptureFilename(filename)) return true;
  return false;
}

// ─────────────────────────────────────────────
//  De-duplication — avoid capturing same URL twice
//  within a short window (downloads.onCreated +
//  webRequest can both fire for the same request)
// ─────────────────────────────────────────────
const _recentlyCaptured = new Map(); // url → timestamp

function markCaptured(url) {
  _recentlyCaptured.set(url, Date.now());
  // cleanup old entries
  for (const [u, t] of _recentlyCaptured) {
    if (Date.now() - t > 30000) _recentlyCaptured.delete(u);
  }
}

function alreadyCaptured(url) {
  const t = _recentlyCaptured.get(url);
  return t && (Date.now() - t < 30000);
}

// ─────────────────────────────────────────────
//  Session hand-off
// ─────────────────────────────────────────────

/**
 * Collect the cookies the browser would have sent for this URL.
 *
 * Without them Zest is an anonymous HTTP client, and any download behind a
 * login (a university portal, a paid file host, anything with a session)
 * silently returns the sign-in page instead of the file — which then lands
 * on disk under the real filename and looks like a corrupt download.
 *
 * The header goes to the local app only, is kept in memory there, and is
 * never written to the queue database.
 */
async function cookieHeaderFor(url) {
  if (!/^https?:/i.test(url)) return '';
  try {
    const jar = await chrome.cookies.getAll({ url });
    if (!jar || !jar.length) return '';
    return jar.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (_) {
    return '';   // permission not granted, or an opaque origin
  }
}

// ─────────────────────────────────────────────
//  Send to Zest app via HTTP bridge
// ─────────────────────────────────────────────
async function sendToZest(payload) {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT);
    const res   = await fetch(`${ZEST_BRIDGE_URL}/add`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) return { ok: true };

    // A 4xx means Zest is running but turned this one down — that is a very
    // different problem from "the app isn't open", so don't blur the two.
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) detail = body.error;
    } catch (_) {}
    return { ok: false, error: detail, reachable: true };
  } catch (_) {
    return { ok: false, error: 'Zest Downloader is not running', reachable: false };
  }
}

// ─────────────────────────────────────────────
//  Capture handler — called from all intercept points
// ─────────────────────────────────────────────
/**
 * @param {object}  opts
 * @param {boolean} [opts.force] - the user picked this explicitly (context
 *   menu, popup). Skips the "does this look like a file?" heuristics, which
 *   exist to keep *automatic* capture quiet, not to overrule a deliberate click.
 */
async function captureDownload({ url, filename = '', referrer = '', mime = '', force = false }) {
  if (!url) return { ok: false, error: 'No URL' };
  if (alreadyCaptured(url)) return { ok: false, reason: 'duplicate' };
  if (!await getSetting('enabled', true)) return { ok: false, reason: 'disabled', error: 'Zest capture is off' };

  if (!force) {
    if (!isRealFileDownload({ url, filename, mime })) return { ok: false, reason: 'not-a-file' };
    if (isApiLikeUrl(url)) return { ok: false, reason: 'api-url' };
  }

  markCaptured(url);

  const type   = isMagnet(url) ? 'torrent' : 'http';
  const cookie = type === 'http' ? await cookieHeaderFor(url) : '';
  const result = await sendToZest({ type, url, filename, referrer, mime, cookie });

  const displayName = filename
    ? filename.split(/[\\/]/).pop()
    : url.split('/').pop().split('?')[0].slice(0, 50) || 'file';

  if (result.ok) {
    showNotification(
      type === 'torrent' ? '🧲 Magnet captured' : '⬇️ Download captured',
      displayName
    );
    logCapture({ url, type, filename, timestamp: Date.now() });
  } else {
    // A failed handoff must not be remembered, or a retry gets swallowed
    _recentlyCaptured.delete(url);
    if (result.reachable) {
      showNotification('Zest turned this down', result.error || 'Unsupported link', true);
    } else {
      showNotification('Zest not running', 'Open Zest Downloader first', true);
      await setSetting('bridge_connected', false);
      updateBadge(true, false);
    }
  }

  return result;
}

// ─────────────────────────────────────────────
//  Layer 1 — chrome.downloads.onCreated
//  Catches: direct link clicks, JS-triggered
//  downloads, any time Chrome shows a download bar
// ─────────────────────────────────────────────
chrome.downloads.onCreated.addListener(async (item) => {
  const url      = item.url || item.finalUrl || '';
  const filename = item.filename || '';
  const mime     = item.mime     || '';
  const referrer = item.referrer || '';

  // Every reason to bail has to be checked BEFORE cancelling. Cancelling
  // first and asking questions later is how a disabled extension, or one
  // whose app is closed, silently destroys the user's download.
  if (!await getSetting('enabled', true)) return;
  // Chrome opening a download entry IS the confirmation that this is a file,
  // whatever the URL looks like. Only refuse what Zest genuinely cannot fetch.
  if (!isFetchableByZest(url)) return;
  if (isApiLikeUrl(url, true)) return;

  const stopChrome = async () => {
    try {
      await chrome.downloads.cancel(item.id);
      await chrome.downloads.erase({ id: item.id });
    } catch (_) {}
  };

  // The webRequest layer usually sees the response headers first and has
  // already handed this to Zest. Chrome's copy still needs cancelling —
  // it just must not be sent a second time.
  if (alreadyCaptured(url) || alreadyCaptured(item.finalUrl || '')) {
    await stopChrome();
    return;
  }

  if (!await pingBridge()) return;        // app is down — let Chrome have it

  await stopChrome();

  // force: Chrome already classified this as a download, so the heuristics
  // that guard *guessing* from a bare URL have nothing left to add.
  const res = await captureDownload({ url, filename, referrer, mime, force: true });

  // Handoff failed after we already cancelled — give the download back
  if (!res.ok && res.reason !== 'duplicate') {
    try { await chrome.downloads.download({ url }); } catch (_) {}
  }
});

// ─────────────────────────────────────────────
//  Layer 2 — webRequest.onHeadersReceived
//  Catches: redirect/token URLs where Chrome
//  shows the download bar only AFTER following
//  redirects, so the link itself gives nothing away
// ─────────────────────────────────────────────
chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (!await getSetting('enabled', true)) return;
    // Page sub-resources are not downloads, whatever their headers claim
    if (!DOWNLOADABLE_REQ_TYPES.has(details.type)) return;

    const url     = details.url || '';
    const headers = details.responseHeaders || [];

    // Check Content-Disposition: attachment
    const cd = headers.find(h =>
      h.name.toLowerCase() === 'content-disposition'
    );
    if (!cd || !cd.value.toLowerCase().includes('attachment')) return;

    // Extract filename
    const fnMatch  = cd.value.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    const filename = fnMatch
      ? decodeURIComponent(fnMatch[1].replace(/['"]/g, '').trim())
      : '';

    // Check MIME type
    const ctHeader = headers.find(h => h.name.toLowerCase() === 'content-type');
    const mime     = ctHeader ? ctHeader.value.split(';')[0].trim() : '';

    // Content-Disposition: attachment is the server itself saying "this is a
    // file to save", which outranks any guess made from the URL shape.
    if (!isFetchableByZest(url)) return;
    if (isApiLikeUrl(url, true)) return;
    if (alreadyCaptured(url)) return; // downloads.onCreated may already handle it
    // Confirm the app is up before claiming this URL — downloads.onCreated
    // will cancel Chrome's copy on the strength of that claim.
    if (!await pingBridge()) return;

    await captureDownload({
      url,
      filename,
      referrer: details.initiator || '',
      mime,
      force: true,
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

// ─────────────────────────────────────────────
//  Layer 3 — webNavigation.onBeforeNavigate
//  Catches: window.open('magnet:...'), any
//  navigation to a magnet: URL
// ─────────────────────────────────────────────
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  const url = details.url || '';
  if (!isMagnet(url)) return;
  if (details.frameId !== 0) return;
  if (!await getSetting('enabled', true)) return;
  if (!await pingBridge()) return;   // app down — let the system handler have it

  const res = await captureDownload({ url, referrer: '' });

  // Only tear down the tab Chrome opened once Zest has actually taken it
  if (res.ok) {
    try { chrome.tabs.remove(details.tabId); } catch (_) {}
  }
});

// ─────────────────────────────────────────────
//  Layer 4 — context menu (right-click any link)
// ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id:       'zest-link',
      title:    'Download with Zest',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id:       'zest-image',
      title:    'Download image with Zest',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id:       'zest-video',
      title:    'Download video with Zest',
      contexts: ['video', 'audio'],
    });
    chrome.contextMenus.create({
      id:       'zest-magnet',
      title:    'Add magnet to Zest',
      contexts: ['link'],
      targetUrlPatterns: ['magnet:*'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.srcUrl || '';
  if (!url) return;
  // force: the user picked this from the menu, so don't second-guess the URL
  await captureDownload({ url, referrer: tab?.url || '', force: true });
});

// ─────────────────────────────────────────────
//  Layer 5 — messages from content.js
//  (magnet clicks, page-detected downloads)
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case 'CAPTURE': {
        const res = await captureDownload({
          url:      msg.url,
          filename: msg.filename || '',
          referrer: msg.referrer || sender.url || '',
          mime:     msg.mime     || '',
        });
        sendResponse(res);
        break;
      }

      // Manual add from the popup — the user typed it, so don't filter it
      case 'MANUAL_ADD': {
        const url = (msg.url || '').trim();
        if (!url) { sendResponse({ ok: false, error: 'No URL' }); return; }
        const res = await captureDownload({ url, referrer: '', force: true });
        sendResponse(res);
        break;
      }

      case 'GET_HISTORY': {
        const history = await getSetting('capture_history', []);
        sendResponse({ history });
        break;
      }

      case 'CLEAR_HISTORY': {
        await setSetting('capture_history', []);
        sendResponse({ ok: true });
        break;
      }

      case 'PAGE_MAGNETS': {
        await setSetting('page_magnets', { url: msg.pageUrl, magnets: msg.magnets });
        sendResponse({ ok: true });
        break;
      }

      case 'SET_ENABLED': {
        await setSetting('enabled', msg.enabled);
        updateBadge(msg.enabled, await getSetting('bridge_connected', false));
        sendResponse({ ok: true });
        break;
      }

      case 'GET_STATUS': {
        const enabled   = await getSetting('enabled', true);
        const history   = await getSetting('capture_history', []);
        const connected = await getSetting('bridge_connected', false);
        sendResponse({ enabled, captureCount: history.length, connected });
        break;
      }

      case 'PING_BRIDGE': {
        const fresh = await pingBridge();
        sendResponse({ connected: fresh });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown type' });
    }
  })();
  return true; // keep async channel open
});

// ─────────────────────────────────────────────
//  Bridge connection polling (chrome.alarms)
//  setInterval dies when service worker sleeps —
//  alarms survive and wake the worker back up.
// ─────────────────────────────────────────────
let _connected = false;

async function pingBridge() {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res   = await fetch(`${ZEST_BRIDGE_URL}/ping`, { signal: ctrl.signal });
    clearTimeout(timer);
    _connected = res.ok;
  } catch (_) {
    _connected = false;
  }
  await setSetting('bridge_connected', _connected);
  updateBadge(await getSetting('enabled', true), _connected);
  return _connected;
}

function startPingLoop() {
  chrome.alarms.create(PING_ALARM, { periodInMinutes: 1 });
  pingBridge(); // immediate check
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PING_ALARM) pingBridge();
});

startPingLoop();
chrome.runtime.onStartup.addListener(startPingLoop);
chrome.runtime.onInstalled.addListener(startPingLoop);

// ─────────────────────────────────────────────
//  Keyboard shortcut (Alt+Z) — declared in the
//  manifest, so it needs a handler to exist
// ─────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-extension') return;
  const next = !(await getSetting('enabled', true));
  await setSetting('enabled', next);
  updateBadge(next, await getSetting('bridge_connected', false));
  showNotification(
    next ? 'Zest capture on' : 'Zest capture off',
    next ? 'Downloads will be sent to Zest' : 'Downloads stay in the browser'
  );
});

// ─────────────────────────────────────────────
//  Badge
// ─────────────────────────────────────────────
function updateBadge(enabled, connected = true) {
  if (!enabled) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#888' });
  } else if (!connected) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#F46B6B' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeBackgroundColor({ color: '#5B5EF4' });
  }
}

// ─────────────────────────────────────────────
//  Notifications
// ─────────────────────────────────────────────
function showNotification(title, message, isError = false) {
  chrome.storage.local.get('notifications', (res) => {
    if (res.notifications === false) return;
    chrome.notifications.create({
      type:     'basic',
      iconUrl:  'icons/icon48.png',
      title,
      message:  message.slice(0, 100),
      priority: isError ? 2 : 0,
    });
  });
}

// ─────────────────────────────────────────────
//  History log
// ─────────────────────────────────────────────
async function logCapture(entry) {
  const history = await getSetting('capture_history', []);
  history.unshift(entry);
  if (history.length > 100) history.length = 100;
  await setSetting('capture_history', history);
}
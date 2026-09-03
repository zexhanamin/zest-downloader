/* ═══════════════════════════════════════════════
   Zest Downloader — content.js
   Runs on every page.

   Intercepts download link clicks before Chrome
   handles them — but ONLY while capture is enabled
   and the Zest app is actually reachable. If either
   is false the click is left completely alone, so
   turning Zest off never breaks a website.
═══════════════════════════════════════════════ */

'use strict';

(function () {
  if (window.__zestContentLoaded) return;
  window.__zestContentLoaded = true;

  // ─────────────────────────────────────────
  //  Arm state
  //  Click handling is synchronous, so the
  //  settings have to be cached up front.
  //  Default is "not armed": never swallow a
  //  click before we know Zest can take it.
  // ─────────────────────────────────────────
  let enabled   = false;
  let connected = false;
  const isArmed = () => enabled && connected;

  try {
    chrome.storage.local.get(['enabled', 'bridge_connected'], (res) => {
      if (chrome.runtime.lastError) return;
      enabled   = res.enabled !== false;      // default on
      connected = res.bridge_connected === true;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.enabled)          enabled   = changes.enabled.newValue !== false;
      if (changes.bridge_connected) connected = changes.bridge_connected.newValue === true;
    });
  } catch (_) { /* extension context torn down */ }

  // ─────────────────────────────────────────
  //  File extensions to capture
  // ─────────────────────────────────────────
  const CAPTURE_EXTS = new Set([
    'zip','rar','7z','tar','gz','bz2','xz','zst',
    'exe','msi','dmg','pkg','deb','rpm','appimage','apk','ipa',
    'mp4','mkv','avi','mov','wmv','flv','webm','m4v','ts','vob','mpg','mpeg',
    'mp3','flac','wav','aac','ogg','m4a','opus','wma',
    'iso','img','bin','nrg',
    'pdf','epub','mobi',
    'torrent',
  ]);

  // ─────────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────────
  function isMagnet(url) {
    return typeof url === 'string' && url.startsWith('magnet:');
  }

  function isDownloadUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('blob:') || url.startsWith('data:')) return false;
    if (isMagnet(url)) return true;
    try {
      const u = new URL(url, location.href);
      if (!['http:', 'https:'].includes(u.protocol)) return false;
      const slug = (u.pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
      const apiSlugs = ['batchexecute','browserinfo','redirect','log','collect','beacon','sync','rpc','graphql','api'];
      if (apiSlugs.includes(slug)) return false;
      const ext = u.pathname.toLowerCase().split('.').pop().split('/')[0];
      return CAPTURE_EXTS.has(ext);
    } catch (_) { return false; }
  }

  /**
   * Find a downloadable URL on an element or its ancestors.
   * Returns { url, fromAnchor } — anchors are safe to fully swallow,
   * everything else only gets preventDefault so page scripts still run.
   */
  function extractDownloadUrl(el) {
    if (!el) return null;
    let node = el;
    let depth = 0;

    while (node && depth < 6) {
      // 1. <a href> — direct link
      if (node.tagName === 'A') {
        const href = node.href || node.getAttribute('href') || '';
        if (isDownloadUrl(href)) return { url: href, fromAnchor: true };
        // <a download> means the link IS a download regardless of extension
        if (node.hasAttribute('download') && href &&
            !href.startsWith('#') && !href.startsWith('blob:') && !href.startsWith('data:')) {
          return { url: href, fromAnchor: true };
        }
      }

      // 2. data-* attributes — many sites store URLs here
      const dataAttrs = [
        'data-href', 'data-url', 'data-link', 'data-src',
        'data-download', 'data-file', 'data-magnet',
        'data-download-url', 'data-direct-url', 'data-original',
      ];
      for (const attr of dataAttrs) {
        const val = node.getAttribute(attr);
        if (val && isDownloadUrl(val)) return { url: val, fromAnchor: false };
        // Even if not a known extension, pick up any data-download
        if (attr === 'data-download' && val && val.startsWith('http')) {
          return { url: val, fromAnchor: false };
        }
      }

      // 3. onclick attribute text — extract URLs from inline handlers
      const onclick = node.getAttribute('onclick') || '';
      if (onclick) {
        const urlMatch = onclick.match(/(?:href|location|open|download)[^'"]*['"]([^'"]+)['"]/i);
        if (urlMatch && isDownloadUrl(urlMatch[1])) return { url: urlMatch[1], fromAnchor: false };
        // Magnet in onclick
        const magMatch = onclick.match(/(magnet:[^\s'"]+)/i);
        if (magMatch) return { url: magMatch[1], fromAnchor: false };
      }

      // 4. Any attribute that starts with magnet:
      for (const attr of node.attributes || []) {
        if (isMagnet(attr.value)) return { url: attr.value, fromAnchor: false };
      }

      node = node.parentElement;
      depth += 1;
    }
    return null;
  }

  // ─────────────────────────────────────────
  //  Send to background
  // ─────────────────────────────────────────
  function capture(url, anchorEl) {
    let settled = false;

    /**
     * @param {string}  why
     * @param {boolean} [quiet] - expected handoff, not a failure. The click
     *   handler cannot tell an extensionless download URL from a page link,
     *   so the background often declines one; the browser then loads it and
     *   the downloads listener picks it up. Nothing is wrong, so say nothing.
     */
    const fallback = (why, quiet = false) => {
      if (settled) return;
      settled = true;
      if (!quiet) showPageToast(`⚠ ${why} — opening normally`);
      // We already cancelled the click, so hand the download back to Chrome
      if (!isMagnet(url)) {
        try { window.location.href = url; } catch (_) {}
      }
    };

    try {
      chrome.runtime.sendMessage({
        type:     'CAPTURE',
        url,
        referrer: location.href,
        filename: anchorEl ? (anchorEl.getAttribute('download') || '') : '',
      }, (res) => {
        if (chrome.runtime.lastError) { fallback('Zest extension reloaded'); return; }
        if (res && res.ok) {
          settled = true;
          showPageToast('⬇ Sent to Zest Downloader');
          return;
        }
        // Duplicate clicks are not a failure — the first one was taken
        if (res && res.reason === 'duplicate') { settled = true; return; }
        // "not a file" / "API url" just means the downloads listener should
        // handle it instead, once the browser reveals what it really is
        const expected = res && (res.reason === 'not-a-file' || res.reason === 'api-url');
        fallback(res?.error || 'Zest could not take this', expected);
      });
    } catch (_) {
      fallback('Zest is not reachable');
    }
  }

  // ─────────────────────────────────────────
  //  Click interception (capture phase — runs
  //  before the page's own handlers)
  // ─────────────────────────────────────────
  function onClick(e) {
    if (!isArmed()) return;             // capture off, or app not running
    if (e.defaultPrevented) return;
    if (e.button !== 0 && e.type === 'click') return;

    const hit = extractDownloadUrl(e.target);
    if (!hit) return;

    e.preventDefault();
    // Only silence the page's own handlers for plain anchors. For URLs dug
    // out of data-* or onclick the site usually still needs its click.
    if (hit.fromAnchor) e.stopImmediatePropagation();

    capture(hit.url, e.target.closest && e.target.closest('a'));
  }

  document.addEventListener('click', onClick, true);

  // Middle-click / ctrl+click also opens in a new tab
  document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    if (!isArmed()) return;
    const hit = extractDownloadUrl(e.target);
    if (!hit) return;
    e.preventDefault();
    if (hit.fromAnchor) e.stopImmediatePropagation();
    capture(hit.url, e.target.closest && e.target.closest('a'));
  }, true);

  // ─────────────────────────────────────────
  //  Scan page for magnet links → popup
  //  "On this page" tab
  // ─────────────────────────────────────────
  let _lastMagnetKey = '';

  function scanMagnets() {
    const anchors = document.querySelectorAll('a[href^="magnet:"]');
    if (!anchors.length) return;

    const magnets = [...anchors].map(a => ({
      url:   a.href,
      label: (a.textContent.trim() || a.title || a.href).slice(0, 80),
    }));

    // Skip the round-trip when nothing actually changed
    const key = magnets.map(m => m.url).join('|');
    if (key === _lastMagnetKey) return;
    _lastMagnetKey = key;

    try {
      chrome.runtime.sendMessage({
        type:    'PAGE_MAGNETS',
        pageUrl: location.href,
        magnets,
      }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  // A subtree observer on a busy SPA fires thousands of times a second.
  // Coalesce into at most one scan per second, when the page is idle.
  let _scanTimer = null;
  function scheduleScan() {
    if (_scanTimer) return;
    _scanTimer = setTimeout(() => {
      _scanTimer = null;
      if (document.hidden) return;
      scanMagnets();
    }, 1000);
  }

  // ─────────────────────────────────────────
  //  On-page toast (no popup needed)
  // ─────────────────────────────────────────
  function showPageToast(text) {
    document.getElementById('__zest_toast')?.remove();

    const el = document.createElement('div');
    el.id = '__zest_toast';
    el.textContent = text;
    el.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
      'background:#18181C', 'color:#EDEDF0', 'border:1px solid #2A2A34',
      'padding:10px 16px', 'border-radius:8px',
      'font:500 13px/1.4 system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.45)',
      'opacity:0', 'transform:translateY(8px)',
      'transition:opacity 160ms ease,transform 160ms ease',
      'pointer-events:none', 'max-width:320px',
    ].join(';');

    document.documentElement.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 200);
    }, 2800);
  }

  // ─────────────────────────────────────────
  //  Init
  // ─────────────────────────────────────────
  scanMagnets();

  new MutationObserver(scheduleScan)
    .observe(document.body || document.documentElement, {
      childList: true, subtree: true,
    });

})();

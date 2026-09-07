/* ═══════════════════════════════════════════════
   Zest Downloader — extension/video.js

   Puts a Download button over media on any page.

   Two different things live here, because a video on
   the web comes in two shapes:

   • A real file — an <img>, or a <video> whose src is
     an ordinary URL. Zest fetches that URL directly.
   • A player — YouTube, Instagram, TikTok and anything
     else feeding a <video> through MSE, where the src
     is a blob: that only exists inside this tab. There
     is no file to grab, so the *page* URL is handed to
     the app and yt-dlp resolves the real streams.

   One shared button follows the pointer rather than one
   injected per element: pages have hundreds of images,
   and adding a node inside each would be slow and would
   disturb layouts that were never expecting it.
═══════════════════════════════════════════════ */

'use strict';

(function () {
  if (window.__zestVideoLoaded) return;
  window.__zestVideoLoaded = true;

  const BTN_ID   = '__zest_dl_btn';
  const PAGE_ID  = '__zest_page_btn';
  const MIN_SIDE = 160;          // ignore icons, avatars and spacer images

  // ─────────────────────────────────────────
  //  Sites where the page URL is the download
  // ─────────────────────────────────────────
  const PLAYER_SITES = [
    { name: 'YouTube',   host: /(^|\.)(youtube\.com|youtu\.be)$/i, post: /^\/(watch|shorts\/)/, page: () => location.pathname === '/watch' || location.pathname.startsWith('/shorts/') },
    { name: 'Instagram', host: /(^|\.)instagram\.com$/i,           post: /^\/(p|reels?|tv|share)\//, page: () => /^\/(p|reels?|tv|share)\//.test(location.pathname) },
    { name: 'TikTok',    host: /(^|\.)tiktok\.com$/i,              post: /\/video\/\d+/, page: () => /\/video\/\d+/.test(location.pathname) },
    { name: 'Facebook',  host: /(^|\.)(facebook\.com|fb\.watch)$/i, post: /\/(videos|watch|reel)\//, page: () => /\/(videos|watch|reel)\//.test(location.pathname) },
    { name: 'X',         host: /(^|\.)(twitter\.com|x\.com)$/i,    page: () => /\/status\/\d+/.test(location.pathname) },
    { name: 'Reddit',    host: /(^|\.)reddit\.com$/i,              page: () => /\/comments\//.test(location.pathname) },
    { name: 'Vimeo',     host: /(^|\.)vimeo\.com$/i,               page: () => /^\/\d+/.test(location.pathname) },
    { name: 'Dailymotion', host: /(^|\.)dailymotion\.com$/i,       page: () => /\/video\//.test(location.pathname) },
    { name: 'Twitch',    host: /(^|\.)twitch\.tv$/i,               page: () => /\/videos\/\d+/.test(location.pathname) },
  ];

  /** The site whose player owns this page, if any */
  function playerSite() {
    return PLAYER_SITES.find(s => s.host.test(location.hostname)) || null;
  }

  /**
   * The post URL for a video playing inside a feed.
   *
   * TikTok's For You page plays real posts while the address bar still says
   * tiktok.com, and Instagram and Facebook do the same while scrolling. The
   * page URL is useless there, but the post links its own permalink nearby,
   * so walk up from the video and take the first link that looks like one.
   */
  function postUrlNear(el) {
    const site = playerSite();
    if (!site || !site.post) return null;

    let node = el;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      if (!node.querySelectorAll) continue;
      for (const a of node.querySelectorAll('a[href]')) {
        let href;
        try { href = new URL(a.getAttribute('href'), location.href); } catch (_) { continue; }
        if (site.host.test(href.hostname) && site.post.test(href.pathname)) return href.href;
      }
    }
    return null;
  }

  /** Is this page itself a downloadable video page? */
  function isPlayerPage() {
    const s = playerSite();
    if (!s) return false;
    try { return s.page(); } catch (_) { return false; }
  }

  // ─────────────────────────────────────────
  //  Reading a media element
  // ─────────────────────────────────────────

  /** A blob: or data: src exists only inside this tab — Zest cannot fetch it */
  function isFetchable(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  function videoSrc(el) {
    if (isFetchable(el.currentSrc)) return el.currentSrc;
    if (isFetchable(el.src)) return el.src;
    for (const source of el.querySelectorAll('source')) {
      const s = source.src || source.getAttribute('src');
      if (isFetchable(s)) return s;
    }
    return null;
  }

  /**
   * What clicking the button over this element should do.
   * @returns {{kind:'file'|'page'|'none', url?:string, why?:string}}
   */
  function planFor(el) {
    if (!el) return { kind: 'none' };

    if (el.tagName === 'IMG') {
      const url = el.currentSrc || el.src;
      if (isFetchable(url)) return { kind: 'file', url };
      return { kind: 'none', why: 'This image is embedded in the page, not a file' };
    }

    if (el.tagName === 'VIDEO') {
      const direct = videoSrc(el);
      if (direct) return { kind: 'file', url: direct };
      // Streamed through MSE — a page URL is the only usable handle
      if (isPlayerPage()) return { kind: 'page', url: location.href };
      // In a feed the address bar still shows the site root, but the post
      // that is playing links its own permalink somewhere close by.
      const near = postUrlNear(el);
      if (near) return { kind: 'page', url: near };
      return { kind: 'none', why: 'This player streams in pieces — Zest cannot grab it here' };
    }

    return { kind: 'none' };
  }

  /** Big enough that the user meant to look at it */
  function worthOffering(el) {
    const r = el.getBoundingClientRect();
    if (el.tagName === 'VIDEO') return r.width >= 120 && r.height >= 80;
    return r.width >= MIN_SIDE && r.height >= MIN_SIDE;
  }

  // ─────────────────────────────────────────
  //  Feedback that outlives the button
  // ─────────────────────────────────────────
  const TOAST_ID = '__zest_toast';

  function toast(text) {
    document.getElementById(TOAST_ID)?.remove();
    const el = document.createElement('div');
    el.id = TOAST_ID;
    el.textContent = text;
    el.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:70px', 'z-index:2147483647',
      'background:#18181C', 'color:#EDEDF0', 'border:1px solid #2A2A34',
      'padding:10px 15px', 'border-radius:9px', 'pointer-events:none',
      'font:500 13px/1.3 system-ui,sans-serif', 'max-width:320px',
      'box-shadow:0 8px 24px rgba(0,0,0,.45)',
    ].join(';');
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ─────────────────────────────────────────
  //  Quality menu
  //  A page video has several resolutions and
  //  picking silently is picking wrong for
  //  someone, so the button asks first.
  // ─────────────────────────────────────────
  const MENU_ID = '__zest_quality_menu';

  function closeMenu() {
    document.getElementById(MENU_ID)?.remove();
  }

  function showMenu(anchor, info, pageUrl) {
    closeMenu();

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    const r = anchor.getBoundingClientRect();
    menu.style.cssText = [
      'position:fixed', 'z-index:2147483647',
      `top:${Math.min(window.innerHeight - 260, r.bottom + 6)}px`,
      `left:${Math.min(window.innerWidth - 240, Math.max(8, r.left - 130))}px`,
      'width:228px', 'max-height:300px', 'overflow-y:auto',
      'background:#18181C', 'color:#EDEDF0',
      'border:1px solid #2A2A34', 'border-radius:10px',
      'box-shadow:0 8px 28px rgba(0,0,0,.5)',
      'font:500 13px/1.3 system-ui,sans-serif', 'padding:6px',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = info.title || 'Choose a quality';
    title.style.cssText = 'padding:7px 9px;color:#8888A0;font-size:11.5px;'
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    menu.appendChild(title);

    const pick = (quality, label) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.textContent = label;
      row.style.cssText = [
        'display:block', 'width:100%', 'text-align:left',
        'background:transparent', 'color:inherit', 'border:none',
        'padding:8px 9px', 'border-radius:6px', 'cursor:pointer',
        'font:500 13px/1.3 system-ui,sans-serif',
      ].join(';');
      row.addEventListener('mouseenter', () => { row.style.background = '#26262E'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      row.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        sendVideo(pageUrl, quality, label);
      });
      menu.appendChild(row);
    };

    (info.qualities || []).forEach(q => pick(q.id, q.label));
    if (!info.qualities || !info.qualities.length) pick('best', 'Best available');

    document.documentElement.appendChild(menu);

    // Any click elsewhere dismisses it
    setTimeout(() => {
      document.addEventListener('click', function once() {
        closeMenu();
        document.removeEventListener('click', once);
      });
    }, 0);
  }

  function sendVideo(pageUrl, quality, label) {
    toast(`Sending ${label}…`);
    try {
      chrome.runtime.sendMessage(
        { type: 'CAPTURE_VIDEO', url: pageUrl, quality },
        (res) => {
          if (chrome.runtime.lastError) { toast('Zest not running'); return; }
          toast(res && res.ok ? `✓ ${label} sent to Zest` : (res?.error || 'Could not send'));
        }
      );
    } catch (_) { toast('Zest not running'); }
  }
  /** Run at most once per `ms`, so mousemove stays cheap */
  function throttle(fn, ms) {
    let last = 0;
    return (...args) => {
      const now = Date.now();
      if (now - last < ms) return;
      last = now;
      fn(...args);
    };
  }

  // ─────────────────────────────────────────
  //  The hover button
  // ─────────────────────────────────────────
  let target = null;      // element the button currently belongs to
  let hideTimer = null;

  function button() {
    let btn = document.getElementById(BTN_ID);
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '⬇ Zest';
    btn.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'display:none',
      'background:#5B5EF4', 'color:#fff', 'border:none',
      'border-radius:8px', 'cursor:pointer',
      'font:600 12px/1 system-ui,sans-serif',
      'padding:7px 11px', 'box-shadow:0 2px 10px rgba(0,0,0,.45)',
    ].join(';');

    btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    btn.addEventListener('mouseleave', scheduleHide);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      grab(btn);
    });

    document.documentElement.appendChild(btn);
    return btn;
  }

  function place(el) {
    const btn = button();
    const r = el.getBoundingClientRect();
    // Top-right of the element, nudged inside so it never sits off-screen
    btn.style.top  = `${Math.max(6, r.top + 8)}px`;
    btn.style.left = `${Math.min(window.innerWidth - 90, r.right - 84)}px`;
    btn.style.display = '';
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.style.display = 'none';
      target = null;
    }, 350);
  }

  /** Ask the app what is on offer, then let the user choose */
  function askQuality(anchorEl, pageUrl) {
    const restore = anchorEl.textContent;
    anchorEl.disabled = true;
    anchorEl.textContent = 'Reading…';
    let finished = false;
    const done = () => {
      finished = true;
      anchorEl.disabled = false;
      anchorEl.textContent = restore;
    };
    setTimeout(() => { if (!finished) { done(); toast('Zest did not answer'); } }, 30000);

    try {
      chrome.runtime.sendMessage({ type: 'PROBE_VIDEO', url: pageUrl }, (res) => {
        done();
        if (chrome.runtime.lastError) { toast('Zest not running'); return; }
        if (!res || !res.ok) { toast(res?.error || 'Could not read that video'); return; }
        showMenu(anchorEl, res, pageUrl);
      });
    } catch (_) { done(); toast('Zest not running'); }
  }
  function grab(btn) {
    const plan = planFor(target);
    const original = btn.textContent;

    let settled = false;
    const say = (text) => {
      settled = true;
      btn.textContent = text;
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2200);
    };
    // The service worker can be asleep and never answer. Without a deadline
    // the button sits on 'Sending…' forever, which is what it did.
    setTimeout(() => { if (!settled) say('✕ No answer'); }, 12000);

    if (plan.kind === 'none') { say(plan.why ? '✕ Not a file' : '✕ Nothing here'); return; }

    // A player has several resolutions; a plain file has exactly one.
    // This branch owns its own label, so leave the button alone for it.
    if (plan.kind === 'page') { settled = true; askQuality(btn, plan.url); return; }

    btn.disabled = true;
    btn.textContent = 'Sending…';

    const message = { type: 'CAPTURE_MEDIA_FILE', url: plan.url, referrer: location.href };

    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) { say('Zest not running'); return; }
        if (res && res.ok) say('✓ Sent');
        else say(res?.error ? '✕ Refused' : '✕ Failed');
      });
    } catch (_) {
      say('Zest not running');
    }
  }

  /**
   * The media under the pointer, even when something is sitting on top of it.
   *
   * TikTok covers its player with a transparent click-catcher, so the event
   * target is that overlay and never the <video> — which is why the button
   * showed while the page was still loading and vanished the moment the real
   * player mounted. Look through the stack at the cursor instead of trusting
   * whatever happens to be on top.
   */
  function mediaUnderPointer(e) {
    const el = e.target;
    if (el && (el.tagName === 'IMG' || el.tagName === 'VIDEO')) return el;
    if (typeof document.elementsFromPoint !== 'function') return null;
    for (const node of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (node.id === BTN_ID || node.id === PAGE_ID) continue;
      if (node.tagName === 'IMG' || node.tagName === 'VIDEO') return node;
    }
    return null;
  }

  // Pointer tracking — one listener, no per-element nodes
  function onPointer(e) {
    const el = e.target;
    if (!el || !el.tagName) return;
    if (el.id === BTN_ID || el.id === PAGE_ID) return;

    const media = mediaUnderPointer(e);
    if (!media || !worthOffering(media)) {
      if (target && !target.contains(el)) scheduleHide();
      return;
    }

    clearTimeout(hideTimer);
    target = media;
    place(media);
  }

  document.addEventListener('mouseover', onPointer, true);
  // An overlay can swallow mouseover entirely, so also sample real movement
  document.addEventListener('mousemove', throttle(onPointer, 150), true);

  // Keep the button glued to its element while the page moves
  const reposition = () => { if (target && document.getElementById(BTN_ID)?.style.display !== 'none') place(target); };
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  // ─────────────────────────────────────────
  //  Page-level button on player sites
  //  (the video itself may never be hovered)
  // ─────────────────────────────────────────
  function pageButton() {
    const existing = document.getElementById(PAGE_ID);
    if (!isPlayerPage()) { existing?.remove(); return; }
    if (existing && existing.isConnected) return;

    const btn = document.createElement('button');
    btn.id = PAGE_ID;
    btn.type = 'button';
    btn.textContent = '⬇ Zest';
    btn.title = 'Download this video with Zest';
    btn.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483646',
      'background:#5B5EF4', 'color:#fff', 'border:none',
      'border-radius:18px', 'cursor:pointer',
      'font:600 13px/1 system-ui,sans-serif',
      'padding:9px 15px', 'box-shadow:0 2px 10px rgba(0,0,0,.35)',
    ].join(';');

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      askQuality(btn, location.href);
    });

    document.body?.appendChild(btn);
  }

  // ─────────────────────────────────────────
  //  Tell the popup what is on this page
  // ─────────────────────────────────────────
  let lastScanKey = '';

  function scanMedia() {
    const found = [];
    const seen = new Set();

    for (const el of document.querySelectorAll('video, img')) {
      if (!worthOffering(el)) continue;
      const plan = planFor(el);
      if (plan.kind === 'none' || !plan.url || seen.has(plan.url)) continue;
      seen.add(plan.url);
      found.push({
        kind: el.tagName === 'VIDEO' ? 'video' : 'image',
        url:  plan.url,
        page: plan.kind === 'page',
        label: (el.getAttribute('alt') || el.getAttribute('title') || document.title || plan.url).slice(0, 80),
      });
      if (found.length >= 40) break;
    }

    if (isPlayerPage() && !found.some(f => f.page)) {
      found.unshift({ kind: 'video', url: location.href, page: true,
                      label: document.title.slice(0, 80) });
    }

    // Storage writes are not free, and a busy page mutates constantly. Only
    // report when the set of media actually changed.
    const key = found.map(f => f.url).join('|');
    if (key === lastScanKey) return;
    lastScanKey = key;

    try {
      chrome.runtime.sendMessage(
        { type: 'PAGE_MEDIA', pageUrl: location.href, media: found },
        () => void chrome.runtime.lastError
      );
    } catch (_) {}
  }

  // ─────────────────────────────────────────
  //  Keep up with single-page navigation
  // ─────────────────────────────────────────
  let syncTimer = null;
  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      if (document.hidden) return;
      pageButton();
      scanMedia();
    }, 900);
  }

  pageButton();
  scanMedia();

  new MutationObserver(scheduleSync).observe(
    document.body || document.documentElement,
    { childList: true, subtree: true }
  );

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastScanKey = '';
      document.getElementById(BTN_ID)?.style.setProperty('display', 'none');
      target = null;
      pageButton();
      scanMedia();
    }
  }, 1000);
})();

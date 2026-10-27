/*
 * Zest Downloader — in-browser download button.
 *
 * The phone version of extension/video.js: there is no hover on a touch
 * screen, so the button sits on whichever video is most on screen. A video
 * with a real file behind it is fetched directly; a streaming player
 * (YouTube, Instagram, TikTok…) hands over the page or the post it belongs
 * to, and yt-dlp resolves the streams.
 */
(function () {
  if (window.__zestInjected) return;
  window.__zestInjected = true;

  var SITES = [
    { host: /(^|\.)youtube\.com$/, post: /^\/(watch|shorts\/)/, page: function () { return /^\/(watch|shorts\/)/.test(location.pathname); } },
    { host: /(^|\.)instagram\.com$/, post: /^\/(p|reels?|tv)\//, page: function () { return /^\/(p|reels?|tv)\//.test(location.pathname); } },
    { host: /(^|\.)tiktok\.com$/, post: /\/video\/\d+/, page: function () { return /\/video\/\d+/.test(location.pathname); } },
    { host: /(^|\.)(facebook\.com|fb\.watch)$/, post: /\/(videos|watch|reel)\//, page: function () { return /\/(videos|watch|reel)\//.test(location.pathname); } },
    { host: /(^|\.)(twitter\.com|x\.com)$/, page: function () { return /\/status\/\d+/.test(location.pathname); } },
    { host: /(^|\.)reddit\.com$/, page: function () { return /\/comments\//.test(location.pathname); } },
    { host: /(^|\.)vimeo\.com$/, page: function () { return /^\/\d+/.test(location.pathname); } },
    { host: /(^|\.)dailymotion\.com$/, page: function () { return /\/video\//.test(location.pathname); } },
    { host: /(^|\.)twitch\.tv$/, page: function () { return /\/videos\/\d+/.test(location.pathname); } }
  ];
  var site = null;
  for (var i = 0; i < SITES.length; i++) if (SITES[i].host.test(location.hostname)) site = SITES[i];

  /** In a feed the address bar shows the feed; the post links its own permalink nearby */
  function postNear(el) {
    if (!site || !site.post) return null;
    for (var n = el, d = 0; n && d < 8; d++, n = n.parentElement) {
      if (!n.querySelectorAll) continue;
      var links = n.querySelectorAll('a[href]');
      for (var j = 0; j < links.length; j++) {
        try {
          var u = new URL(links[j].getAttribute('href'), location.href);
          if (site.host.test(u.hostname) && site.post.test(u.pathname)) return u.href;
        } catch (e) {}
      }
    }
    return null;
  }

  function plan(v) {
    var src = v.currentSrc || v.src || '';
    if (/^https?:/.test(src)) return { kind: 'file', url: src };   // a real file
    if (site && site.page()) return { kind: 'page', url: location.href };
    var near = postNear(v);
    return near ? { kind: 'page', url: near } : null;               // blob: with nowhere to go
  }

  var btn = document.createElement('div');
  btn.setAttribute('data-zest', '1');
  btn.textContent = '⬇ Download';
  btn.style.cssText = 'position:fixed;z-index:2147483647;display:none;padding:10px 15px;border-radius:999px;' +
    'background:#6D5DFC;color:#fff;font:700 14px/1 system-ui,-apple-system,sans-serif;letter-spacing:.01em;' +
    'box-shadow:0 6px 22px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.18) inset;-webkit-tap-highlight-color:transparent;' +
    'user-select:none;-webkit-user-select:none;';
  var current = null;

  btn.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    if (!current) return;
    try { ZestBridge.download(current.kind, current.url, document.title || ''); } catch (err) {}
    btn.textContent = '✓ Sent to Zest';
    btn.style.background = '#2FA866';
    setTimeout(function () { btn.textContent = '⬇ Download'; btn.style.background = '#6D5DFC'; }, 1800);
  }, true);

  function tick() {
    if (!btn.isConnected) (document.body || document.documentElement).appendChild(btn);
    var best = null, area = 0, videos = document.querySelectorAll('video');
    for (var k = 0; k < videos.length; k++) {
      var r = videos[k].getBoundingClientRect();
      var visible = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (r.width < 160 || visible < 90) continue;
      if (r.width * visible > area) { area = r.width * visible; best = videos[k]; }
    }
    var p = best ? plan(best) : null, rect = best ? best.getBoundingClientRect() : null;
    // A watch page whose player has not created its <video> yet still deserves the button
    if (!p && site && site.page()) {
      var player = document.querySelector('#player, #player-container-id, .player-container, ytm-player');
      if (player) { p = { kind: 'page', url: location.href }; rect = player.getBoundingClientRect(); }
    }
    if (!p || !rect) { btn.style.display = 'none'; current = null; return; }
    current = p;
    btn.style.display = 'block';
    btn.style.top = Math.max(10, rect.top + 10) + 'px';
    btn.style.right = Math.max(10, innerWidth - rect.right + 10) + 'px';
  }

  setInterval(tick, 600);
  addEventListener('scroll', tick, { passive: true });
  tick();
})();

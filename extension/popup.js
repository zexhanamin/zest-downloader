/* ─────────────────────────────────────────────
   Popup script
───────────────────────────────────────────── */

// ── Escaping ───────────────────────────────
// Magnet labels come from page text and URLs come from remote sites, and
// both are interpolated into innerHTML below.
function esc(v = '') {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── State ──────────────────────────────────
let appEnabled     = true;
let captureHistory = [];
let pageMagnets    = [];

// ── Init ───────────────────────────────────
async function init() {
  // Get status from background
  const status = await msg({ type: 'GET_STATUS' });
  appEnabled = status.enabled ?? true;

  document.getElementById('enable-toggle').checked = appEnabled;
  updateStatusUI(appEnabled);

  // Load history
  const hist = await msg({ type: 'GET_HISTORY' });
  captureHistory = hist.history || [];
  renderHistory();

  // Check bridge connection
  checkBridge();

  // Load magnets from current tab
  loadPageMagnets();
}

// ── Bridge connection — instant cached status, then refresh ──
async function checkBridge() {
  // 1. Show cached status immediately (no waiting, no flicker)
  const cached = await msg({ type: 'GET_STATUS' });
  applyBridgeStatus(cached.connected);

  // 2. Ask background for a fresh ping (it has its own retry loop)
  const fresh = await msg({ type: 'PING_BRIDGE' });
  applyBridgeStatus(fresh.connected);
}

function applyBridgeStatus(connected) {
  if (connected) {
    setStatus('green', 'Zest is running');
  } else {
    setStatus('error', 'Zest not running — open the app');
  }
  document.getElementById('add-btn').disabled = false;
}

function setStatus(type, text) {
  const dot  = document.getElementById('status-dot');
  const txt  = document.getElementById('status-text');
  dot.className = `status-dot ${type === 'error' ? 'error' : type === 'off' ? 'off' : ''}`;
  txt.textContent = text;
}

// ── Enable toggle ───────────────────────────
document.getElementById('enable-toggle').addEventListener('change', async (e) => {
  appEnabled = e.target.checked;
  await msg({ type: 'SET_ENABLED', enabled: appEnabled });
  updateStatusUI(appEnabled);
});

function updateStatusUI(enabled) {
  const sub = document.getElementById('header-sub');
  sub.textContent = enabled ? 'Intercepting downloads' : 'Paused';
  sub.className   = enabled ? '' : 'header-sub text-red';
  if (!enabled) setStatus('off', 'Extension paused');
}

// ── Add URL button ──────────────────────────
document.getElementById('url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addUrl();
});

document.getElementById('add-btn').addEventListener('click', addUrl);

async function addUrl() {
  const input = document.getElementById('url-input');
  const url   = input.value.trim();
  if (!url) return;

  const btn = document.getElementById('add-btn');
  btn.disabled   = true;
  btn.textContent = '…';

  const res = await msg({ type: 'MANUAL_ADD', url });

  btn.disabled   = false;
  btn.textContent = 'Send';

  if (res.ok) {
    input.value = '';
    showToast('✓ Sent to Zest');
    const hist = await msg({ type: 'GET_HISTORY' });
    captureHistory = hist.history || [];
    renderHistory();
  } else {
    showToast(`✗ ${res.error || 'Failed — is Zest running?'}`);
  }
}

// ── History ─────────────────────────────────
function renderHistory() {
  const list  = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const count = document.getElementById('capture-count');

  count.textContent = captureHistory.length > 0 ? `${captureHistory.length} captured` : '';

  // Remove old items (keep empty placeholder)
  list.querySelectorAll('.history-item').forEach(el => el.remove());

  if (captureHistory.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  captureHistory.slice(0, 20).forEach(entry => {
    const name    = decodeURIComponent(
      (entry.url || '').split('/').pop().split('?')[0]
    ).slice(0, 50) || entry.url?.slice(0, 50) || '—';

    const typeLabel = entry.type === 'torrent' ? 'TOR' : 'HTTP';
    const typeClass = entry.type === 'torrent' ? 'tor' : 'http';
    const timeStr   = entry.timestamp ? relTime(entry.timestamp) : '';

    const el = document.createElement('div');
    el.className = 'history-item';
    el.innerHTML = `
      <span class="h-type ${typeClass}">${esc(typeLabel)}</span>
      <div class="h-info">
        <div class="h-name" title="${esc(entry.url)}">${esc(name)}</div>
        <div class="h-time">${esc(timeStr)}</div>
      </div>
      <button class="h-resend" title="Re-send to Zest">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1 4 1 10 7 10"/>
          <path d="M3.51 15a9 9 0 1 0 .49-3.5"/>
        </svg>
      </button>
    `;

    el.querySelector('.h-resend').addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await msg({ type: 'MANUAL_ADD', url: entry.url });
      showToast(res.ok ? '✓ Re-sent to Zest' : `✗ ${res.error || 'Zest not reachable'}`);
    });

    list.appendChild(el);
  });
}

async function clearHistory() {
  await msg({ type: 'CLEAR_HISTORY' });
  captureHistory = [];
  renderHistory();
  showToast('History cleared');
}

// ── What is on this page ─────────────────────
let pageMedia = [];

/**
 * Magnets and media are gathered by two different content scripts and stored
 * separately, so both are checked against the tab that is actually in front —
 * stale data from the last page is worse than an empty list.
 */
async function loadPageMagnets() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const magnets = await getStorage('page_magnets');
  pageMagnets = (magnets && magnets.url === tab.url) ? (magnets.magnets || []) : [];

  const media = await getStorage('page_media');
  pageMedia = (media && media.url === tab.url) ? (media.media || []) : [];

  renderMagnets();
}

function renderMagnets() {
  const list  = document.getElementById('magnets-list');
  const empty = document.getElementById('magnets-empty');

  list.querySelectorAll('.magnet-item').forEach(el => el.remove());

  if (pageMagnets.length === 0 && pageMedia.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  // Videos and images the page is showing. A `page` entry is a player whose
  // stream cannot be fetched directly — the app resolves it from the page URL.
  pageMedia.forEach(m => {
    const el = document.createElement('div');
    el.className = 'magnet-item';
    const icon = m.kind === 'video'
      ? '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>'
      : '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>';
    el.innerHTML = `
      <div class="magnet-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
      </div>
      <span class="magnet-label" title="${esc(m.url)}">${esc(m.label || m.url)}</span>
      <button class="magnet-send">Get</button>
    `;
    el.querySelector('.magnet-send').addEventListener('click', async () => {
      const res = await msg(m.page
        ? { type: 'CAPTURE_VIDEO', url: m.url }
        : { type: 'CAPTURE_MEDIA_FILE', url: m.url, referrer: m.url });
      showToast(res.ok ? '✓ Sent to Zest' : `✗ ${res.error || 'Zest not reachable'}`);
    });
    list.appendChild(el);
  });

  // Magnet links found on the page
  pageMagnets.forEach(m => {
    const el = document.createElement('div');
    el.className = 'magnet-item';
    el.innerHTML = `
      <div class="magnet-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M8.5 8.5a5 5 0 1 0 7 7"/>
          <path d="M4.5 4.5a10 10 0 1 0 15 15"/>
        </svg>
      </div>
      <span class="magnet-label" title="${esc(m.url)}">${esc(m.label || m.url.slice(20, 60))}</span>
      <button class="magnet-send">Add</button>
    `;

    el.querySelector('.magnet-send').addEventListener('click', async () => {
      const res = await msg({ type: 'MANUAL_ADD', url: m.url });
      showToast(res.ok ? '✓ Torrent sent to Zest' : `✗ ${res.error || 'Zest not reachable'}`);
    });

    list.appendChild(el);
  });
}

// ── Tab switching ────────────────────────────
function switchTab(tab, btn) {
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`panel-${tab}`).classList.add('active');
}

// ── Open settings ────────────────────────────
function openSettings() {
  chrome.runtime.openOptionsPage?.();
}

// ── Wire up buttons that used to have inline onclick=""
//    (Manifest V3's Content Security Policy blocks inline
//    event handlers entirely — addEventListener is required) ──
function bindStaticControls() {
  document.getElementById('tab-btn-history')?.addEventListener('click', function () {
    switchTab('history', this);
  });
  document.getElementById('tab-btn-magnets')?.addEventListener('click', function () {
    switchTab('magnets', this);
  });
  document.getElementById('clear-history-btn')?.addEventListener('click', clearHistory);
  document.getElementById('open-settings-btn')?.addEventListener('click', openSettings);
}

// ── Helpers ──────────────────────────────────
function msg(payload) {
  return chrome.runtime.sendMessage(payload).catch(() => ({ ok: false }));
}

function getStorage(key) {
  return chrome.storage.local.get(key).then(r => r[key] ?? null);
}

function relTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400)return `${Math.floor(diff/3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

let toastTimer;
function showToast(text) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const t = document.createElement('div');
  t.className   = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  toastTimer = setTimeout(() => t.remove(), 2200);
}

// ── Boot ─────────────────────────────────────
bindStaticControls();
init();
/* ═══════════════════════════════════════════════
   Zest Downloader — renderer.js  v3
   Fixed: live updates, polling, card rendering
═══════════════════════════════════════════════ */
'use strict';

// ─────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────
const state = {
  jobs:         [],
  // Two independent axes: the sidebar picks a kind of transfer,
  // the tabs above the list pick a status within it.
  activeView:   'downloads',   // downloads | torrents | completed
  activeFilter: 'all',         // all | downloading | paused | done | error
  defaultDir:   '',
  totalSpeed:   0,
  totalPeers:   0,
};

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024, s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${s[i]}`;
}

function fmtEta(secs) {
  if (!secs || secs <= 0) return '';
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m ${secs%60}s`;
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`;
}

function fileExt(name = '') {
  const ext = (name.split('.').pop() || 'FILE').toUpperCase();
  return ext.length > 4 ? 'FILE' : ext;
}

function safeDecode(s = '') {
  if (!s) return '';
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

/**
 * Filenames and error strings come straight from remote servers
 * (Content-Disposition, HTTP errors). They are interpolated into innerHTML
 * below, so every one of them has to be escaped or a hostile server can run
 * script inside the app window.
 */
function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Size text for a card. Every download shows one, always — a blank slot
 * reads as "something went wrong", and while a transfer is running the
 * total is the number people actually watch.
 */
function sizeLabel(job = {}) {
  const done  = Number(job.downloaded)  || 0;
  const total = Number(job.total_bytes) || 0;
  const finished = job.status === 'done' || job.status === 'seeding';

  if (finished)      return fmtBytes(total || done);
  if (total > 0)     return `${fmtBytes(done)} / ${fmtBytes(total)}`;
  if (done > 0)      return `${fmtBytes(done)} / unknown`;
  return 'Size unknown';
}

/**
 * Time remaining. Only meaningful while bytes are moving, so paused and
 * queued transfers say so rather than showing a stale number.
 */
function etaLabel(job = {}) {
  if (job.status === 'paused')  return 'Paused';
  if (job.status === 'queued')  return 'Waiting';
  if (job.status !== 'downloading') return '';
  const secs = Number(job.eta) || 0;
  if (secs > 0) return `${fmtEta(secs)} left`;
  return Number(job.total_bytes) > 0 ? 'Estimating…' : 'Unknown time';
}

/** Last segment of a path or URL, whichever slash it uses */
function baseName(p = '') {
  return String(p).split(/[\\/]/).pop() || '';
}

/**
 * What to call this transfer in the list.
 *
 * The raw `url` is a poor label: a local .torrent shows up as a full
 * `C:\Users\…` path, and a magnet is 200 characters of hex. Prefer the
 * resolved filename, then the magnet's own display name, then the last
 * segment of the URL with the query string dropped.
 */
function displayName(job = {}) {
  const fromFile = safeDecode(baseName(job.filename || ''));
  if (fromFile) return fromFile;

  const url = job.url || '';

  if (url.startsWith('magnet:')) {
    const dn = /[?&]dn=([^&]+)/i.exec(url);
    if (dn) {
      try { return decodeURIComponent(dn[1].replace(/\+/g, ' ')); }
      catch (_) { return dn[1]; }
    }
    const hash = /xt=urn:btih:([^&]+)/i.exec(url);
    return hash ? `Torrent ${hash[1].slice(0, 12)}…` : 'Magnet link';
  }

  let last = '';
  try { last = baseName(new URL(url).pathname); }
  catch (_) { last = baseName(url.split(/[?#]/)[0]); }
  return safeDecode(last) || 'Unknown file';
}

function iconClass(name = '', type = 'http') {
  if (type === 'torrent') return 'type-tor';
  const e = (name.split('.').pop() || '').toLowerCase();
  return { zip:'type-zip',rar:'type-zip',gz:'type-zip','7z':'type-zip',
    mp4:'type-mp4',mkv:'type-mp4',avi:'type-mp4',mov:'type-mp4',webm:'type-mp4',
    exe:'type-exe',msi:'type-exe',apk:'type-exe', pdf:'type-pdf' }[e] || 'type-def';
}

function badgeClass(s) {
  return { downloading:'badge-downloading',seeding:'badge-downloading',
    paused:'badge-paused', done:'badge-done',
    error:'badge-error', queued:'badge-queued', cancelled:'badge-queued' }[s] || 'badge-queued';
}

function badgeLabel(s) {
  return { downloading:'Downloading',seeding:'Seeding',paused:'Paused',
    done:'Done',error:'Error',queued:'Queued',cancelled:'Cancelled' }[s] || s;
}

/**
 * The row under the progress bar: speed and time remaining while running,
 * the outcome once it stops. Built in one place so the initial render and
 * the live patch can never drift apart.
 */
function footerStats(job = {}) {
  const parts = [];
  const stat  = (text, style = '') =>
    `<span class="progress-stat"${style ? ` style="${style}"` : ''}>${esc(text)}</span>`;

  if (job.status === 'downloading') {
    parts.push(stat(`↓ ${job.speed && job.speed !== '0 B/s' ? job.speed : '—'}`));
    const eta = etaLabel(job);
    if (eta) parts.push(stat(eta));
  } else if (job.status === 'seeding') {
    parts.push(stat('↑ Seeding'));
    parts.push(stat('Completed'));
  } else if (job.status === 'done') {
    parts.push(stat('Completed'));
  } else if (job.status === 'paused') {
    parts.push(stat('Paused'));
  } else if (job.status === 'queued') {
    parts.push(stat('Waiting…'));
  } else if (job.status === 'error') {
    parts.push(stat(job.error_msg || 'Failed', 'color:#F46B6B'));
  } else if (job.status === 'cancelled') {
    parts.push(stat('Cancelled'));
  }

  return parts.join('');
}

// ─────────────────────────────────────────────
//  Card builder
// ─────────────────────────────────────────────
function buildCard(job) {
  const isActive  = job.status === 'downloading' || job.status === 'seeding';
  const isDone    = job.status === 'done';
  const isPaused  = job.status === 'paused';
  const isError   = job.status === 'error';
  const isQueued  = job.status === 'queued';
  const isTorrent = job.type   === 'torrent';

  const rawName = displayName(job);
  const name = rawName.length > 60 ? rawName.slice(0,57)+'...' : rawName;
  const ext  = isTorrent ? 'TOR' : fileExt(rawName);

  const pct = job.total_bytes > 0
    ? Math.min(100, Math.round((job.downloaded / job.total_bytes) * 100))
    : (isDone ? 100 : 0);

  const fillCls = isDone ? 'done' : isPaused ? 'paused' : isError ? 'error' : isActive ? 'active' : '';

  const size = sizeLabel(job);

  // Action buttons
  const pauseBtn = `<button class="dl-action-btn" title="Pause" onclick="handlePause('${job.id}','${job.type}')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button>`;
  const resumeBtn = `<button class="dl-action-btn" title="Resume" onclick="handleResume('${job.id}','${job.type}')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>`;
  const retryBtn = `<button class="dl-action-btn" title="Retry" onclick="handleRetry('${job.id}','${job.type}')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></svg></button>`;
  const openBtn = `<button class="dl-action-btn" title="Open file" onclick="handleOpen('${job.id}')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>`;
  const folderBtn = `<button class="dl-action-btn" title="Show in folder" onclick="handleFolder('${job.id}')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>`;
  const cancelBtn = `<button class="dl-action-btn danger" title="Cancel" onclick="handleCancel('${job.id}','${job.type}')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  const removeBtn = `<button class="dl-action-btn danger" title="Remove" onclick="handleRemove('${job.id}')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>`;

  let actions = '';
  if (isActive)                                actions = pauseBtn  + folderBtn + cancelBtn;
  else if (isPaused || isQueued)               actions = resumeBtn + folderBtn + cancelBtn;
  else if (isDone)                             actions = openBtn   + folderBtn + removeBtn;
  else if (isError || job.status==='cancelled') actions = retryBtn  + removeBtn;

  const footLeft = footerStats(job);

  return `
    <div class="dl-card state-${job.status}" id="card-${job.id}" data-id="${job.id}" data-type="${job.type}" data-status="${job.status}">
      <div class="dl-card-top">
        <div class="dl-icon ${iconClass(rawName, job.type)}">${
          thumbs.get(job.id)
            ? `<img class="dl-thumb" src="${thumbs.get(job.id)}" alt="" />`
            : esc(ext)
        }</div>
        <div class="dl-info">
          <div class="dl-name" title="${esc(rawName)}">${esc(name)}</div>
          <div class="dl-meta">
            ${isTorrent ? '<span class="dl-badge badge-torrent">Torrent</span>' : ''}
            <span class="dl-badge ${badgeClass(job.status)}">${badgeLabel(job.status)}</span>
            <span class="dl-meta-item">${esc(size)}</span>
          </div>
        </div>
        <div class="dl-actions">${actions}</div>
      </div>
      <div class="dl-progress-wrap">
        <div class="progress-track">
          <div class="progress-fill ${fillCls}" id="fill-${job.id}" style="width:${pct}%"></div>
        </div>
        <div class="progress-foot">
          <div class="progress-left" id="foot-left-${job.id}">${footLeft}</div>
          <span class="progress-pct" id="foot-pct-${job.id}">${pct}%</span>
        </div>
      </div>
    </div>`.trim();
}

// ─────────────────────────────────────────────
//  Render list
// ─────────────────────────────────────────────
function filterJobs(jobs) {
  // 1. Sidebar view — which kind of transfer
  let out = jobs;
  const v = state.activeView;
  if      (v === 'downloads') out = out.filter(j => j.type !== 'torrent');
  else if (v === 'torrents')  out = out.filter(j => j.type === 'torrent');
  else if (v === 'completed') out = out.filter(j => j.status === 'done');

  // 2. Status tabs — which state within that view
  const f = state.activeFilter;
  if (f === 'downloading') return out.filter(j => j.status==='downloading'||j.status==='seeding'||j.status==='queued');
  if (f === 'paused')      return out.filter(j => j.status==='paused');
  if (f === 'done')        return out.filter(j => j.status==='done');
  if (f === 'error')       return out.filter(j => j.status==='error'||j.status==='cancelled');
  return out;
}

/** Set for one render when the whole list is being replaced, not trimmed */
let _skipExitAnimation = false;

// ─────────────────────────────────────────────
//  File previews
//  jobId → data URI. A separate set tracks jobs
//  already asked about, so the 1.5s poll does not
//  re-request an icon that came back empty.
// ─────────────────────────────────────────────
const thumbs  = new Map();
const asked   = new Set();

async function loadThumb(job) {
  if (job.status !== 'done' || asked.has(job.id) || !window.zest) return;
  asked.add(job.id);
  try {
    const res = await window.zest.queueFileIcon(job.id);
    if (!res?.icon) return;
    thumbs.set(job.id, res.icon);
    // Swap it into the card that is already on screen
    const holder = document.querySelector(`#card-${job.id} .dl-icon`);
    if (holder) {
      const img = document.createElement('img');
      img.className = 'dl-thumb';
      img.src = res.icon;
      img.alt = '';
      holder.replaceChildren(img);
    }
  } catch (_) { /* preview is cosmetic — never block the list on it */ }
}

function renderList() {
  const list    = document.getElementById('downloads-list');
  const empty   = document.getElementById('empty-state');
  if (!list) return;

  // Remove demo cards
  ['demo-1','demo-2','demo-3'].forEach(id => document.getElementById(id)?.remove());

  const visible = filterJobs(state.jobs);

  if (visible.length === 0) {
    empty && (empty.style.display = 'flex');
    list.querySelectorAll('.dl-card').forEach(el => el.remove());
    updateStatusBar();
    return;
  }

  empty && (empty.style.display = 'none');

  const existingIds = new Set([...list.querySelectorAll('.dl-card')].map(el => el.dataset.id));
  const visibleIds  = new Set(visible.map(j => j.id));

  // Remove stale. Switching view or tab replaces the whole list, so the
  // fade-out has to be skipped — otherwise cards from the previous view
  // linger for 200ms and throw off the insertion positions below.
  const instant = _skipExitAnimation;
  _skipExitAnimation = false;

  existingIds.forEach(id => {
    if (visibleIds.has(id)) return;
    const el = document.getElementById(`card-${id}`);
    if (!el) return;
    if (instant) { el.remove(); return; }
    el.style.opacity   = '0';
    el.style.transform = 'translateX(6px)';
    el.style.transition = 'all 200ms';
    setTimeout(() => el.remove(), 210);
  });

  // Add or patch
  visible.forEach((job, idx) => {
    const existing = document.getElementById(`card-${job.id}`);
    if (!existing) {
      const tmp = document.createElement('div');
      tmp.innerHTML = buildCard(job);
      const card = tmp.firstElementChild;
      const cards = [...list.querySelectorAll('.dl-card')];
      cards[idx] ? list.insertBefore(card, cards[idx]) : list.appendChild(card);
    } else {
      patchCard(existing, job);
    }
    loadThumb(job);
  });

  updateStatusBar();
}

// Lightweight patch — only update the changing parts
function patchCard(el, job) {
  if (!el) return;

  const fill    = document.getElementById(`fill-${job.id}`);
  const footL   = document.getElementById(`foot-left-${job.id}`);
  const footPct = document.getElementById(`foot-pct-${job.id}`);

  // The action buttons are chosen from the status, and patching never touches
  // them — so a status change has to rebuild, or a finished download keeps
  // showing Pause and Cancel.
  const statusChanged = el.dataset.status !== job.status;

  if (statusChanged || !fill || !footL || !footPct) {
    const tmp = document.createElement('div');
    tmp.innerHTML = buildCard(job);
    el.replaceWith(tmp.firstElementChild);
    return;
  }

  const pct = job.total_bytes > 0
    ? Math.min(100, Math.round((job.downloaded / job.total_bytes) * 100))
    : (job.status === 'done' ? 100 : 0);

  fill.style.width = `${pct}%`;
  footPct.textContent = `${pct}%`;

  fill.className = 'progress-fill ' + (
    job.status==='done'   ? 'done'   :
    job.status==='paused' ? 'paused' :
    job.status==='error'  ? 'error'  :
    (job.status==='downloading'||job.status==='seeding') ? 'active' : ''
  );

  footL.innerHTML = footerStats(job);

  // Update badge
  const badge = el.querySelector('.dl-badge:not(.badge-torrent)');
  if (badge) { badge.className = `dl-badge ${badgeClass(job.status)}`; badge.textContent = badgeLabel(job.status); }

  // Update size — always, so the total stays on screen the whole way through
  const sizeEl = el.querySelector('.dl-meta-item');
  if (sizeEl) sizeEl.textContent = sizeLabel(job);

  el.className = `dl-card state-${job.status}`;
}

// ─────────────────────────────────────────────
//  Status bar
// ─────────────────────────────────────────────
function updateStatusBar() {
  const active = state.jobs.filter(j => j.status==='downloading'||j.status==='seeding');
  const dot    = document.getElementById('status-dot');
  const txt    = document.getElementById('status-text');
  const spd    = document.getElementById('status-speed');
  const prs    = document.getElementById('status-peers');
  const prsV   = document.getElementById('status-peers-val');
  if (!dot) return;

  if (active.length === 0) {
    dot.className = 'status-dot idle';
    txt.textContent = state.jobs.length > 0 ? `${state.jobs.length} download${state.jobs.length>1?'s':''}` : 'Idle';
    spd.textContent = '—';
    if (prs) prs.style.display = 'none';
    return;
  }
  dot.className = 'status-dot';
  txt.textContent = `${active.length} active`;
  spd.textContent = state.totalSpeed > 0 ? `${fmtBytes(state.totalSpeed)}/s` : '—';
  if (prs && state.totalPeers > 0) { prs.style.display='flex'; prsV.textContent=state.totalPeers; }
  else if (prs) prs.style.display = 'none';
}

// ─────────────────────────────────────────────
//  Load queue from main process
// ─────────────────────────────────────────────
async function loadQueue() {
  if (!window.zest) return;
  try {
    const jobs = await window.zest.queueGetAll();
    if (Array.isArray(jobs)) {
      // Merge — keep speedRaw from live data, update rest from DB
      const liveMap = new Map(state.jobs.map(j => [j.id, j]));
      state.jobs = jobs.map(j => ({ ...j, speedRaw: liveMap.get(j.id)?.speedRaw || 0 }));
    }
    renderList();
  } catch (e) {
    console.error('[Renderer] loadQueue error:', e);
  }
}
window.loadQueue = loadQueue;

// Poll every 1.5s — keeps UI in sync even if IPC event missed
let _pollTimer = null;
function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(loadQueue, 1500);
}

// ─────────────────────────────────────────────
//  IPC live event listeners
// ─────────────────────────────────────────────
function attachListeners() {
  if (!window.zest) return;

  function upsert(id, patch) {
    const job = state.jobs.find(j => j.id === id);
    if (!job) {
      // New job — add a placeholder then reload
      state.jobs.unshift({ id, status:'downloading', downloaded:0, total_bytes:0, speed:'0 B/s', eta:0, type:'http', ...patch });
      loadQueue();
      return state.jobs[0];
    }
    Object.assign(job, patch);
    return job;
  }

  // HTTP
  window.zest.on('download:meta', (m) => {
    upsert(m.id, { filename:m.filename, total_bytes:m.totalBytes, status:'downloading' });
    renderList();
  });

  window.zest.on('download:progress', (p) => {
    const job = upsert(p.id, { downloaded:p.downloadedBytes, total_bytes:p.totalBytes,
      speed:p.speed, speedRaw:p.speedRaw||0, eta:p.eta, status:'downloading' });
    state.totalSpeed = state.jobs.filter(j=>j.status==='downloading').reduce((s,j)=>s+(j.speedRaw||0),0);
    patchCard(document.getElementById(`card-${p.id}`), job);
    updateStatusBar();
  });

  window.zest.on('download:done', (info) => {
    const job = upsert(info.id, { status:'done', filename:info.filename });
    if (job) job.downloaded = job.total_bytes;
    renderList();
    window.showToast?.(`✓ ${info.filename||'Download'} complete`, 'success');
  });

  window.zest.on('download:paused',  ({id}) => { upsert(id,{status:'paused'});  renderList(); });
  window.zest.on('download:error',   ({id,message}) => { upsert(id,{status:'error',error_msg:message}); renderList(); window.showToast?.(`Failed: ${message}`,'error'); });
  window.zest.on('download:merging', ({id}) => { upsert(id,{status:'downloading',speed:'Merging…'}); renderList(); });

  // Torrent
  window.zest.on('torrent:meta', (m) => {
    upsert(m.id, { filename:m.name, total_bytes:m.totalBytes, status:'downloading', type:'torrent' });
    renderList();
  });

  window.zest.on('torrent:progress', (s) => {
    const job = upsert(s.id, { downloaded:s.downloadedBytes, total_bytes:s.totalBytes,
      speed:s.downloadSpeed, eta:s.eta, status:'downloading', peers:s.peers });
    state.totalPeers = state.jobs.filter(j=>j.type==='torrent').reduce((t,j)=>t+(j.peers||0),0);
    patchCard(document.getElementById(`card-${s.id}`), job);
    updateStatusBar();
  });

  window.zest.on('torrent:done',    (info) => { upsert(info.id,{status:'done',filename:info.name}); renderList(); window.showToast?.(`✓ ${info.name} complete`,'success'); });
  window.zest.on('torrent:paused',  ({id}) => { upsert(id,{status:'paused'});       renderList(); });
  window.zest.on('torrent:resumed', ({id}) => { upsert(id,{status:'downloading'});  renderList(); });
  window.zest.on('torrent:error',   ({id,message}) => { upsert(id,{status:'error',error_msg:message}); renderList(); });

  // The bridge is what the browser extension talks to — if it never came up,
  // say so instead of leaving the user wondering why nothing is captured.
  window.zest.on('bridge:error', ({message}) => window.showToast?.(message, 'error'));
}

// ─────────────────────────────────────────────
//  Action handlers
// ─────────────────────────────────────────────
window.handlePause = async (id, type) => {
  if (type==='torrent') await window.zest?.torrentPause(id);
  else                  await window.zest?.downloadPause(id);
  state.jobs.find(j=>j.id===id) && (state.jobs.find(j=>j.id===id).status='paused');
  renderList();
};

window.handleResume = async (id, type) => {
  if (type==='torrent') await window.zest?.torrentResume(id);
  else                  await window.zest?.downloadResume(id);
  state.jobs.find(j=>j.id===id) && (state.jobs.find(j=>j.id===id).status='downloading');
  renderList();
};

window.handleCancel = async (id, type) => {
  if (type==='torrent') await window.zest?.torrentRemove(id,false);
  else                  await window.zest?.downloadCancel(id);
  state.jobs.find(j=>j.id===id) && (state.jobs.find(j=>j.id===id).status='cancelled');
  renderList();
};

window.handleRetry = async (id, _type) => {
  await window.zest?.downloadRetry(id);
  await loadQueue();
};

window.handleRemove = async (id) => {
  await window.zest?.queueRemove(id);
  state.jobs = state.jobs.filter(j=>j.id!==id);
  renderList();
};

window.handleOpen = async (id) => {
  const res = await window.zest?.queueOpen(id);
  if (res?.error) window.showToast?.(`Cannot open file: ${res.error}`, 'error');
};

window.handleFolder = async (id) => {
  const res = await window.zest?.queueShowInFolder(id);
  if (res?.error) window.showToast?.(`Cannot open folder: ${res.error}`, 'error');
};

// ─────────────────────────────────────────────
//  Filter
// ─────────────────────────────────────────────
window.applyFilter = (filter) => {
  state.activeFilter   = filter;
  _skipExitAnimation   = true;
  renderList();
};

/** Sidebar view change — resets the status tabs back to "All" */
window.setViewFilter = (view) => {
  state.activeView     = view;
  state.activeFilter   = 'all';
  _skipExitAnimation   = true;
  renderList();
};

// ─────────────────────────────────────────────
//  Drag & drop
// ─────────────────────────────────────────────
function setupDragDrop() {
  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay';
  overlay.innerHTML = `
    <div class="drop-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v13M7 11l5 5 5-5"/><path d="M5 20h14"/>
      </svg>
    </div>
    <div class="drop-label">Drop to download</div>
    <div class="drop-sublabel">.torrent files or URLs</div>`;
  document.body.appendChild(overlay);

  let counter = 0;
  document.addEventListener('dragenter', e => { e.preventDefault(); counter++; overlay.classList.add('visible'); });
  document.addEventListener('dragleave', () => { if(--counter<=0){counter=0;overlay.classList.remove('visible');} });
  document.addEventListener('dragover',  e => e.preventDefault());
  document.addEventListener('drop', async e => {
    e.preventDefault(); counter=0; overlay.classList.remove('visible');
    const files = [...(e.dataTransfer?.files||[])];
    const text  = e.dataTransfer?.getData('text/plain')||'';
    for (const f of files) {
      if (!f.name.endsWith('.torrent')) continue;
      // File.path is gone in newer Electron — the path comes from webUtils
      const p = window.zest?.getPathForFile(f);
      if (!p) { window.showToast?.('Could not read that file path','error'); continue; }
      await window.zest?.torrentAdd(p,null);
      window.showToast?.('Torrent added','success');
    }
    if (!files.length && text) {
      if (text.startsWith('magnet:')) { await window.zest?.torrentAdd(text,null); window.showToast?.('Magnet added','success'); }
      else if (text.startsWith('http')) {
        const res = await window.zest?.downloadAdd(text,null);
        if (res?.error) window.showToast?.(res.error,'error');
        else window.showToast?.('Download started','info');
      }
    }
    await loadQueue();
  });
}

// ─────────────────────────────────────────────
//  Right-click context menu
// ─────────────────────────────────────────────
function setupContextMenu() {
  let menu = null;
  const close = () => { menu?.remove(); menu=null; };
  document.addEventListener('click', close);
  document.addEventListener('contextmenu', e => {
    const card = e.target.closest('.dl-card');
    if (!card) return;
    e.preventDefault(); close();
    const id  = card.dataset.id;
    const job = state.jobs.find(j=>j.id===id);
    if (!job) return;

    const m = document.createElement('div');
    m.className = 'ctx-menu';

    const item = (svg, label, fn, danger=false) => {
      const el = document.createElement('div');
      el.className = `ctx-item${danger?' danger':''}`;
      el.innerHTML = `${svg}<span>${label}</span>`;
      el.onclick = e => { e.stopPropagation(); close(); fn(); };
      return el;
    };
    const div = () => { const d=document.createElement('div'); d.className='ctx-divider'; return d; };

    const svgs = {
      pause:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
      play:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
      folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
      open:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
      trash:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`,
      copy:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
      retry:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></svg>`,
    };

    const isActive = job.status==='downloading'||job.status==='seeding';
    if (isActive)           m.appendChild(item(svgs.pause,  'Pause',          ()=>window.handlePause(id,job.type)));
    if (job.status==='paused') m.appendChild(item(svgs.play,'Resume',         ()=>window.handleResume(id,job.type)));
    if (job.status==='done')   m.appendChild(item(svgs.open,'Open file',      ()=>window.handleOpen(id)));
    if (isActive||job.status==='done') m.appendChild(item(svgs.folder,'Show in folder',()=>window.handleFolder(id)));
    m.appendChild(item(svgs.copy, 'Copy URL', ()=>navigator.clipboard?.writeText(job.url||'')));
    m.appendChild(div());
    if (job.status==='error') m.appendChild(item(svgs.retry,'Retry',()=>window.handleRetry(id,job.type)));
    m.appendChild(item(svgs.trash, isActive||job.status==='paused'?'Cancel & remove':'Remove',
      ()=>{ window.handleCancel(id,job.type).then(()=>window.handleRemove(id)); }, true));

    m.style.left = `${Math.min(e.clientX, window.innerWidth-180)}px`;
    m.style.top  = `${Math.min(e.clientY, window.innerHeight-200)}px`;
    document.body.appendChild(m);
    menu = m;
  });
}

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────
async function boot() {
  // styles.css is already linked from index.html — no second injection

  if (window.zest) {
    state.defaultDir = await window.zest.getDefaultDir().catch(()=>'');
  }

  setupDragDrop();
  setupContextMenu();
  attachListeners();
  await loadQueue();
  startPolling();   // keep in sync every 1.5s
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
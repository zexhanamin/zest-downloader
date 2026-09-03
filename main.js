const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, nativeImage } = require('electron');
const path    = require('path');
const fs      = require('fs-extra');
const http    = require('http');

const { config }              = require('./src/config');
const { Downloader, sanitizeFilename } = require('./src/downloader');
const { queue, STATUS }       = require('./src/queue');
const { torrentEngine }       = require('./src/torrent');
const { openBrowserWithExtension } = require('./src/extension-installer');
const { initUpdater, checkForUpdates, installUpdate } = require('./src/updater');

// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────
const IS_DEV      = process.argv.includes('--dev');
const DEFAULT_DIR = config.downloadDir || app.getPath('downloads');
const ICON_PATH   = path.join(__dirname, 'assets', 'icon.png');
const ICO_PATH    = path.join(__dirname, 'assets', 'icon.ico');
const EXT_DIR     = path.join(__dirname, 'extension');

/** How many transfers run at once — the rest wait in the queue */
const MAX_CONCURRENT = config.maxConcurrent;

// ─────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {Tray|null} */
let tray = null;

/** @type {http.Server|null} — Extension bridge */
let bridgeServer = null;

/** Set once the user really means to exit, so the window may close */
let isQuitting = false;

/** Active HTTP downloaders  { jobId: Downloader } */
const activeDownloaders = new Map();

/**
 * Session cookies handed over by the browser extension, keyed by job id.
 *
 * Deliberately memory-only: these are live credentials, and the queue
 * database is a plain file. The cost is that resuming after an app restart
 * loses the session — the download then fails with the site's own error,
 * which is honest, rather than saving a login page as if it were the file.
 */
const jobCookies = new Map();

// ─────────────────────────────────────────────
//  URL / path helpers
// ─────────────────────────────────────────────

const KNOWN_DL_EXTS = new Set([
  'zip','rar','7z','tar','gz','bz2','xz','zst','exe','msi','dmg','pkg','deb','rpm',
  'appimage','mp4','mkv','avi','mov','wmv','flv','webm','m4v','ts','mp3','flac',
  'wav','aac','ogg','m4a','opus','pdf','epub','mobi','iso','img','bin','apk','ipa',
  'torrent','jpg','jpeg','png','gif','webp','svg','txt','csv','json','xml','doc',
  'docx','xls','xlsx','ppt','pptx',
]);

// Endpoint names that are always machine chatter, never a file the user wants
const API_SLUGS = new Set([
  'batchexecute','browserinfo','redirect','log','collect','beacon','sync',
  'rpc','graphql','api','track','analytics','gen_204','playlog','jsc',
]);

/**
 * Gate for URLs the app will accept.
 *
 * This is deliberately permissive: the extension already filters what it
 * auto-captures, and plenty of real downloads live behind extensionless
 * paths (`/download/98765`, `?export=download&id=…`). Blocking those was
 * worse than the occasional bad paste — the downloader itself now verifies
 * the response before writing anything. We only reject what cannot be a
 * download at all.
 */
function isValidDownloadUrl(url = '') {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('magnet:')) return true;
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  if (!u.hostname) return false;
  const slug = (u.pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
  if (API_SLUGS.has(slug)) return false;
  return true;
}

/** Does this name end in something that is plainly a file? */
function filenameLooksLikeFile(name = '') {
  const base = sanitizeFilename(decodeFilename(name));
  const ext  = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return KNOWN_DL_EXTS.has(ext);
}

function decodeFilename(name = '') {
  if (!name) return '';
  try { return decodeURIComponent(name); } catch (_) { return name; }
}

/** Resolve on-disk path for a queue job (tries decoded + raw filename) */
async function resolveJobFilePath(job) {
  if (!job?.save_path) return null;

  const candidates = [];
  const add = (name) => {
    if (!name) return;
    const p = path.join(job.save_path, name);
    if (!candidates.includes(p)) candidates.push(p);
  };

  add(decodeFilename(job.filename));
  add(job.filename);

  if (!job.filename) {
    try {
      add(decodeFilename(path.basename(new URL(job.url).pathname)));
    } catch (_) {}
  }

  // Torrents save into a subfolder named after the torrent
  if (job.type === 'torrent' && job.filename) {
    const folder = path.join(job.save_path, decodeFilename(job.filename));
    if (await fs.pathExists(folder)) {
      const entries = await fs.readdir(folder).catch(() => []);
      if (entries.length === 1) return path.join(folder, entries[0]);
      if (entries.length > 1) return folder;
    }
  }

  for (const p of candidates) {
    if (await fs.pathExists(p)) return p;
  }
  return candidates[0] || null;
}

/** Delete every temp artefact belonging to a job — all keyed on its id */
async function dropScratch(job) {
  if (!job?.save_path || !job?.id) return;
  for (const suffix of ['.parts', '.part', '.merging']) {
    await fs.remove(path.join(job.save_path, `.zest-${job.id}${suffix}`)).catch(() => {});
  }
}

// ─────────────────────────────────────────────
//  Window
// ─────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1100,
    height:          700,
    minWidth:        800,
    minHeight:       500,
    title:           'Zest Downloader',
    icon:            process.platform === 'win32' ? ICO_PATH : ICON_PATH,
    backgroundColor: '#111114',
    frame:           false,       // custom titlebar
    titleBarStyle:   'hidden',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
    show: false,   // show after ready-to-show
  });

  mainWindow.loadFile('index.html');

  // Show only when fully rendered — avoids white flash
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open DevTools in dev mode
  if (IS_DEV) mainWindow.webContents.openDevTools();

  // Minimise to tray instead of closing — but let a real quit through,
  // otherwise the app can never exit and before-quit cleanup never runs.
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWindow.hide();
  });

  // Anything the page tries to open externally goes to the real browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Remove default menu bar
  Menu.setApplicationMenu(null);
}

// ─────────────────────────────────────────────
//  System Tray
// ─────────────────────────────────────────────

function quitApp() {
  isQuitting = true;
  app.quit();
}

function createTray() {
  const iconFile = process.platform === 'win32' ? ICO_PATH : ICON_PATH;
  const icon = nativeImage.createFromPath(iconFile).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Zest Downloader');

  const menu = Menu.buildFromTemplate([
    { label: 'Open Zest',   click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit',        click: quitApp },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => {
    mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show();
  });
}

// ─────────────────────────────────────────────
//  Helper — send event to renderer safely
// ─────────────────────────────────────────────

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ─────────────────────────────────────────────
//  Scheduler — cap how many transfers run at once
// ─────────────────────────────────────────────

/**
 * Start whatever the concurrency budget allows. Every completion path calls
 * back into this, so the queue drains on its own.
 */
function pumpQueue() {
  // Guards against spinning forever if a job somehow fails to leave the
  // queued state — the loop would otherwise keep picking the same row.
  const startedThisPass = new Set();

  try {
    while (queue.countActive() < MAX_CONCURRENT) {
      const job = queue.getNextQueued();
      if (!job || startedThisPass.has(job.id)) return;
      startedThisPass.add(job.id);

      // Flip the status first so this job is never picked twice
      queue.setDownloading(job.id);
      if (job.type === 'torrent') {
        startTorrentDownload(job.id, job.url, job.save_path, null);
      } else {
        startHttpDownload(job.id, job.url, job.save_path, job.referrer, job.filename,
                          jobCookies.get(job.id) || '');
      }
    }
  } catch (e) {
    console.error('[Scheduler] pump failed:', e.message);
  }
}

/** Queue a job and let the scheduler decide when it actually starts */
function enqueue({ url, savePath, type = 'http', referrer = '', filename = null, cookie = '' }) {
  const id = queue.add({ url, savePath, type, referrer, filename });
  if (cookie) jobCookies.set(id, cookie);
  pumpQueue();
  return id;
}

// ─────────────────────────────────────────────
//  HTTP Download handlers
// ─────────────────────────────────────────────

function startHttpDownload(id, url, savePath, referrer = '', filename = null, cookie = '') {
  if (activeDownloaders.has(id)) return;

  const dl = new Downloader({ url, savePath, id, referrer, filename, cookie });
  activeDownloaders.set(id, dl);

  dl.on('meta', (meta) => {
    queue.updateProgress(id, {
      downloaded: 0,
      totalBytes: meta.totalBytes,
      speed:      '0 B/s',
      eta:        null,
      filename:   meta.filename,
    });
    send('download:meta', meta);
  });

  dl.on('progress', (p) => {
    queue.updateProgress(id, {
      downloaded: p.downloadedBytes,
      totalBytes: p.totalBytes,
      speed:      p.speed,
      eta:        p.eta,
    });
    send('download:progress', p);
  });

  dl.on('merging', () => send('download:merging', { id }));

  dl.on('done', (info) => {
    queue.setDone(id, info.filename, info.totalBytes);
    activeDownloaders.delete(id);
    send('download:done', { ...info, id });
    pumpQueue();
  });

  dl.on('paused', () => {
    queue.setPaused(id);
    activeDownloaders.delete(id);
    send('download:paused', { id });
    pumpQueue();
  });

  dl.on('error', (err) => {
    queue.setError(id, err.message);
    activeDownloaders.delete(id);
    send('download:error', { id, message: err.message });
    pumpQueue();
  });

  dl.start();
  queue.setDownloading(id);
}

// ─────────────────────────────────────────────
//  Torrent Download handlers
// ─────────────────────────────────────────────

function startTorrentDownload(id, source, savePath, selectFiles) {
  const dl = torrentEngine.add({ source, savePath, id, select: selectFiles });

  dl.on('meta', (meta) => {
    queue.updateProgress(id, {
      downloaded: 0,
      totalBytes: meta.totalBytes,
      speed:      '0 B/s',
      eta:        null,
      filename:   meta.name,
    });
    send('torrent:meta', meta);
  });

  dl.on('progress', (stats) => {
    queue.updateProgress(id, {
      downloaded: stats.downloadedBytes,
      totalBytes: stats.totalBytes,
      speed:      stats.downloadSpeed,
      eta:        stats.eta,
    });
    send('torrent:progress', stats);
  });

  dl.on('done', (info) => {
    queue.setDone(id, info.name, info.totalBytes ?? null);
    send('torrent:done', { ...info, id });
    pumpQueue();   // seeding no longer occupies a download slot
  });

  dl.on('paused',   () => { queue.setPaused(id);      send('torrent:paused',  { id }); pumpQueue(); });
  dl.on('resumed',  () => { queue.setDownloading(id); send('torrent:resumed', { id }); });
  dl.on('peer',     (p) => send('torrent:peer', p));
  dl.on('warning',  (w) => send('torrent:warning', { id, message: String(w) }));

  dl.on('error', (err) => {
    queue.setError(id, err.message);
    send('torrent:error', { id, message: err.message });
    pumpQueue();
  });

  queue.setDownloading(id);
}

// ─────────────────────────────────────────────
//  IPC — HTTP downloads
// ─────────────────────────────────────────────

ipcMain.handle('download:add', async (_e, { url, savePath }) => {
  if (!isValidDownloadUrl(url)) {
    return { error: 'That does not look like a valid http(s) or magnet link' };
  }
  const dir = savePath || DEFAULT_DIR;
  const id  = enqueue({ url, savePath: dir, type: 'http' });
  return { id };
});

ipcMain.handle('download:pause', (_e, { id }) => {
  const dl = activeDownloaders.get(id);
  if (dl) { dl.pause(); return { ok: true }; }
  // Not running yet — take it out of the waiting list
  const job = queue.get(id);
  if (job && job.status === STATUS.QUEUED) { queue.setPaused(id); return { ok: true }; }
  return { ok: false };
});

ipcMain.handle('download:resume', (_e, { id }) => {
  const job = queue.get(id);
  if (!job) return { error: 'Job not found' };
  if (activeDownloaders.has(id)) return { ok: true };
  // Back into the queue — the scheduler restarts it, and the downloader
  // picks up the bytes already on disk.
  queue.setQueued(id);
  pumpQueue();
  return { ok: true };
});

ipcMain.handle('download:cancel', async (_e, { id }) => {
  const job = queue.get(id);
  await activeDownloaders.get(id)?.cancel();
  activeDownloaders.delete(id);
  await dropScratch(job);
  queue.setCancelled(id);
  pumpQueue();
  return { ok: true };
});

ipcMain.handle('download:retry', async (_e, { id }) => {
  const job = queue.get(id);
  if (!job) return { error: 'Job not found' };
  await activeDownloaders.get(id)?.cancel();
  activeDownloaders.delete(id);
  await dropScratch(job);   // retry means start clean
  queue.retry(id);
  pumpQueue();
  return { ok: true };
});

// ─────────────────────────────────────────────
//  IPC — Torrent downloads
// ─────────────────────────────────────────────

/**
 * A provisional label so the card is readable the moment it appears,
 * instead of showing a raw magnet URI or a full C:\… path until the
 * torrent metadata arrives and replaces it.
 */
function provisionalTorrentName(source = '') {
  if (source.startsWith('magnet:')) {
    const dn = /[?&]dn=([^&]+)/i.exec(source);
    if (dn) {
      try { return sanitizeFilename(decodeURIComponent(dn[1].replace(/\+/g, ' '))); }
      catch (_) { return sanitizeFilename(dn[1]); }
    }
    return null;
  }
  const base = source.split(/[\\/]/).pop() || '';
  return base ? sanitizeFilename(base.replace(/\.torrent$/i, '')) : null;
}

ipcMain.handle('torrent:add', async (_e, { source, savePath, selectFiles }) => {
  const dir = savePath || DEFAULT_DIR;
  const id  = queue.add({
    url:      source,
    savePath: dir,
    type:     'torrent',
    filename: provisionalTorrentName(source),
  });
  if (selectFiles && selectFiles.length) {
    // Explicit file selection can't survive a trip through the queue,
    // so this one starts immediately.
    queue.setDownloading(id);
    startTorrentDownload(id, source, dir, selectFiles);
  } else {
    pumpQueue();
  }
  return { id };
});

ipcMain.handle('torrent:pause',  (_e, { id }) => torrentEngine.pause(id));

ipcMain.handle('torrent:resume', (_e, { id }) => {
  // After a restart the engine has no memory of this torrent — re-add it
  if (!torrentEngine.get(id)) {
    const job = queue.get(id);
    if (!job) return { error: 'Job not found' };
    queue.setQueued(id);
    pumpQueue();
    return { ok: true };
  }
  torrentEngine.resume(id);
  return { ok: true };
});

ipcMain.handle('torrent:remove', async (_e, { id, deleteFiles }) => {
  await torrentEngine.remove(id, deleteFiles ?? false);
  queue.setCancelled(id);
  pumpQueue();
  return { ok: true };
});

ipcMain.handle('torrent:selectFiles', (_e, { id, indices }) => {
  torrentEngine.get(id)?.selectFiles(indices);
});

ipcMain.handle('torrent:setLimits', (_e, { id, downloadLimit, uploadLimit }) => {
  const dl = torrentEngine.get(id);
  if (!dl) return;
  if (downloadLimit !== undefined) dl.setDownloadLimit(downloadLimit);
  if (uploadLimit   !== undefined) dl.setUploadLimit(uploadLimit);
});

// ─────────────────────────────────────────────
//  IPC — Queue
// ─────────────────────────────────────────────

ipcMain.handle('queue:getAll',       ()           => queue.getAll());
ipcMain.handle('queue:get',          (_e, { id }) => queue.get(id));
ipcMain.handle('queue:stats',        ()           => queue.stats());

ipcMain.handle('queue:remove', async (_e, { id }) => {
  const job = queue.get(id);
  await activeDownloaders.get(id)?.cancel();
  activeDownloaders.delete(id);
  await torrentEngine.remove(id, false).catch(() => {});
  await dropScratch(job);
  jobCookies.delete(id);
  queue.remove(id);
  pumpQueue();
  return { ok: true };
});

ipcMain.handle('queue:clearFinished', () => {
  queue.clearFinished();
  return { ok: true };
});

// ─────────────────────────────────────────────
//  IPC — UI utilities
// ─────────────────────────────────────────────

/** Open a completed download by queue job ID */
ipcMain.handle('queue:open', async (_e, { id }) => {
  const job = queue.get(id);
  if (!job) return { error: 'Job not found' };
  const filePath = await resolveJobFilePath(job);
  if (!filePath) return { error: 'No file path' };
  if (!(await fs.pathExists(filePath))) {
    return { error: `File not found: ${filePath}` };
  }
  const err = await shell.openPath(filePath);
  return { error: err || null, path: filePath };
});

/**
 * A preview image for a finished download.
 *
 * Pictures get a real thumbnail of their own contents; everything else gets
 * the icon Windows/macOS already associates with that file type, which is
 * more informative than a coloured "PDF" square and costs no dependency.
 * Returns a data: URI, which the page's CSP allows.
 */
const THUMBNAIL_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico']);

ipcMain.handle('queue:fileIcon', async (_e, { id }) => {
  const job = queue.get(id);
  if (!job || job.status !== STATUS.DONE) return { icon: null };

  const filePath = await resolveJobFilePath(job);
  if (!filePath || !(await fs.pathExists(filePath))) return { icon: null };
  if ((await fs.stat(filePath)).isDirectory()) return { icon: null };

  const ext = path.extname(filePath).slice(1).toLowerCase();

  try {
    if (THUMBNAIL_EXTS.has(ext)) {
      const img = nativeImage.createFromPath(filePath);
      if (!img.isEmpty()) {
        // Cap the size — a 4000px photo as a data URI would be absurd
        const { width, height } = img.getSize();
        const scale  = Math.min(1, 96 / Math.max(width, height));
        const thumb  = scale < 1
          ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' })
          : img;
        return { icon: thumb.toDataURL(), kind: 'thumbnail' };
      }
    }

    const shellIcon = await app.getFileIcon(filePath, { size: 'normal' });
    if (shellIcon && !shellIcon.isEmpty()) {
      return { icon: shellIcon.toDataURL(), kind: 'shell' };
    }
  } catch (err) {
    console.warn('[Icon] Could not build preview:', err.message);
  }

  return { icon: null };
});

/** Show a completed download in folder by queue job ID */
ipcMain.handle('queue:showInFolder', async (_e, { id }) => {
  const job = queue.get(id);
  if (!job) return { error: 'Job not found' };
  const filePath = await resolveJobFilePath(job);
  if (!filePath) return { error: 'No file path' };
  if (await fs.pathExists(filePath)) {
    shell.showItemInFolder(filePath);
    return { error: null, path: filePath };
  }
  // Fall back to save folder if file missing
  if (await fs.pathExists(job.save_path)) {
    await shell.openPath(job.save_path);
    return { error: null, path: job.save_path };
  }
  return { error: `File not found: ${filePath}` };
});

/** Open a folder the app itself owns (download dir) — not arbitrary paths */
ipcMain.handle('shell:openDownloadDir', async (_e, { dirPath }) => {
  const target = dirPath || DEFAULT_DIR;
  if (!(await fs.pathExists(target))) return { error: 'Folder not found' };
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) return { error: 'Not a folder' };
  const err = await shell.openPath(target);
  return { error: err || null };
});

/** Open a folder-picker dialog */
ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title:      'Choose download folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

/** Open a file-picker for .torrent files */
ipcMain.handle('dialog:pickTorrent', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title:      'Open .torrent file',
    filters:    [{ name: 'Torrent Files', extensions: ['torrent'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

/** Get default download directory */
ipcMain.handle('app:getDefaultDir', () => DEFAULT_DIR);

/** Window controls (custom titlebar) */
ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('win:close', () => { mainWindow?.hide(); });
ipcMain.handle('win:isMaximized', () => mainWindow?.isMaximized() ?? false);
ipcMain.handle('app:quit', () => { quitApp(); });

// ─────────────────────────────────────────────
//  IPC — Browser extension setup
// ─────────────────────────────────────────────

/** Where the unpacked extension lives, for "Load unpacked" */
ipcMain.handle('app:extensionInfo', () => ({
  path:      EXT_DIR,
  exists:    fs.pathExistsSync(EXT_DIR),
  bridgePort: BRIDGE_PORT,
}));

/** Reveal the extension folder so the user can drag it into chrome://extensions */
ipcMain.handle('app:revealExtension', async () => {
  if (!(await fs.pathExists(EXT_DIR))) return { error: 'Extension folder missing' };
  shell.showItemInFolder(path.join(EXT_DIR, 'manifest.json'));
  return { error: null, path: EXT_DIR };
});

/**
 * Launch a browser with the extension already loaded. Uses a dedicated
 * profile because Chrome silently drops --load-extension when an instance
 * is already running on the default profile.
 */
ipcMain.handle('app:launchBrowserWithExtension', () => {
  const ok = openBrowserWithExtension(EXT_DIR);
  return ok ? { error: null } : { error: 'No supported browser found (Chrome / Edge / Brave)' };
});

/** Update controls */
ipcMain.handle('update:check',   () => checkForUpdates());
ipcMain.handle('update:install', () => installUpdate());

// ─────────────────────────────────────────────
//  HTTP Bridge Server (for browser extension)
//  Listens on 127.0.0.1:6543
// ─────────────────────────────────────────────

const BRIDGE_PORT = config.bridgePort;

/**
 * Only the browser extension may drive the bridge.
 *
 * Any page in the browser can reach 127.0.0.1, so without this check a
 * random website could queue downloads into the user's Downloads folder.
 * Extension service workers send `Origin: chrome-extension://…`; web pages
 * send their own origin, and that is exactly what we refuse. A missing
 * Origin means a non-browser client (curl, a test script) and is allowed.
 */
function isAllowedOrigin(origin) {
  if (!origin) return true;
  return /^(chrome-extension|moz-extension|extension|safari-web-extension):\/\//i.test(origin);
}

function startBridgeServer() {
  bridgeServer = http.createServer((req, res) => {
    const origin  = req.headers.origin || '';
    const allowed = isAllowedOrigin(origin);

    // Echo the origin back rather than "*" so only the extension is granted
    if (origin && allowed) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (!allowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Origin not allowed' }));
      return;
    }

    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check — extension pings this
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'Zest Downloader', version: app.getVersion() }));
      return;
    }

    // Add download from extension
    if (req.method === 'POST' && req.url === '/add') {
      let body = '';
      let tooBig = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) { tooBig = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig) return;
        try {
          const { type, url, referrer, filename, cookie } = JSON.parse(body);
          if (!url) throw new Error('No URL');
          if (!isValidDownloadUrl(url)) throw new Error('Not a downloadable URL');

          const savePath = DEFAULT_DIR;
          const isTorrent = type === 'torrent' || url.startsWith('magnet:');

          enqueue({
            url,
            savePath,
            type:     isTorrent ? 'torrent' : 'http',
            referrer: typeof referrer === 'string' ? referrer : '',
            cookie:   typeof cookie === 'string' ? cookie : '',
            filename: filename && filenameLooksLikeFile(filename)
              ? sanitizeFilename(decodeFilename(filename))
              : null,
          });

          // Show app window when download comes in
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // 404 for everything else
    res.writeHead(404);
    res.end();
  });

  bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`[Bridge] Extension bridge listening on 127.0.0.1:${BRIDGE_PORT}`);
  });

  bridgeServer.on('error', (err) => {
    console.warn('[Bridge] Could not start bridge server:', err.message);
    if (err.code === 'EADDRINUSE') {
      send('bridge:error', {
        message: `Port ${BRIDGE_PORT} is already in use — the browser extension cannot connect.`,
      });
    }
  });
}

// ─────────────────────────────────────────────
//  App lifecycle
// ─────────────────────────────────────────────

// Prevent multiple instances — must run before whenReady
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus existing window if user opens app again
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Init sql.js queue (async — no native build needed)
    await queue.init();

    createWindow();
    createTray();
    startBridgeServer();

    // Init auto-updater
    initUpdater(mainWindow, send);
    setTimeout(checkForUpdates, 5000);

    // Re-create window if opened from dock (macOS)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow?.show();
    });
  });
}

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  // On macOS keep app running until explicit quit
  if (process.platform !== 'darwin') quitApp();
});

/**
 * Electron does not await async quit handlers, so shutdown work has to
 * happen here: block the first quit, clean up, then quit for real.
 */
let shuttingDown = false;
app.on('will-quit', (e) => {
  if (shuttingDown) return;
  shuttingDown = true;
  e.preventDefault();

  (async () => {
    try {
      for (const dl of activeDownloaders.values()) dl.pause();
      activeDownloaders.clear();
      bridgeServer?.close();
      await torrentEngine.destroy();
      queue.close();
    } catch (err) {
      console.warn('[App] Shutdown error:', err.message);
    } finally {
      app.exit(0);
    }
  })();
});

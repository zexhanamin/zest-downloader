const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, nativeImage, safeStorage } = require('electron');
const path    = require('path');
const fs      = require('fs-extra');
const http    = require('http');

const { config }              = require('./src/config');
const { Downloader, sanitizeFilename } = require('./src/downloader');
const { queue, STATUS }       = require('./src/queue');
const { torrentEngine }       = require('./src/torrent');
const media                   = require('./src/media');
const { openBrowserWithExtension } = require('./src/extension-installer');
const { initUpdater, checkForUpdates, installUpdate } = require('./src/updater');

// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────
const IS_DEV      = process.argv.includes('--dev');
/** Launched by the OS at login — come up in the tray, not in the user's face */
const STARTED_HIDDEN = process.argv.includes('--hidden');
const DEFAULT_DIR = config.downloadDir || app.getPath('downloads');
const ICON_PATH   = path.join(__dirname, 'assets', 'icon.png');
const ICO_PATH    = path.join(__dirname, 'assets', 'icon.ico');
/**
 * The unpacked extension folder.
 *
 * Packaged, __dirname points inside app.asar — an archive file, not a
 * directory. Chrome cannot load an extension from there and Explorer cannot
 * open it, so both "Open folder" and "Launch test browser" fail on every
 * installed copy while working fine from source. The real files are shipped
 * alongside the archive by the extraResources rule in package.json.
 */
const EXT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'extension')
  : path.join(__dirname, 'extension');

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

/** Active yt-dlp jobs  { jobId: MediaDownload } */
const activeMedia = new Map();

/** Session cookies for the current run, keyed by job id */
const jobCookies = new Map();

/**
 * Session cookies are live credentials, so they are never written to the
 * queue database in the clear. safeStorage encrypts them with the OS keystore
 * — DPAPI on Windows, Keychain on macOS, libsecret on Linux — which ties them
 * to this user account on this machine, the same way a browser stores its own
 * cookie jar. Where the OS offers no keystore, they simply stay in memory and
 * a resume after restart fails rather than silently downgrading to plaintext.
 */
function encryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}

function rememberCookie(id, cookie) {
  if (!cookie) return;
  jobCookies.set(id, cookie);
  if (!encryptionAvailable()) return;
  try {
    queue.setCookie(id, safeStorage.encryptString(cookie).toString('base64'));
  } catch (e) {
    console.warn('[Cookies] Could not store credentials for', id, '-', e.message);
  }
}

/** Cookie for a job: this run's copy first, else the encrypted one on disk */
function cookieFor(id) {
  const live = jobCookies.get(id);
  if (live) return live;
  if (!encryptionAvailable()) return '';
  try {
    const row = queue.get(id);
    if (!row?.cookie_enc) return '';
    const plain = safeStorage.decryptString(Buffer.from(row.cookie_enc, 'base64'));
    jobCookies.set(id, plain);
    return plain;
  } catch (_) {
    // Written by a different user or machine — treat it as absent
    return '';
  }
}

/** Wipe credentials the moment a job no longer needs them */
function forgetCookie(id) {
  jobCookies.delete(id);
  try { queue.clearCookie(id); } catch (_) {}
}

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

/**
 * What is left of a name once everything a plain-ASCII console cannot print
 * has gone. Two names that share a skeleton are the same file seen through
 * different amounts of damage.
 */
function asciiSkeleton(name = '') {
  return String(name)
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Resolve on-disk path for a queue job (tries decoded + raw filename) */
async function resolveJobFilePath(job) {
  if (!job?.save_path) return null;

  // What the engine actually wrote beats anything reconstructed from parts
  if (job.file_path && await fs.pathExists(job.file_path)) return job.file_path;

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

  // Last resort, for names that reached the queue through something lossy.
  // Downloads recorded before this was fixed have the emoji and the Arabic
  // stripped out of them; the file is right there under its real name, so
  // compare the two with everything unprintable taken off both sides.
  const wanted = asciiSkeleton(decodeFilename(job.filename));
  if (wanted) {
    const entries = await fs.readdir(job.save_path).catch(() => []);
    const hit = entries.find(e => asciiSkeleton(e) === wanted);
    if (hit) return path.join(job.save_path, hit);
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
  mainWindow.once('ready-to-show', () => {
    // A login-launched instance belongs in the tray. Popping a window in
    // front of someone who just reached their desktop is what makes
    // start-with-Windows apps worth uninstalling.
    if (!STARTED_HIDDEN) mainWindow.show();
  });

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
//  Progress popup
//
//  A capture used to raise the whole app over
//  whatever you were doing. This is the small
//  corner window instead: it says what is being
//  fetched and gets out of the way when done.
// ─────────────────────────────────────────────

/** @type {BrowserWindow|null} */
let popupWindow = null;

/** The job the popup is currently following */
let popupJobId = null;

function createPopup() {
  if (popupWindow && !popupWindow.isDestroyed()) return popupWindow;

  const { screen } = require('electron');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const W = 360;
  const H = 168;

  popupWindow = new BrowserWindow({
    width: W,
    height: H,
    x: width - W - 18,
    y: height - H - 18,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    // Out of the taskbar and above other windows: this is a notification,
    // not a second app to keep track of.
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never steal typing focus — the user is mid-sentence somewhere else
    focusable: false,
    show: false,
    backgroundColor: '#18181C',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  popupWindow.loadFile('popup.html');
  popupWindow.on('closed', () => { popupWindow = null; popupJobId = null; });
  return popupWindow;
}

function popupSend(channel, payload) {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send(channel, payload);
  }
}

/** Bring the popup up for a job, creating it the first time */
function showPopupFor(id) {
  popupJobId = id;
  const win = createPopup();
  const paint = () => {
    if (win.isDestroyed()) return;
    // Show first: pushes are skipped while the window is hidden, so
    // painting before showing left the previous job on screen.
    if (!win.isVisible()) win.showInactive();
    pushPopupJob(id);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', paint);
  else paint();
}

/**
 * Send the popup the current shape of the job it is following.
 *
 * `live` carries the in-flight numbers, which are fresher than the queue row:
 * progress is written to the database lazily so the disk is not thrashed.
 */
let popupLastPush = 0;

function pushPopupJob(id, live = null) {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  if (popupJobId !== id) return;
  // Nothing to paint on a window nobody can see
  if (!popupWindow.isVisible()) return;

  // Progress fires many times a second and each push costs two database
  // reads. The eye cannot use more than a few updates a second anyway, so
  // throttle them — but never drop a terminal state, which arrives once.
  const now = Date.now();
  const terminal = !live;
  if (!terminal && now - popupLastPush < 250) return;
  popupLastPush = now;

  const job = queue.get(id);
  if (!job) return;

  popupSend('popup:job', {
    id,
    name:        job.filename || job.url,
    status:      job.status,
    downloaded:  live?.downloadedBytes ?? job.downloaded,
    total_bytes: live?.totalBytes ?? job.total_bytes,
    speed:       live?.speed ?? job.speed,
    eta:         live?.eta ?? job.eta,
    error_msg:   job.error_msg,
    item:        live?.item ?? 0,
    itemCount:   live?.itemCount ?? 0,
  });

  try {
    const stats = queue.stats();
    const waiting = (stats.queued || 0) + Math.max(0, (stats.downloading || 0) - 1);
    popupSend('popup:queued', { waiting });
  } catch (_) {}
}

// ─────────────────────────────────────────────
//  System Tray
// ─────────────────────────────────────────────

function quitApp() {
  isQuitting = true;
  app.quit();
}

/**
 * Register (or clear) the Windows login item.
 *
 * The browser extension can only hand a download over while Zest is
 * listening, so an app that is not running is an app that silently does
 * nothing. It starts hidden in the tray, and `startAtLogin: false` in
 * zest-config.json turns it off.
 *
 * Only when packaged: pointing a login item at a dev electron.exe would
 * launch the wrong thing on every boot.
 */
function applyLoginItem() {
  if (!app.isPackaged) return;
  const openAtLogin = config.get('startAtLogin', true) !== false;
  try {
    const current = app.getLoginItemSettings();
    if (current.openAtLogin === openAtLogin) return;
    app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] });
    console.log(`[Startup] Start with Windows: ${openAtLogin ? 'on' : 'off'}`);
  } catch (err) {
    console.warn('[Startup] Could not update the login item:', err.message);
  }
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
      } else if (job.type === 'media') {
        startMediaDownload(job.id, job.url, job.save_path, job.quality);
      } else {
        startHttpDownload(job.id, job.url, job.save_path, job.referrer, job.filename,
                          cookieFor(job.id));
      }
    }
  } catch (e) {
    console.error('[Scheduler] pump failed:', e.message);
  }
}

/** Queue a job and let the scheduler decide when it actually starts */
function enqueue({ url, savePath, type = 'http', referrer = '', filename = null,
                  cookie = '', quality = '' }) {
  const id = queue.add({ url, savePath, type, referrer, filename, quality });
  rememberCookie(id, cookie);
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
    pushPopupJob(id, p);
  });

  dl.on('merging', () => send('download:merging', { id }));

  dl.on('done', (info) => {
    queue.setDone(id, info.filename, info.totalBytes, info.path);
    activeDownloaders.delete(id);
    forgetCookie(id);
    send('download:done', { ...info, id });
    pushPopupJob(id);
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
    pushPopupJob(id);
    pumpQueue();
  });

  dl.start();
  queue.setDownloading(id);
}

// ─────────────────────────────────────────────
//  Media (yt-dlp) handlers
// ─────────────────────────────────────────────

function startMediaDownload(id, url, savePath, quality) {
  if (activeMedia.has(id)) return;

  const [pickedQuality, mode] = String(quality || 'best').split('|');
  const dl = new media.MediaDownload({
    url, savePath, id,
    quality:  pickedQuality || 'best',
    playlist: mode === 'playlist',
    cookie:   cookieFor(id),
  });
  activeMedia.set(id, dl);

  dl.on('meta', (meta) => {
    queue.updateProgress(id, {
      downloaded: 0,
      totalBytes: meta.totalBytes,
      speed:      '0 B/s',
      eta:        null,
      filename:   meta.filename,
    });
    send('media:meta', meta);
  });

  dl.on('progress', (p) => {
    queue.updateProgress(id, {
      downloaded: p.downloadedBytes,
      totalBytes: p.totalBytes,
      speed:      p.speed,
      eta:        p.eta,
    });
    send('download:progress', p);
    pushPopupJob(id, p);   // the list renders media like any transfer
  });

  dl.on('done', (info) => {
    // info.path is where yt-dlp actually put it, which is the only thing
    // Open can trust: a playlist entry lands in a subfolder, and yt-dlp's
    // own sanitising of a title never matches ours character for character.
    queue.setDone(id, info.filename, info.totalBytes, info.path || null);
    activeMedia.delete(id);
    send('download:done', { ...info, id });
    pushPopupJob(id);
    pumpQueue();
  });

  dl.on('error', (err) => {
    queue.setError(id, err.message);
    activeMedia.delete(id);
    send('download:error', { id, message: err.message });
    pushPopupJob(id);
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
    queue.setDone(id, info.name, info.totalBytes ?? null, info.path || null);
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
  // A YouTube or TikTok page is not a file — say so instead of saving the HTML
  const site = media.mediaSiteFor(url);
  if (site) {
    return {
      error: `${site} links are videos, not files — use the Video tab`,
      media: true, site,
    };
  }
  const dir = savePath || DEFAULT_DIR;
  const id  = enqueue({ url, savePath: dir, type: 'http' });
  return { id };
});

// ─────────────────────────────────────────────
//  IPC — Video downloads (yt-dlp)
// ─────────────────────────────────────────────

// ── Keeping yt-dlp current ───────────────────
//
// The sites change how they serve video every few weeks, and a yt-dlp from
// two months ago stops working on them. Left alone that shows up as videos
// that used to download and now fail for no reason anybody can see, so the
// app replaces its own copy in the background instead of waiting to be asked.

let helperCheckTimer = null;

/**
 * @param {boolean} [opts.force] check now, whatever the setting and the clock say
 */
async function checkHelperUpdate({ force = false } = {}) {
  // Windows locks a running executable, so swapping yt-dlp out from under a
  // video that is downloading would fail on the move — that refusal holds
  // even when the user pressed the button, which is why it is not forced past.
  const verdict = media.shouldCheckForUpdate({
    enabled:   force || config.get('autoUpdateHelper', true) !== false,
    installed: await media.isInstalled(),
    busy:      activeMedia.size > 0,
    checkedAt: force ? 0 : (config.get('helperCheckedAt', 0) || 0),
  });
  if (!verdict.check) return { updated: false, reason: verdict.reason };

  try {
    const res = await media.updateYtDlp();
    // A check that never reached GitHub has not happened, so it must not
    // reset the clock — otherwise one offline morning costs a whole day.
    if (res.reason !== 'unreachable') config.set('helperCheckedAt', Date.now());
    if (res.updated) {
      console.log(`[Media] yt-dlp updated ${res.from || '?'} → ${res.current}`);
      send('media:helperUpdated', { version: res.current, from: res.from || null });
    }
    return res;
  } catch (err) {
    console.warn('[Media] Helper update failed:', err.message);
    return { updated: false, reason: 'failed', error: err.message };
  }
}

/** Check shortly after launch, then once a day for as long as the app is up */
function startHelperUpdates() {
  const tick = async () => {
    const res = await checkHelperUpdate();
    const next = res.reason === 'busy' ? media.UPDATE_RETRY_BUSY : media.UPDATE_CHECK_EVERY;
    helperCheckTimer = setTimeout(tick, next);
    helperCheckTimer.unref?.();
  };
  // Let the window paint and the queue settle before spending any bandwidth
  helperCheckTimer = setTimeout(tick, 20000);
  helperCheckTimer.unref?.();
}

/** Is this link one the video engine handles? */
ipcMain.handle('media:check', (_e, { url }) => ({ site: media.mediaSiteFor(url) }));

/** Check for a newer yt-dlp right now, from the button in the Video tab */
ipcMain.handle('media:updateHelper', async () => checkHelperUpdate({ force: true }));

/** Whether the yt-dlp helper is present, and which sites are supported */
ipcMain.handle('media:helperStatus', async () => ({
  installed: await media.isInstalled(),
  version:   (await media.isInstalled()) ? await media.installedVersion() : null,
  ffmpeg:    await media.hasFfmpeg(),
  runtime:   await media.jsRuntime(),
  sites:     media.MEDIA_HOSTS.map(h => h.name),
  path:      media.ytDlpPath(),
  autoUpdate:  config.get('autoUpdateHelper', true) !== false,
  checkedAt:   config.get('helperCheckedAt', 0) || 0,
}));

/**
 * Fetch and install yt-dlp.
 *
 * This downloads and later runs an executable, so the renderer only calls it
 * from an explicit button with the source spelled out — never on its own.
 */
ipcMain.handle('media:installHelper', async () => {
  try {
    const version = await media.installYtDlp((received, total) => {
      send('media:helperProgress', { received, total });
    });
    return { version };
  } catch (err) {
    return { error: err.message };
  }
});

/** Fetch ffmpeg, which unlocks the resolutions that need merging */
ipcMain.handle('media:installFfmpeg', async () => {
  try {
    await media.installFfmpeg((received, total) => {
      send('media:helperProgress', { received, total, what: 'ffmpeg' });
    });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

/** Fetch deno, which unlocks the formats YouTube guards behind a challenge */
ipcMain.handle('media:installRuntime', async () => {
  try {
    await media.installDeno((received, total) => {
      send('media:helperProgress', { received, total, what: 'runtime' });
    });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

/** Title, thumbnail and available qualities for a video page */
ipcMain.handle('media:probe', async (_e, { url }) => {
  if (!media.isMediaUrl(url)) return { error: 'Not a supported video link' };
  if (!(await media.isInstalled())) return { error: 'helper-missing' };
  try {
    return { info: await media.probe(url) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('media:add', async (_e, { url, savePath, quality, playlist }) => {
  if (!media.isMediaUrl(url)) return { error: 'Not a supported video link' };
  if (!(await media.isInstalled())) return { error: 'helper-missing' };
  const dir = savePath || DEFAULT_DIR;
  // The playlist choice rides along in the quality column rather than needing
  // a second one — it is only ever read back by startMediaDownload.
  const id  = enqueue({
    url, savePath: dir, type: 'media',
    quality: `${quality || 'best'}${playlist ? '|playlist' : ''}`,
  });
  return { id };
});

ipcMain.handle('download:pause', (_e, { id }) => {
  const mv = activeMedia.get(id);
  if (mv) {
    mv.pause();
    activeMedia.delete(id);
    queue.setPaused(id);
    send('download:paused', { id });
    pumpQueue();
    return { ok: true };
  }
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
  if (activeDownloaders.has(id) || activeMedia.has(id)) return { ok: true };
  // Back into the queue — the scheduler restarts it, and the downloader
  // picks up the bytes already on disk.
  queue.setQueued(id);
  pumpQueue();
  return { ok: true };
});

ipcMain.handle('download:cancel', async (_e, { id }) => {
  const job = queue.get(id);
  await activeMedia.get(id)?.cancel();
  activeMedia.delete(id);
  await activeDownloaders.get(id)?.cancel();
  activeDownloaders.delete(id);
  await dropScratch(job);
  forgetCookie(id);
  queue.setCancelled(id);
  pumpQueue();
  return { ok: true };
});

ipcMain.handle('download:retry', async (_e, { id }) => {
  const job = queue.get(id);
  if (!job) return { error: 'Job not found' };
  await activeMedia.get(id)?.cancel();
  activeMedia.delete(id);
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

/**
 * Drop a job from the list, and optionally the file it produced.
 *
 * Deleting the file is never the default and never implied: the list is a
 * record of downloads, and clearing the record is not the same as throwing
 * away what was downloaded. The caller has to ask for it explicitly.
 */
ipcMain.handle('queue:remove', async (_e, { id, deleteFile = false }) => {
  const job = queue.get(id);

  // Resolve the path before the row goes, since that is what names the file
  const filePath = (deleteFile && job) ? await resolveJobFilePath(job) : null;

  await activeMedia.get(id)?.cancel();
  activeMedia.delete(id);
  await activeDownloaders.get(id)?.cancel();
  activeDownloaders.delete(id);
  await torrentEngine.remove(id, deleteFile).catch(() => {});
  await dropScratch(job);
  jobCookies.delete(id);
  queue.remove(id);
  pumpQueue();

  let deleted = false;
  if (filePath && await fs.pathExists(filePath)) {
    // Refuse to delete anything outside the folder the job saved into —
    // a stored path should not be able to reach across the disk.
    const within = path.resolve(filePath).startsWith(path.resolve(job.save_path));
    if (within) {
      try { await fs.remove(filePath); deleted = true; }
      catch (err) { return { ok: true, deleted: false, error: err.message }; }
    }
  }
  return { ok: true, deleted };
});

ipcMain.handle('queue:clearFinished', () => {
  // Their rows are about to go, so drop any credentials still held for them
  for (const job of queue.getAll()) {
    if (['done', 'cancelled', 'error'].includes(job.status)) jobCookies.delete(job.id);
  }
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

// ─────────────────────────────────────────────
//  IPC — Progress popup
// ─────────────────────────────────────────────

/** Dismiss the popup. It reappears on the next capture. */
ipcMain.handle('popup:hide', () => {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
  popupJobId = null;
  return { ok: true };
});

/** The one place the popup may raise the full window — the user asked */
ipcMain.handle('popup:openApp', () => {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  return { ok: true };
});

/** Keep the popup on the same theme as the app */
ipcMain.handle('popup:theme', (_e, { theme }) => {
  popupSend('popup:theme', { theme });
  return { ok: true };
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

    // What qualities a video page offers, so the extension's button can
    // ask before it downloads rather than picking for the user.
    if (req.method === 'POST' && req.url === '/probe') {
      let body = '';
      let tooBig = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) { tooBig = true; req.destroy(); }
      });
      req.on('end', async () => {
        if (tooBig) return;
        try {
          const { url, cookie } = JSON.parse(body);
          if (!media.isMediaUrl(url)) throw new Error('Not a supported video link');
          if (!(await media.isInstalled())) {
            throw new Error('Open Zest and set up the video helper first');
          }
          const info = await media.probe(url, typeof cookie === 'string' ? cookie : '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            title: info.title,
            qualities: info.qualities,
            playlist: info.playlist,
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
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
      // async: deciding whether a link needs the video engine involves a
      // filesystem check for the helper
      req.on('end', async () => {
        if (tooBig) return;
        try {
          const { type, url, referrer, filename, cookie, quality } = JSON.parse(body);
          if (!url) throw new Error('No URL');
          if (!isValidDownloadUrl(url)) throw new Error('Not a downloadable URL');

          const savePath = DEFAULT_DIR;
          const isTorrent = type === 'torrent' || url.startsWith('magnet:');
          // The Download button on a video page sends the page URL, which is
          // not a file — it needs the yt-dlp engine, not the HTTP one.
          const isMedia = !isTorrent && (type === 'media' || media.isMediaUrl(url));

          if (isMedia && !(await media.isInstalled())) {
            throw new Error('Open Zest and set up the video helper first (Video tab)');
          }

          const newId = enqueue({
            url,
            savePath,
            type:     isTorrent ? 'torrent' : isMedia ? 'media' : 'http',
            // The extension's button asks the user first, so honour its choice
            quality:  isMedia ? (typeof quality === 'string' && quality ? quality : 'best') : '',
            referrer: typeof referrer === 'string' ? referrer : '',
            cookie:   typeof cookie === 'string' ? cookie : '',
            filename: filename && filenameLooksLikeFile(filename)
              ? sanitizeFilename(decodeFilename(filename))
              : null,
          });

          // A small corner popup, not the whole app in your face
          if (newId) showPopupFor(newId);

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
    applyLoginItem();
    startBridgeServer();

    // Init auto-updater
    initUpdater(mainWindow, send);
    setTimeout(checkForUpdates, 5000);

    // The app updates itself; so must the program it downloads videos with
    startHelperUpdates();

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
      for (const mv of activeMedia.values()) mv.pause();
      activeMedia.clear();
      clearTimeout(helperCheckTimer);
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

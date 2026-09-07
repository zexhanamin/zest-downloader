/* ═══════════════════════════════════════════════
   Zest Downloader — src/media.js

   YouTube / Instagram / TikTok and friends.

   These sites do not serve a video as a file. They
   serve segmented DASH/HLS streams behind signed,
   short-lived URLs, and YouTube additionally ciphers
   the signature and throttles via an `n` parameter it
   changes regularly. Nothing in downloader.js can
   resolve that, so this module drives yt-dlp instead.

   yt-dlp is not bundled — it is fetched from its
   official GitHub release on first use, with the
   user's consent, and kept in userData so it can be
   updated when a site breaks it.
═══════════════════════════════════════════════ */

'use strict';

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const { sanitizeFilename, formatBytes } = require('./downloader');

// ─────────────────────────────────────────────
//  Where the helper binaries live
// ─────────────────────────────────────────────

const YTDLP_RELEASE_URL =
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

/** Same release, asked about rather than downloaded — this is how we know it moved */
const YTDLP_LATEST_API =
  'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

/**
 * ffmpeg, from the build the yt-dlp project maintains for exactly this use.
 *
 * Optional but close to essential: YouTube serves anything above 720p as
 * separate video and audio streams, and some videos have no combined stream
 * at all. Without ffmpeg those simply cannot be assembled.
 */
/**
 * Deno, the runtime yt-dlp enables by default.
 *
 * YouTube guards its stream URLs with a challenge that has to be executed.
 * Without a runtime yt-dlp still works but reaches fewer formats, so this is
 * offered the same way ffmpeg is: optional, fetched on request, never bundled.
 */
const DENO_RELEASE_URL =
  'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip';

const FFMPEG_RELEASE_URL =
  'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';

function binDir() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'bin');
  } catch (_) {
    return path.join(require('os').homedir(), '.zest', 'bin');
  }
}

function ytDlpPath() {
  return path.join(binDir(), 'yt-dlp.exe');
}

function ffmpegPath() {
  return path.join(binDir(), 'ffmpeg.exe');
}

/**
 * ffmpeg, ours first and the system's second.
 *
 * Cached, because it is consulted on every probe and download — with a way
 * to clear the cache once an install finishes.
 */
let _ffmpegCache = null;

function forgetFfmpeg() { _ffmpegCache = null; }

async function hasFfmpeg() {
  if (_ffmpegCache !== null) return _ffmpegCache;
  if (await fs.pathExists(ffmpegPath())) { _ffmpegCache = true; return true; }
  _ffmpegCache = await new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
  return _ffmpegCache;
}

/**
 * A JavaScript runtime for yt-dlp to solve YouTube's player challenge with.
 *
 * Without one yt-dlp warns that extraction is deprecated and that "some
 * formats may be missing" — and it is not idle: the same video resolves to
 * 4K with a runtime present and stops well short of it without. Only deno is
 * enabled by default, so anything else has to be named explicitly.
 */
let _jsRuntimeCache;

function forgetJsRuntime() { _jsRuntimeCache = undefined; }

function denoPath() {
  return path.join(binDir(), 'deno.exe');
}

async function jsRuntime() {
  if (_jsRuntimeCache !== undefined) return _jsRuntimeCache;

  // Our own copy is not on PATH, so it has to be named by full path
  if (await fs.pathExists(denoPath())) {
    _jsRuntimeCache = 'deno:' + denoPath();
    return _jsRuntimeCache;
  }

  for (const name of ['deno', 'node', 'bun']) {
    const ok = await new Promise((resolve) => {
      execFile(name, ['--version'], { timeout: 4000 }, (err) => resolve(!err));
    });
    if (ok) { _jsRuntimeCache = name; return name; }
  }
  _jsRuntimeCache = null;
  return null;
}

// ─────────────────────────────────────────────
//  Which links this module handles
// ─────────────────────────────────────────────

/**
 * Hosts whose links are a *page* holding a video, not a file.
 *
 * Deliberately a list rather than "anything yt-dlp might support": a URL
 * that is already a plain file should keep going through the normal HTTP
 * engine, which is faster and resumable.
 */
const MEDIA_HOSTS = [
  { name: 'YouTube',   re: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i },
  { name: 'Instagram', re: /(^|\.)instagram\.com$/i },
  { name: 'TikTok',    re: /(^|\.)tiktok\.com$/i },
  { name: 'Facebook',  re: /(^|\.)(facebook\.com|fb\.watch)$/i },
  { name: 'X',         re: /(^|\.)(twitter\.com|x\.com)$/i },
  { name: 'Reddit',    re: /(^|\.)reddit\.com$/i },
  { name: 'Vimeo',     re: /(^|\.)vimeo\.com$/i },
  { name: 'Dailymotion', re: /(^|\.)dailymotion\.com$/i },
  { name: 'Twitch',    re: /(^|\.)twitch\.tv$/i },
];

/** @returns {string|null} the site name, or null when this is not a media page */
function mediaSiteFor(url = '') {
  let host;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    host = u.hostname;
  } catch (_) { return null; }
  const hit = MEDIA_HOSTS.find(h => h.re.test(host));
  return hit ? hit.name : null;
}

function isMediaUrl(url = '') {
  return mediaSiteFor(url) !== null;
}

// ─────────────────────────────────────────────
//  Getting yt-dlp
// ─────────────────────────────────────────────

/** Is the helper already installed? */
function isInstalled() {
  return fs.pathExists(ytDlpPath());
}

/** Version string of the installed helper, or null */
function installedVersion() {
  return new Promise((resolve) => {
    execFile(ytDlpPath(), ['--version'], { timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

/**
 * Fetch a helper binary, retrying on a dropped connection.
 *
 * The ffmpeg archive is ~80 MB, and a single reset partway through would
 * otherwise fail the whole install — which is exactly what happened in
 * testing. Each attempt starts the file again rather than resuming: these
 * are one-off setup downloads, and a half-written binary is worse than a
 * slower retry.
 */
async function fetchWithRetry(url, dest, onProgress, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.remove(dest).catch(() => {});
      await fetchToFile(url, dest, onProgress);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw new Error(`${lastErr.message} (after ${attempts} attempts)`);
}

/** Follow redirects and stream a URL to disk, reporting progress */
function fetchToFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('Too many redirects')); return; }

    https.get(url, { headers: { 'User-Agent': 'ZestDownloader' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        resolve(fetchToFile(res.headers.location, dest, onProgress, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed with status ${res.statusCode}`));
        return;
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const writer = fs.createWriteStream(dest);

      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
      res.pipe(writer);
    }).on('error', reject);
  });
}

/**
 * Download (or re-download) yt-dlp into userData.
 *
 * This fetches and later runs an executable, so it is never done silently —
 * the caller is expected to have asked the user first.
 *
 * @param {(received:number,total:number)=>void} [onProgress]
 */
async function installYtDlp(onProgress) {
  await fs.ensureDir(binDir());
  const dest = ytDlpPath();
  const tmp  = `${dest}.part`;

  await fs.remove(tmp).catch(() => {});
  await fetchWithRetry(YTDLP_RELEASE_URL, tmp, onProgress);

  // Refuse to install something that will not run
  await fs.move(tmp, dest, { overwrite: true });
  const version = await installedVersion();
  if (!version) {
    await fs.remove(dest).catch(() => {});
    throw new Error('The downloaded helper did not run — installation cancelled');
  }
  return version;
}

// ─────────────────────────────────────────────
//  Keeping yt-dlp current
//
//  This is not housekeeping. YouTube and the rest change how they serve
//  video every few weeks, and a yt-dlp from two months ago simply stops
//  working on them — the download fails with an extractor error that means
//  nothing to the person looking at it. Nobody should have to know that a
//  separate program lives inside their downloader, so the app keeps its own
//  copy current instead of waiting to be told.
// ─────────────────────────────────────────────

/** How often an automatic check runs, and how soon to retry a locked binary */
const UPDATE_CHECK_EVERY = 24 * 60 * 60 * 1000;
const UPDATE_RETRY_BUSY  =      60 * 60 * 1000;

/**
 * Should an automatic check run right now?
 *
 * Kept apart from the checking so the policy can be read and tested on its
 * own — every one of these refusals is a decision, not a failure.
 *
 * @param {boolean} enabled    the user has not turned automatic updates off
 * @param {boolean} installed  there is a yt-dlp to replace in the first place
 * @param {boolean} busy       a video is downloading, so the exe is locked
 * @param {number}  checkedAt  when the last check got an answer
 */
function shouldCheckForUpdate({
  enabled = true, installed = false, busy = false, checkedAt = 0,
  now = Date.now(), every = UPDATE_CHECK_EVERY,
} = {}) {
  if (!enabled)   return { check: false, reason: 'disabled' };
  if (!installed) return { check: false, reason: 'not-installed' };
  if (busy)       return { check: false, reason: 'busy' };
  if (now - (checkedAt || 0) < every) return { check: false, reason: 'checked-recently' };
  return { check: true, reason: 'due' };
}

/** GET a JSON document, following redirects, giving up rather than hanging */
function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('Too many redirects')); return; }

    const req = https.get(url, {
      headers: { 'User-Agent': 'ZestDownloader', 'Accept': 'application/vnd.github+json' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        resolve(fetchJson(res.headers.location, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GitHub answered ${res.statusCode}`));
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        // A release document is a few KB. Anything bigger is not the answer
        // we asked for and is not worth holding on to.
        if (body.length > 512 * 1024) req.destroy(new Error('Reply was too large'));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('GitHub sent something that was not JSON')); }
      });
      res.on('error', reject);
    });

    req.setTimeout(10000, () => req.destroy(new Error('Timed out reaching GitHub')));
    req.on('error', reject);
  });
}

/**
 * The version tag of yt-dlp's newest release, or null.
 *
 * Null rather than a throw when GitHub cannot be reached: a check that did
 * not happen is a check to repeat tomorrow, not an error to put in anyone's
 * face. yt-dlp tags its releases with the same date string that
 * `yt-dlp --version` prints, so the two compare directly.
 */
async function latestVersion() {
  try {
    const release = await fetchJson(YTDLP_LATEST_API);
    const tag = String(release?.tag_name || '').trim();
    return tag || null;
  } catch (err) {
    console.warn('[Media] Could not ask GitHub for the yt-dlp version:', err.message);
    return null;
  }
}

/**
 * Replace yt-dlp with the current release, if it is behind.
 *
 * The caller must make sure no video download is running: Windows locks a
 * running executable, and the install would fail on the move.
 *
 * @returns {Promise<{updated:boolean, current:string|null, latest?:string|null,
 *                    from?:string|null, reason:string}>}
 */
async function updateYtDlp(onProgress) {
  if (!(await isInstalled())) {
    return { updated: false, current: null, reason: 'not-installed' };
  }

  const current = await installedVersion();
  const latest  = await latestVersion();

  if (!latest)            return { updated: false, current, reason: 'unreachable' };
  if (current === latest) return { updated: false, current, latest, reason: 'current' };

  const version = await installYtDlp(onProgress);
  return { updated: true, current: version, from: current, latest, reason: 'updated' };
}

/**
 * Fetch ffmpeg and put ffmpeg.exe / ffprobe.exe next to yt-dlp.
 *
 * The release is a zip, and Node has no unzip of its own. Rather than pull in
 * a dependency for one call, this shells out to PowerShell's Expand-Archive,
 * which ships with every supported version of Windows.
 *
 * @param {(received:number,total:number)=>void} [onProgress]
 */
/**
 * Fetch a zipped helper release and lift the executables out of it.
 *
 * Node has no unzip of its own. Rather than pull in a dependency for two
 * calls this shells out to PowerShell's Expand-Archive, which ships with
 * every supported version of Windows.
 *
 * @param {object} opts
 * @param {string} opts.label     what to call it in an error
 * @param {string} opts.url       release archive
 * @param {string[]} opts.wanted  executables to keep, lowercase
 * @param {string} opts.required  the one that must be present
 * @param {(received:number,total:number)=>void} [opts.onProgress]
 */
async function installZippedHelper({ label, url, wanted, required, onProgress }) {
  const dir = binDir();
  await fs.ensureDir(dir);

  // Unique per attempt. Windows keeps a deleted-but-still-open file in a
  // pending-delete state, so reusing one fixed name means an interrupted
  // install makes the next one fail with EPERM until the old handle closes.
  const stamp   = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const zip     = path.join(dir, label + '-' + stamp + '.zip');
  const extract = path.join(dir, label + '-' + stamp);

  // Clear anything a previous run left behind, best effort
  const stale = new RegExp('^' + label + '-\d+-');
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (stale.test(name)) await fs.remove(path.join(dir, name)).catch(() => {});
  }

  try {
    await fetchWithRetry(url, zip, onProgress);

    await new Promise((resolve, reject) => {
      execFile('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Expand-Archive -LiteralPath '" + zip + "' -DestinationPath '" + extract + "' -Force",
      ], { timeout: 180000 }, (err, _out, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim() || 'Could not unpack ' + label));
        else resolve();
      });
    });

    // Releases often nest everything under one versioned folder
    const found = {};
    const walk = async (d, depth = 0) => {
      if (depth > 4) return;
      for (const entry of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (wanted.includes(entry.name.toLowerCase())) found[entry.name.toLowerCase()] = full;
      }
    };
    await walk(extract);

    if (!found[required]) throw new Error(required + ' was not in the archive');
    for (const [name, src] of Object.entries(found)) {
      await fs.move(src, path.join(dir, name), { overwrite: true });
    }
    return true;
  } finally {
    await fs.remove(zip).catch(() => {});
    await fs.remove(extract).catch(() => {});
  }
}

/** ffmpeg.exe and ffprobe.exe, for merging separate video and audio streams */
async function installFfmpeg(onProgress) {
  const ok = await installZippedHelper({
    label: 'ffmpeg',
    url: FFMPEG_RELEASE_URL,
    wanted: ['ffmpeg.exe', 'ffprobe.exe'],
    required: 'ffmpeg.exe',
    onProgress,
  });
  forgetFfmpeg();
  return ok;
}

/** deno.exe, so yt-dlp can solve YouTube's player challenge */
async function installDeno(onProgress) {
  const ok = await installZippedHelper({
    label: 'deno',
    url: DENO_RELEASE_URL,
    wanted: ['deno.exe'],
    required: 'deno.exe',
    onProgress,
  });
  forgetJsRuntime();
  return ok;
}

// ─────────────────────────────────────────────
//  Reading a page's media info
// ─────────────────────────────────────────────

/**
 * Turn yt-dlp's raw complaint into something a person can act on.
 *
 * The common failure by far is a site that needs a session — Instagram
 * refuses almost everything anonymously — and "login required" alone does
 * not tell anyone what to do about it inside this app.
 */
function friendlyError(message = '') {
  const m = String(message);
  if (/login required|not available.*login|rate-limit|Sign in to confirm|private video|cookies/i.test(m)) {
    return 'This needs you to be signed in on that site. Use the Download button '
         + 'the Zest extension puts on the page - it passes your browser session along.';
  }
  if (/Video unavailable|removed|does not exist/i.test(m)) {
    return 'That video is unavailable - it may be private, removed or region-locked.';
  }
  if (/no video in this post|There is no video/i.test(m)) {
    return 'That post has no video in it. Hover the image itself and use the '
         + 'button that appears on it to save the picture.';
  }
  if (/Unsupported URL/i.test(m)) {
    return 'That link is not one the video helper knows how to read.';
  }
  return m;
}

/**
 * Turn a raw `Cookie:` header into the Netscape file yt-dlp expects.
 *
 * yt-dlp refuses to treat `--add-header Cookie:` as a real cookie jar — it
 * warns that doing so is a security risk, and on YouTube it breaks extraction
 * outright ("The page needs to be reloaded"), because the session cookies
 * arrive without the tokens yt-dlp would otherwise negotiate itself.
 */
function cookiesToNetscape(header = '', url = '') {
  let domain;
  try { domain = new URL(url).hostname; } catch (_) { return null; }
  if (!domain) return null;

  const dot = domain.startsWith('.') ? domain : '.' + domain.replace(/^www[.]/, '');
  const out = ['# Netscape HTTP Cookie File'];

  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name  = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    // domain, includeSubdomains, path, secure, expiry, name, value
    out.push([dot, 'TRUE', '/', 'FALSE', '0', name, value].join('\t'));
  }
  return out.length > 1 ? out.join('\n') + '\n' : null;
}

/**
 * Run `fn` with the extra arguments needed to present these cookies, and take
 * the file away again afterwards. The jar is a live credential, so it exists
 * for exactly as long as the one command that needs it.
 */
async function withCookies(cookie, url, fn) {
  const jar = cookiesToNetscape(cookie, url);
  if (!jar) return fn([]);

  await fs.ensureDir(binDir());
  const file = path.join(
    binDir(),
    `cookies-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  try {
    await fs.writeFile(file, jar, { mode: 0o600 });
    return await fn(['--cookies', file]);
  } finally {
    await fs.remove(file).catch(() => {});
  }
}

function runYtDlp(args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ytDlpPath(), args, { timeout, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim().split('\n').pop();
          reject(new Error(friendlyError(detail || 'yt-dlp failed')));
          return;
        }
        resolve(String(stdout));
      });
  });
}

/**
 * Does this link point at a playlist as well as a video?
 *
 * A YouTube URL copied from a video that happens to sit in a playlist carries
 * ?list=, so the presence of the parameter is an offer to make, not an
 * instruction to follow — the caller decides which the user meant.
 *
 * @returns {Promise<{title:string,count:number}|null>}
 */
async function probePlaylist(url) {
  let hasList = false;
  try {
    const u = new URL(url);

    // A list id beginning RD is a YouTube Mix: an auto-generated radio that
    // never really ends and that the user did not curate. Offering to fetch
    // "110 videos" from one is a trap, so a mix is not a playlist here.
    const list = u.searchParams.get('list') || '';
    if (/^RD/i.test(list)) return null;
    hasList = u.searchParams.has('list')
           || /\/(playlist|channel|@[^/]+\/videos)/.test(u.pathname);
  } catch (_) { return null; }
  if (!hasList) return null;

  try {
    // --flat-playlist lists entries without resolving each one, which keeps
    // this fast enough to run while the user is still looking at the box.
    const raw = await runYtDlp([
      '--flat-playlist', '--dump-single-json', '--no-warnings', '--yes-playlist', url,
    ], { timeout: 45000 });
    const info = JSON.parse(raw);
    const count = Array.isArray(info.entries) ? info.entries.length : 0;
    if (count < 2) return null;
    return { title: info.title || 'Playlist', count };
  } catch (_) {
    return null;   // not fatal — the single video still works
  }
}

/**
 * Title, thumbnail, duration and the quality choices worth offering.
 * @returns {Promise<object>}
 */
async function probe(url, cookie = '') {
  const base = ['--dump-single-json', '--no-warnings', '--no-playlist'];
  const runtime = await jsRuntime();
  if (runtime) base.push('--js-runtimes', runtime);

  // Try with the session first, then without. A site like Instagram needs
  // it; YouTube can be broken by it, and a public video does not want it.
  const attempt = (extra) => runYtDlp([...base, ...extra, url]);
  let raw;
  try {
    raw = await withCookies(cookie, url, attempt);
  } catch (err) {
    if (!cookie) throw err;
    raw = await attempt([]);
  }

  let info;
  try { info = JSON.parse(raw); }
  catch (_) { throw new Error('Could not read the video details'); }

  return {
    id:        info.id,
    title:     info.title || 'Untitled',
    uploader:  info.uploader || info.channel || '',
    duration:  info.duration || 0,
    thumbnail: info.thumbnail || '',
    site:      mediaSiteFor(url) || info.extractor_key || '',
    qualities: qualitiesFor(info),
    playlist:  await probePlaylist(url),
  };
}

/**
 * Collapse yt-dlp's long format list into the handful of choices a person
 * actually wants, largest first.
 */
function qualitiesFor(info) {
  const heights = new Set();
  for (const f of info.formats || []) {
    if (f.vcodec && f.vcodec !== 'none' && f.height) heights.add(f.height);
  }
  const list = [...heights]
    .sort((a, b) => b - a)
    .filter(h => h >= 144)
    .map(h => ({ id: String(h), label: `${h}p`, height: h }));

  // Audio-only is worth offering on every site
  list.push({ id: 'audio', label: 'Audio only (m4a)', height: 0 });
  return list;
}

/**
 * Build the format selector.
 *
 * Above 720p YouTube serves video and audio separately, so the two have to
 * be merged — which needs ffmpeg. Without it, fall back to the best stream
 * that already carries both, rather than producing a silent video.
 */
function formatSelector(quality, ffmpeg) {
  if (quality === 'audio') {
    return ffmpeg ? 'bestaudio[ext=m4a]/bestaudio' : 'bestaudio[ext=m4a]/bestaudio';
  }
  const h = parseInt(quality, 10);
  const cap = Number.isFinite(h) ? `[height<=${h}]` : '';
  if (!ffmpeg) {
    // Pre-merged streams only
    return `best${cap}[ext=mp4]/best${cap}/best`;
  }
  return `bestvideo${cap}+bestaudio/best${cap}/best`;
}

// ─────────────────────────────────────────────
//  MediaDownload — one video, as an EventEmitter
//  so it plugs into the same wiring as the HTTP
//  and torrent engines.
// ─────────────────────────────────────────────

/** yt-dlp writes one of these per progress tick, thanks to --progress-template */
const PROGRESS_PREFIX = 'ZESTPROGRESS';

class MediaDownload extends EventEmitter {
  /**
   * @param {object}  opts
   * @param {string}  opts.url
   * @param {string}  opts.savePath
   * @param {string}  [opts.id]
   * @param {string}  [opts.quality]  height like "1080", or "audio"
   * @param {boolean} [opts.playlist] fetch every entry, not just this video
   * @param {string}  [opts.cookie]   Cookie header captured from the browser
   */
  constructor({ url, savePath, id = null, quality = 'best', playlist = false, cookie = '' }) {
    super();
    this.url      = url;
    this.savePath = savePath;
    this.id       = id;
    this.quality  = quality;
    this.playlist = Boolean(playlist);
    this.cookie   = cookie || '';

    this.proc      = null;
    this.status    = 'idle';
    this.filename  = null;
    this.finalPath = null;
    this.totalBytes = 0;
    this.downloadedBytes = 0;

    // Running totals across the video/audio phases of a merged download
    this._phaseBase  = 0;
    this._phaseTotal = 0;
    this._phaseBytes = 0;

    // Running totals across the entries of a playlist
    this._itemIndex     = null;   // playlist position yt-dlp last reported
    this._itemsDone     = 0;
    this._itemsBytes    = 0;      // bytes finished in earlier entries
    this.itemCount      = 0;      // 0 until yt-dlp says how many there are
  }

  /** Fold the entry that just finished into the playlist running totals */
  _startNewItem(index) {
    if (this._itemIndex !== null) {
      this._itemsBytes += this._phaseBase + this._phaseBytes;
      this._itemsDone  += 1;
    }
    this._itemIndex  = index;
    this._phaseBase  = 0;
    this._phaseTotal = 0;
    this._phaseBytes = 0;
  }

  async start() {
    if (this.status === 'downloading') return;
    this.status = 'downloading';

    try {
      if (!(await isInstalled())) {
        throw new Error('The video helper is not installed yet');
      }
      await fs.ensureDir(this.savePath);

      const ffmpeg = await hasFfmpeg();
      const info   = await probe(this.url, this.cookie);
      this.filename = sanitizeFilename(
        `${info.title}.${this.quality === 'audio' ? 'm4a' : 'mp4'}`
      );

      this.emit('meta', {
        id:        this.id,
        filename:  this.filename,
        totalBytes: 0,
        title:     info.title,
        thumbnail: info.thumbnail,
        site:      info.site,
      });

      // The cookie file must exist for as long as yt-dlp is running, so
      // the jar wraps the whole download rather than just its arguments.
      const runtime = await jsRuntime();

      // TikTok solves a JS challenge to reach its data and fails often, in
      // both directions: a session helps one attempt and breaks the next.
      // The probe already tried both ways, so the download must too, or a
      // video whose title resolved fine dies at 403 a second later.
      try {
        await withCookies(this.cookie, this.url,
          (cookieArgs) => this._run(ffmpeg, cookieArgs, runtime));
      } catch (err) {
        if (!this.cookie || this.status === 'cancelled' || this.status === 'paused') throw err;
        await this._run(ffmpeg, [], runtime);
      }
    } catch (err) {
      if (this.status === 'cancelled' || this.status === 'paused') return;
      this.status = 'error';
      this.emit('error', err);
    }
  }

  _run(ffmpeg, cookieArgs = [], runtime = null) {
    // Where yt-dlp records the files it finished. It has to be a file:
    // --print writes through the console encoding, and on Windows that
    // silently drops every character it cannot represent, so a title with
    // emoji or Arabic in it came back as a path that does not exist and
    // Open failed on a file sitting right there in the folder.
    // --print-to-file is written as UTF-8 and keeps the name intact.
    const listPath = path.join(
      os.tmpdir(),
      `zest-files-${this.id || Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
    );

    return new Promise((resolve, reject) => {
      // --windows-filenames keeps the real title and only strips what Windows
      // cannot store. --restrict-filenames used to mangle every space into an
      // underscore and drop non-ASCII, which is not "sanitised", it is unreadable.
      // A playlist lands in its own folder, numbered so it keeps its order
      const outTemplate = this.playlist
        ? path.join(this.savePath, '%(playlist_title)s', '%(playlist_index)s - %(title)s.%(ext)s')
        : path.join(this.savePath, '%(title)s.%(ext)s');

      const args = [
        // A playlist download keeps every entry; otherwise a link that happens
        // to carry ?list= must still fetch just the one video the user clicked.
        this.playlist ? '--yes-playlist' : '--no-playlist',
        '--no-warnings',
        '--newline',
        // yt-dlp hides progress entirely when stdout is not a terminal, and
        // it always is one here — without this the template emits nothing and
        // the progress bar never moves.
        '--progress',
        '--windows-filenames',
        // Keep .part files: yt-dlp resumes from them, which is what makes
        // pause and resume mean something here rather than start-over.
        '--continue',
        '-f', formatSelector(this.quality, ffmpeg),
        '-o', outTemplate,
        '--progress-template',
        `${PROGRESS_PREFIX}|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|` +
        `%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|` +
        `%(info.playlist_index)s|%(info.playlist_count)s`,
        '--print-to-file', 'after_move:%(filepath)s', listPath,
      ];
      // -x re-encodes through ffmpeg. When there is no ffmpeg, take YouTube's
      // m4a audio stream as it comes — the selector already asks for one, so
      // extraction would only be a re-wrap we cannot perform anyway.
      if (this.quality === 'audio' && ffmpeg) args.push('-x', '--audio-format', 'm4a');
      if (ffmpeg) {
        args.push('--merge-output-format', 'mp4');
        // Our own copy is not on PATH, so point yt-dlp straight at it
        if (fs.existsSync(ffmpegPath())) args.push('--ffmpeg-location', binDir());
      }
      // Instagram, and anything else behind a login, returns nothing useful to
      // an anonymous client. The browser's session for that site is what makes
      // those links work at all.
      if (cookieArgs.length) args.push(...cookieArgs);
      if (runtime) args.push('--js-runtimes', runtime);
      args.push(this.url);

      this.proc = spawn(ytDlpPath(), args, { windowsHide: true });

      let stderrTail = '';
      let buffer = '';

      this.proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const l = line.trim();
          if (l.startsWith(PROGRESS_PREFIX)) this._onProgressLine(l);
        }
      });

      this.proc.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });

      this.proc.on('error', reject);

      this.proc.on('close', async (code) => {
        this.proc = null;
        await this._readFinishedFiles(listPath);
        if (this.status === 'cancelled' || this.status === 'paused') { resolve(); return; }
        if (code === 0) {
          this.status = 'done';
          if (!this.totalBytes) this.totalBytes = this.downloadedBytes;
          this.emit('done', {
            id:         this.id,
            filename:   this.filename,
            path:       this.finalPath || path.join(this.savePath, this.filename || ''),
            totalBytes: this.totalBytes,
          });
          resolve();
        } else {
          const last = stderrTail.trim().split('\n').filter(Boolean).pop();
          reject(new Error(friendlyError(last || `yt-dlp exited with code ${code}`)));
        }
      });
    });
  }

  /**
   * Take the real on-disk paths from the list yt-dlp just wrote.
   *
   * One line per finished file. A playlist writes one per entry, and opening
   * the fortieth video is not what "Open" means there — the folder yt-dlp
   * filled is, so a playlist points at that instead.
   */
  async _readFinishedFiles(listPath) {
    let lines = [];
    try {
      const raw = await fs.readFile(listPath, 'utf8');
      lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    } catch (_) {
      // Nothing was written: the run was cancelled, or it failed before
      // a single file reached its final name.
    }
    await fs.remove(listPath).catch(() => {});
    if (!lines.length) return;

    if (this.playlist && lines.length > 1) {
      const folder = path.dirname(lines[0]);
      const sameFolder = lines.every(l => path.dirname(l) === folder);
      if (sameFolder && path.resolve(folder) !== path.resolve(this.savePath)) {
        this.finalPath = folder;
        this.filename  = path.basename(folder);
        return;
      }
    }

    this.finalPath = lines[lines.length - 1];
    this.filename  = path.basename(this.finalPath);
  }

  _onProgressLine(line) {
    const [, dl, total, estimate, speed, eta, idx, count] = line.split('|');
    const num = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    };

    // A playlist entry finishing looks like a fresh set of byte counts. Track
    // the position so those bytes are banked instead of overwriting the last
    // entry's, and so the card can say which video of how many is running.
    const itemIndex = num(idx) || 1;
    const itemCount = num(count);
    if (itemCount) this.itemCount = itemCount;
    if (this._itemIndex === null) this._itemIndex = itemIndex;
    else if (itemIndex !== this._itemIndex) this._startNewItem(itemIndex);

    const phaseBytes = num(dl);
    const phaseTotal = num(total) || num(estimate);

    // A merged download runs in phases: the video stream, then the audio.
    // Each one restarts its byte count at zero, so without carrying the
    // finished phases forward the bar would fill up and snap back to nothing.
    if (phaseBytes < this._phaseBytes) {
      this._phaseBase  += this._phaseBytes;
      this._phaseTotal += this._phaseBytes;
    }
    this._phaseBytes = phaseBytes;

    this.downloadedBytes = this._itemsBytes + this._phaseBase + phaseBytes;

    // For a playlist the real total is unknown until the last entry, so
    // project it from what the finished entries actually weighed. It is an
    // estimate and it moves, but it beats a bar that sits at 100% per video.
    let projected = this._itemsBytes + this._phaseTotal + phaseTotal;
    if (this.itemCount > 1 && this._itemsDone > 0) {
      const perItem = this._itemsBytes / this._itemsDone;
      projected = Math.max(projected, perItem * this.itemCount);
    }
    this.totalBytes = Math.max(projected, this.downloadedBytes) || this.totalBytes;
    const speedRaw = num(speed);

    this.emit('progress', {
      id:              this.id,
      downloadedBytes: this.downloadedBytes,
      totalBytes:      this.totalBytes,
      percent: this.totalBytes
        ? ((this.downloadedBytes / this.totalBytes) * 100).toFixed(1)
        : null,
      speed:    `${formatBytes(speedRaw)}/s`,
      speedRaw,
      eta:      num(eta) || null,
      item:      this.itemCount > 1 ? this._itemsDone + 1 : 0,
      itemCount: this.itemCount > 1 ? this.itemCount : 0,
    });
  }

  /**
   * Stop the transfer but leave the .part file alone — starting again picks
   * up from those bytes because yt-dlp is run with --continue.
   */
  pause() {
    if (this.status !== 'downloading') return;
    this.status = 'paused';
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
    }
    this.emit('paused', { id: this.id });
  }

  /** Stop and throw away the partial data */
  async cancel() {
    this.status = 'cancelled';
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
    }
    await this._cleanup();
    this.emit('cancelled', { id: this.id });
  }

  /** Remove the .part leftovers yt-dlp keeps for resuming */
  async _cleanup() {
    const target = this.finalPath
      || (this.filename ? path.join(this.savePath, this.filename) : null);
    if (!target) return;
    for (const p of [`${target}.part`, `${target}.ytdl`, target]) {
      await fs.remove(p).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────
module.exports = {
  MediaDownload,
  isMediaUrl,
  mediaSiteFor,
  isInstalled,
  installedVersion,
  latestVersion,
  updateYtDlp,
  shouldCheckForUpdate,
  UPDATE_CHECK_EVERY,
  UPDATE_RETRY_BUSY,
  installYtDlp,
  installFfmpeg,
  probe,
  probePlaylist,
  cookiesToNetscape,
  friendlyError,
  hasFfmpeg,
  jsRuntime,
  forgetJsRuntime,
  denoPath,
  installDeno,
  ffmpegPath,
  forgetFfmpeg,
  qualitiesFor,
  formatSelector,
  ytDlpPath,
  MEDIA_HOSTS,
};

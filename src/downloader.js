/* ═══════════════════════════════════════════════
   Zest Downloader — src/downloader.js
   HTTP engine: multi-chunk parallel download with
   real resume, range verification and safe naming.
═══════════════════════════════════════════════ */

'use strict';

const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { EventEmitter } = require('events');
const { config } = require('./config');

// ─────────────────────────────────────────────
//  Constants — user-tunable ones come from config
// ─────────────────────────────────────────────
const DEFAULT_CHUNKS  = config.maxChunks;      // parallel segments per download
const MIN_CHUNK_SIZE  = config.minChunkSize;   // don't split below this
const RETRY_LIMIT     = config.retryLimit;
const RETRY_DELAY_MS  = config.retryDelayMs;
const SPEED_WINDOW_MS = 3000;                  // sliding window for the speed readout

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Windows reserved device names — can never be used as a filename
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/** Sleep for `ms` milliseconds */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Format bytes to human-readable string */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Strip everything that could escape the download directory or break the
 * filesystem. A hostile server can put anything in Content-Disposition,
 * so this must run on every name before it reaches path.join().
 */
function sanitizeFilename(name = '') {
  let base = String(name).split(/[\\/]/).pop() || '';
  base = base.replace(/[\x00-\x1f\x7f]/g, '');   // control chars
  base = base.replace(/[<>:"|?*]/g, '_');        // illegal on Windows
  base = base.replace(/^\.+/, '');               // leading dots, "..", hidden files
  base = base.replace(/[. ]+$/, '');             // Windows strips these anyway
  base = base.trim();
  if (!base || RESERVED_NAMES.test(base)) base = `download_${Date.now()}`;
  if (base.length > 180) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, 180 - ext.length) + ext;
  }
  return base;
}

/** Pull a filename out of Content-Disposition, falling back to the URL path */
function resolveFilename(url, headers = {}) {
  const cd = headers['content-disposition'] || '';

  // RFC 5987: filename*=UTF-8''name.ext  (takes precedence over plain filename)
  const ext5987 = cd.match(/filename\*\s*=\s*[^']*''([^;\r\n]+)/i);
  if (ext5987) {
    try { return sanitizeFilename(decodeURIComponent(ext5987[1].trim())); }
    catch (_) { return sanitizeFilename(ext5987[1].trim()); }
  }

  const plain = cd.match(/filename\s*=\s*("([^"]*)"|'([^']*)'|[^;\r\n]*)/i);
  if (plain) {
    const raw = (plain[2] ?? plain[3] ?? plain[1] ?? '').trim();
    if (raw) {
      try { return sanitizeFilename(decodeURIComponent(raw)); }
      catch (_) { return sanitizeFilename(raw); }
    }
  }

  let base = 'download';
  try { base = path.basename(new URL(url).pathname) || 'download'; } catch (_) {}
  try { base = decodeURIComponent(base); } catch (_) {}
  return sanitizeFilename(base);
}

/** Guess an extension from the Content-Type when the name has none */
function extForMime(mime = '') {
  const clean = String(mime).split(';')[0].trim().toLowerCase();
  const map = {
    'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
    'application/x-rar-compressed': '.rar', 'application/vnd.rar': '.rar',
    'application/x-7z-compressed': '.7z', 'application/gzip': '.gz',
    'application/x-tar': '.tar', 'application/pdf': '.pdf',
    'application/x-msdownload': '.exe', 'application/x-msdos-program': '.exe',
    'application/vnd.android.package-archive': '.apk',
    'application/x-apple-diskimage': '.dmg',
    'application/x-iso9660-image': '.iso',
    'application/x-bittorrent': '.torrent',
    'video/mp4': '.mp4', 'video/x-matroska': '.mkv', 'video/webm': '.webm',
    'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
    'audio/mpeg': '.mp3', 'audio/flac': '.flac', 'audio/wav': '.wav',
    'audio/ogg': '.ogg', 'audio/x-m4a': '.m4a',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp',
  };
  return map[clean] || '';
}

/** Pick a name that does not clobber an existing file: "movie (1).mp4" */
async function uniquePath(dir, filename) {
  const ext  = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 0;
  while (await fs.pathExists(candidate)) {
    n += 1;
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (n > 9999) break;
  }
  return candidate;
}

/**
 * A login wall or an expired session answers with a web page, not the file.
 * Saving that under the real filename is how a "corrupt download" happens —
 * a .pdf that is actually 9 KB of HTML. Better to fail loudly.
 */
function isHtmlResponse(contentType = '') {
  const clean = String(contentType).split(';')[0].trim().toLowerCase();
  return clean === 'text/html' || clean === 'application/xhtml+xml';
}

const HTML_EXTS = new Set(['html', 'htm', 'xhtml', 'php', 'asp', 'aspx', 'jsp', '']);

/** True when the failure came from us calling abort() */
function isAbort(err) {
  return !!err && (err.name === 'AbortError' || err.name === 'CanceledError' ||
                   err.code === 'ERR_CANCELED' || err.message === 'canceled');
}

// ─────────────────────────────────────────────
//  Chunk downloader  (single byte-range segment)
// ─────────────────────────────────────────────

/**
 * Download one byte-range segment into a temp file, appending to whatever is
 * already there so a paused or crashed transfer picks up where it stopped.
 * Throws RANGE_UNSUPPORTED (without retrying) if the server answers 200 to a
 * ranged request — that means it sent the whole body, and merging the parts
 * would silently produce a corrupt file.
 */
async function downloadChunk({ url, start, end, tmpPath, onProgress, signal, headers = {} }) {
  const wanted = end - start + 1;
  let attempt  = 0;

  for (;;) {
    // How much of this segment survived a previous attempt?
    let have = 0;
    try { have = (await fs.stat(tmpPath)).size; } catch (_) { have = 0; }
    if (have > wanted) { await fs.truncate(tmpPath, wanted); have = wanted; }
    if (have === wanted) return;

    try {
      const response = await axios({
        method:       'get',
        url,
        responseType: 'stream',
        headers: {
          ...headers,
          Range: `bytes=${start + have}-${end}`,
          // gzip would make the byte offsets meaningless
          'Accept-Encoding': 'identity',
        },
        signal,
        maxRedirects:   5,
        validateStatus: () => true,
      });

      if (response.status !== 206) {
        response.data.destroy();
        const err = new Error(
          response.status === 200
            ? 'Server ignored the byte-range request'
            : `Unexpected status ${response.status}`
        );
        err.code = response.status === 200 ? 'RANGE_UNSUPPORTED' : 'BAD_STATUS';
        throw err;
      }

      const writer = fs.createWriteStream(tmpPath, { flags: have > 0 ? 'a' : 'w' });

      await new Promise((resolve, reject) => {
        response.data.on('data', (buf) => onProgress(buf.length));
        response.data.on('error', reject);
        writer.on('error', reject);
        writer.on('finish', resolve);
        response.data.pipe(writer);
      });

      return; // success
    } catch (err) {
      if (isAbort(err) || err.code === 'RANGE_UNSUPPORTED') throw err;
      attempt += 1;
      if (attempt >= RETRY_LIMIT) {
        throw new Error(`Chunk failed after ${RETRY_LIMIT} retries: ${err.message}`);
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

// ─────────────────────────────────────────────
//  Main Downloader class
// ─────────────────────────────────────────────

class Downloader extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.url
   * @param {string}  opts.savePath   - directory to save the file
   * @param {number}  [opts.chunks]   - number of parallel chunks
   * @param {string}  [opts.id]       - queue job ID (optional)
   * @param {string}  [opts.referrer] - page the download was started from
   * @param {string}  [opts.filename] - name hinted by the browser extension
   * @param {string}  [opts.cookie]   - Cookie header captured from the browser
   */
  constructor({ url, savePath, chunks = DEFAULT_CHUNKS, id = null, referrer = '',
                filename = null, cookie = '' }) {
    super();
    this.url        = url;
    this.savePath   = savePath;
    this.chunks     = chunks;
    this.id         = id;
    this.referrer   = referrer || '';
    this.cookie     = cookie || '';
    this.hintedName = filename ? sanitizeFilename(filename) : null;

    // State
    this.filename        = null;
    this.finalPath       = null;
    this.totalBytes      = 0;
    this.downloadedBytes = 0;
    this.status          = 'idle';   // idle | downloading | paused | done | error | cancelled
    this.startTime       = null;
    this.controller      = null;     // AbortController
    this.tmpDir          = null;
    this.partFile        = null;
    this._samples        = [];       // [{t, bytes}] sliding window for speed
  }

  // ── Public API ──────────────────────────────

  /** Start or resume the download */
  async start() {
    if (this.status === 'downloading') return;
    this.status     = 'downloading';
    this.startTime  = Date.now();
    this.controller = new AbortController();
    this._samples   = [];

    try {
      await this._run();
    } catch (err) {
      if (isAbort(err) || this.status === 'paused' || this.status === 'cancelled') {
        // paused or cancelled — partial data stays on disk for the next resume
        return;
      }
      this.status = 'error';
      this.emit('error', err);
    }
  }

  /** Pause the download — temp data is kept so resume continues from here */
  pause() {
    if (this.status !== 'downloading') return;
    this.status = 'paused';
    this.controller?.abort();
    this.emit('paused', { id: this.id });
  }

  /** Cancel and delete every temp artefact */
  async cancel() {
    this.status = 'cancelled';
    this.controller?.abort();
    await this._cleanup(true);
    this.emit('cancelled', { id: this.id });
  }

  // ── Internal ────────────────────────────────

  /** Headers sent with every request — many hosts 403 without these */
  _reqHeaders() {
    const h = { 'User-Agent': USER_AGENT, Accept: '*/*' };
    if (this.referrer) {
      h.Referer = this.referrer;
      try { h.Origin = new URL(this.referrer).origin; } catch (_) {}
    }
    // Without the browser's session, a login-protected file comes back as the
    // sign-in page and gets saved under the real filename
    if (this.cookie) h.Cookie = this.cookie;
    return h;
  }

  /**
   * Work out size, range support and filename. HEAD is tried first because it
   * is cheap, then a one-byte ranged GET because it is authoritative — plenty
   * of servers advertise Accept-Ranges and then ignore Range.
   */
  async _probe() {
    let headHeaders = {};
    let headOk      = false;

    try {
      const h = await axios.head(this.url, {
        headers:        this._reqHeaders(),
        maxRedirects:   5,
        signal:         this.controller.signal,
        validateStatus: () => true,
      });
      if (h.status < 400) { headHeaders = h.headers || {}; headOk = true; }
    } catch (err) {
      if (isAbort(err)) throw err;
    }

    let total  = parseInt(headHeaders['content-length'] || '0', 10) || 0;
    let ranges = String(headHeaders['accept-ranges'] || '').toLowerCase() === 'bytes';
    let probeHeaders = {};

    try {
      const g = await axios({
        method:       'get',
        url:          this.url,
        responseType: 'stream',
        headers:      { ...this._reqHeaders(), Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
        maxRedirects: 5,
        signal:       this.controller.signal,
        validateStatus: () => true,
      });
      probeHeaders = g.headers || {};
      g.data.destroy();

      if (g.status === 206) {
        ranges = true;
        const m = String(probeHeaders['content-range'] || '').match(/\/(\d+)\s*$/);
        if (m) total = parseInt(m[1], 10);
      } else if (g.status === 200) {
        ranges = false;
        total  = parseInt(probeHeaders['content-length'] || '0', 10) || total;
      } else if (g.status >= 400 && !headOk) {
        throw new Error(`Server responded ${g.status}`);
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      if (!headOk) throw err;
    }

    // Content-Disposition can arrive on either response
    const nameHeaders = headHeaders['content-disposition']
      ? headHeaders
      : (probeHeaders['content-disposition'] ? probeHeaders : headHeaders);

    let filename = this.hintedName || resolveFilename(this.url, nameHeaders);
    if (!path.extname(filename)) {
      const guess = extForMime(nameHeaders['content-type'] || probeHeaders['content-type'] || '');
      if (guess) filename += guess;
    }

    const contentType = nameHeaders['content-type'] || probeHeaders['content-type'] || '';

    return { total, ranges, filename, contentType };
  }

  /** Read back the sidecar written by a previous run of this same job */
  async _loadState(statePath) {
    try {
      const st = await fs.readJson(statePath);
      if (st && st.url === this.url && st.finalPath && Array.isArray(st.chunks)) return st;
    } catch (_) {}
    return null;
  }

  async _run() {
    const probe = await this._probe();
    this.totalBytes = probe.total;
    this.filename   = probe.filename;

    // Asked for a PDF and handed an HTML page? That is a sign-in wall or an
    // expired session, not a file. Refuse rather than write it to disk.
    const ext = path.extname(this.filename).slice(1).toLowerCase();
    if (isHtmlResponse(probe.contentType) && !HTML_EXTS.has(ext)) {
      throw new Error(
        `Server sent a web page instead of a .${ext} file — ` +
        'the link may need you to be signed in, or it has expired'
      );
    }

    await fs.ensureDir(this.savePath);

    const useChunks =
      probe.ranges &&
      this.totalBytes > 0 &&
      this.totalBytes > MIN_CHUNK_SIZE * 2;

    // A previous run of this job leaves its scratch dir keyed on the job id,
    // which is what lets resume find the bytes it already has.
    const scratch   = path.join(this.savePath, `.zest-${this.id || 'anon'}.parts`);
    const statePath = path.join(scratch, 'state.json');
    const prior     = await this._loadState(statePath);

    if (prior) {
      this.finalPath = prior.finalPath;
      this.filename  = path.basename(prior.finalPath);
      if (prior.totalBytes) this.totalBytes = prior.totalBytes;
    } else {
      this.finalPath = await uniquePath(this.savePath, this.filename);
      this.filename  = path.basename(this.finalPath);
    }

    this.emit('meta', {
      id:         this.id,
      filename:   this.filename,
      totalBytes: this.totalBytes,
      resumable:  probe.ranges,
    });

    if (useChunks) {
      try {
        await this._chunkedDownload(scratch, statePath, prior);
      } catch (err) {
        if (err.code === 'RANGE_UNSUPPORTED') {
          // The server lied about ranges. Throw the parts away and stream it.
          await this._cleanup(true);
          this.downloadedBytes = 0;
          await this._singleDownload();
        } else {
          throw err;
        }
      }
    } else {
      await this._singleDownload();
    }

    this.status = 'done';
    // Callers need the final size: servers without Content-Length only
    // reveal it once every byte has actually arrived.
    if (!this.totalBytes) this.totalBytes = this.downloadedBytes;
    this.emit('done', {
      id:         this.id,
      filename:   this.filename,
      path:       this.finalPath,
      totalBytes: this.totalBytes,
    });
  }

  // ── Chunked download ─────────────────────────

  async _chunkedDownload(scratch, statePath, prior) {
    this.tmpDir = scratch;
    await fs.ensureDir(scratch);

    let chunkList;
    if (prior && prior.totalBytes === this.totalBytes) {
      chunkList = prior.chunks.map((c) => ({ ...c, tmpPath: path.join(scratch, `part_${c.index}`) }));
    } else {
      // Layout changed (or first run) — any old parts are meaningless
      if (prior) await fs.emptyDir(scratch);
      const numChunks = Math.max(1, Math.min(this.chunks, Math.floor(this.totalBytes / MIN_CHUNK_SIZE)));
      const chunkSize = Math.ceil(this.totalBytes / numChunks);
      chunkList = Array.from({ length: numChunks }, (_, i) => {
        const start = i * chunkSize;
        const end   = Math.min(start + chunkSize - 1, this.totalBytes - 1);
        return { index: i, start, end, tmpPath: path.join(scratch, `part_${i}`) };
      });
    }

    await fs.writeJson(statePath, {
      url:        this.url,
      finalPath:  this.finalPath,
      totalBytes: this.totalBytes,
      chunks:     chunkList.map(({ index, start, end }) => ({ index, start, end })),
    });

    // Count what is already on disk so progress resumes at the right place
    this.downloadedBytes = 0;
    for (const c of chunkList) {
      try {
        const size = (await fs.stat(c.tmpPath)).size;
        this.downloadedBytes += Math.min(size, c.end - c.start + 1);
      } catch (_) {}
    }
    this._emitProgress();

    await Promise.all(
      chunkList.map((chunk) =>
        downloadChunk({
          url:     this.url,
          start:   chunk.start,
          end:     chunk.end,
          tmpPath: chunk.tmpPath,
          signal:  this.controller.signal,
          headers: this._reqHeaders(),
          onProgress: (bytes) => this._onProgress(bytes),
        })
      )
    );

    if (this.status !== 'downloading') {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    this.emit('merging', { id: this.id });
    await this._mergeChunks(chunkList);
    await this._cleanup(true);
  }

  async _mergeChunks(chunkList) {
    // Refuse to merge anything short — a truncated part means a corrupt file
    for (const chunk of chunkList) {
      const expected = chunk.end - chunk.start + 1;
      let size = -1;
      try { size = (await fs.stat(chunk.tmpPath)).size; } catch (_) {}
      if (size !== expected) {
        throw new Error(`Part ${chunk.index} is ${size} bytes, expected ${expected}`);
      }
    }

    const tmpMerge = path.join(this.savePath, `.zest-${this.id || 'anon'}.merging`);
    const writer   = fs.createWriteStream(tmpMerge);

    try {
      for (const chunk of [...chunkList].sort((a, b) => a.index - b.index)) {
        await new Promise((resolve, reject) => {
          const reader = fs.createReadStream(chunk.tmpPath);
          reader.on('error', reject);
          writer.on('error', reject);
          reader.on('end', resolve);
          reader.pipe(writer, { end: false });
        });
      }
      await new Promise((resolve, reject) => {
        writer.on('error', reject);
        writer.on('finish', resolve);
        writer.end();
      });
    } catch (err) {
      writer.destroy();
      await fs.remove(tmpMerge).catch(() => {});
      throw err;
    }

    await this._finalize(tmpMerge);
  }

  // ── Single-stream download (no range support) ─

  /**
   * Move a finished temp file into place.
   *
   * Two jobs downloading the same filename both resolve to the same target,
   * because uniquePath() only sees what is on disk at the time it runs. By
   * the time the second one finishes, the first has taken the name — so
   * re-resolve instead of overwriting someone else's file.
   */
  async _finalize(tmpPath) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      // Claim the name with an exclusive create. "wx" either creates the
      // file or fails — there is no window between checking and taking it,
      // which a pathExists() test followed by a rename would leave open.
      let fd;
      try {
        fd = await fs.open(this.finalPath, 'wx');
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        this.finalPath = await uniquePath(this.savePath, path.basename(this.finalPath));
        this.filename  = path.basename(this.finalPath);
        continue;
      }

      // The placeholder is ours, so overwriting it is safe
      await fs.close(fd);
      await fs.move(tmpPath, this.finalPath, { overwrite: true });
      return;
    }
    throw new Error(`Could not find a free filename for ${this.filename}`);
  }

  async _singleDownload() {
    // Keyed on the job id, not the filename: two downloads of the same name
    // must never share a temp file, or the first to finish moves it away and
    // the second fails with ENOENT.
    this.partFile = path.join(this.savePath, `.zest-${this.id || 'anon'}.part`);

    let have = 0;
    try { have = (await fs.stat(this.partFile)).size; } catch (_) { have = 0; }

    const headers = { ...this._reqHeaders(), 'Accept-Encoding': 'identity' };
    if (have > 0) headers.Range = `bytes=${have}-`;

    const response = await axios({
      method:         'get',
      url:            this.url,
      responseType:   'stream',
      headers,
      signal:         this.controller.signal,
      maxRedirects:   5,
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      response.data.destroy();
      throw new Error(`Server responded ${response.status}`);
    }

    // Asked to continue but got the whole body back — start over cleanly
    let append = have > 0 && response.status === 206;
    if (have > 0 && response.status === 200) { have = 0; append = false; }

    this.downloadedBytes = have;
    if (!this.totalBytes) {
      const len = parseInt(response.headers['content-length'] || '0', 10) || 0;
      if (len) this.totalBytes = len + have;
    }
    this._emitProgress();

    const writer = fs.createWriteStream(this.partFile, { flags: append ? 'a' : 'w' });

    await new Promise((resolve, reject) => {
      response.data.on('data', (buf) => this._onProgress(buf.length));
      response.data.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
      response.data.pipe(writer);
    });

    if (this.status !== 'downloading') {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }

    await this._finalize(this.partFile);
    this.partFile = null;
    if (!this.totalBytes) this.totalBytes = this.downloadedBytes;
  }

  // ── Progress tracking ────────────────────────

  _onProgress(bytes) {
    this.downloadedBytes += bytes;
    const now = Date.now();
    this._samples.push({ t: now, bytes });
    while (this._samples.length && now - this._samples[0].t > SPEED_WINDOW_MS) {
      this._samples.shift();
    }
    this._emitProgress();
  }

  _emitProgress() {
    const now  = Date.now();
    const span = this._samples.length ? Math.max(250, now - this._samples[0].t) : 0;
    const windowBytes = this._samples.reduce((s, x) => s + x.bytes, 0);
    const speed = span ? (windowBytes / span) * 1000 : 0;   // bytes/sec, recent

    const percent = this.totalBytes
      ? ((this.downloadedBytes / this.totalBytes) * 100).toFixed(1)
      : null;
    const eta = this.totalBytes && speed > 0
      ? Math.ceil((this.totalBytes - this.downloadedBytes) / speed)
      : null;

    this.emit('progress', {
      id:              this.id,
      downloadedBytes: this.downloadedBytes,
      totalBytes:      this.totalBytes,
      percent,
      speed:           `${formatBytes(speed)}/s`,
      speedRaw:        speed,
      eta,              // seconds remaining
    });
  }

  // ── Cleanup ──────────────────────────────────

  /** @param {boolean} force - also drop resumable data (cancel / success) */
  async _cleanup(force = false) {
    if (!force) return;
    if (this.tmpDir)   { await fs.remove(this.tmpDir).catch(() => {});   this.tmpDir = null; }
    if (this.partFile) { await fs.remove(this.partFile).catch(() => {}); this.partFile = null; }
  }
}

// ─────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────
module.exports = {
  Downloader,
  formatBytes,
  sanitizeFilename,
  resolveFilename,
  uniquePath,
  isHtmlResponse,
};

/* ═══════════════════════════════════════════════
   Zest Downloader — src/torrent.js
   WebTorrent integration.
   NOTE: webtorrent is ESM-only so we load it
   via dynamic import() inside an async init.
═══════════════════════════════════════════════ */

'use strict';

const path             = require('path');
const fs               = require('fs-extra');
const { EventEmitter } = require('events');
const { formatBytes }  = require('./downloader');
const { config }       = require('./config');

// ─────────────────────────────────────────────
//  Constants — user-tunable ones come from config
// ─────────────────────────────────────────────
const MAX_CONNS     = config.maxPeers;
const DHT_ENABLED   = config.dht;
const DHT_PORT      = config.torrentPort;
const ANNOUNCE_LIST = config.trackers;
const SEED_AFTER_DL = config.seedAfterDl;

// ─────────────────────────────────────────────
//  Singleton WebTorrent client  (ESM — lazy)
// ─────────────────────────────────────────────
let _client     = null;
let _clientReady = null;   // Promise — resolved once client is created

async function getClient() {
  if (_client) return _client;

  // Only create the promise once even if called concurrently
  if (!_clientReady) {
    _clientReady = (async () => {
      // Dynamic import — the only way to use ESM from CommonJS
      const { default: WebTorrent } = await import('webtorrent');

      _client = new WebTorrent({
        maxConns: MAX_CONNS,
        dht:      DHT_ENABLED ? { port: DHT_PORT } : false,
      });

      _client.on('error', (err) => {
        console.error('[TorrentEngine] Client error:', err.message);
      });

      console.log('[TorrentEngine] WebTorrent client started');
      return _client;
    })();
  }

  return _clientReady;
}

/** Destroy the global client (call on app quit) */
function destroyClient() {
  return new Promise((resolve) => {
    if (_client) {
      _client.destroy(() => {
        _client      = null;
        _clientReady = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// ─────────────────────────────────────────────
//  TorrentDownload class
// ─────────────────────────────────────────────

class TorrentDownload extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}   opts.source     - magnet URI or path to .torrent file
   * @param {string}   opts.savePath   - directory to save files
   * @param {string}   [opts.id]       - queue job ID
   * @param {number[]} [opts.select]   - file indices to download (all if omitted)
   */
  constructor({ source, savePath, id = null, select = null }) {
    super();
    this.source   = source;
    this.savePath = savePath;
    this.id       = id;
    this.select   = select;

    this.torrent         = null;
    this.status          = 'idle';
    this.startTime       = null;
    this._progressTimer  = null;
  }

  // ── Public API ──────────────────────────────

  async start() {
    if (this.status === 'downloading' || this.status === 'seeding') return;

    await fs.ensureDir(this.savePath);
    this.status    = 'downloading';
    this.startTime = Date.now();

    let client;
    try {
      client = await getClient();
    } catch (err) {
      this.status = 'error';
      this.emit('error', err);
      return;
    }

    const opts = {
      path:     this.savePath,
      announce: ANNOUNCE_LIST,
    };

    try {
      this.torrent = await new Promise((resolve, reject) => {
        const t = client.add(this.source, opts, (torrent) => resolve(torrent));
        t.on('error', reject);
      });
    } catch (err) {
      this.status = 'error';
      this.emit('error', err);
      return;
    }

    this.emit('meta', {
      id:         this.id,
      name:       this.torrent.name,
      totalBytes: this.torrent.length,
      files:      this._fileList(),
      infoHash:   this.torrent.infoHash,
      magnetURI:  this.torrent.magnetURI,
    });

    if (this.select && this.select.length > 0) {
      this._applySelectiveDownload(this.select);
    }

    this._attachEvents();
    this._startProgressTimer();
  }

  pause() {
    if (!this.torrent || this.status === 'paused') return;
    this.torrent.pause();
    this.status = 'paused';
    this._stopProgressTimer();
    this.emit('paused', { id: this.id });
  }

  resume() {
    if (!this.torrent || this.status !== 'paused') return;
    this.torrent.resume();
    this.status = 'downloading';
    this._startProgressTimer();
    this.emit('resumed', { id: this.id });
  }

  async remove(deleteFiles = false) {
    this._stopProgressTimer();
    this.status = 'cancelled';

    await new Promise((resolve) => {
      if (this.torrent && _client) {
        _client.remove(this.torrent, { destroyStore: deleteFiles }, resolve);
        this.torrent = null;
      } else {
        resolve();
      }
    });

    this.emit('cancelled', { id: this.id });
  }

  selectFiles(indices) {
    this.select = indices;
    if (this.torrent) this._applySelectiveDownload(indices);
  }

  setDownloadLimit(bytesPerSec) {
    if (this.torrent) this.torrent.downloadLimit = bytesPerSec;
  }

  setUploadLimit(bytesPerSec) {
    if (this.torrent) this.torrent.uploadLimit = bytesPerSec;
  }

  getStats() {
    if (!this.torrent) return null;
    const t = this.torrent;
    return {
      id:              this.id,
      name:            t.name,
      status:          this.status,
      progress:        (t.progress * 100).toFixed(2),
      downloadedBytes: t.downloaded,
      uploadedBytes:   t.uploaded,
      totalBytes:      t.length,
      downloadSpeed:   formatBytes(t.downloadSpeed) + '/s',
      uploadSpeed:     formatBytes(t.uploadSpeed) + '/s',
      peers:           t.numPeers,
      ratio:           t.ratio.toFixed(3),
      eta:             t.timeRemaining ? Math.ceil(t.timeRemaining / 1000) : null,
      files:           this._fileList(),
    };
  }

  // ── Private ──────────────────────────────────

  _attachEvents() {
    const t = this.torrent;

    t.on('done', () => {
      this._stopProgressTimer();
      const info = {
        id:         this.id,
        name:       t.name,
        path:       path.join(this.savePath, t.name),
        totalBytes: t.length,
        files:      this._fileList(),
      };

      this.status = SEED_AFTER_DL ? 'seeding' : 'done';
      this.emit('progress', { ...this.getStats(), progress: '100.00', eta: 0 });
      this.emit('done', info);

      // Seeding keeps uploading to other peers. When it is switched off,
      // detach from the swarm but leave the downloaded files in place.
      if (!SEED_AFTER_DL && _client && this.torrent) {
        try {
          _client.remove(this.torrent, { destroyStore: false }, () => {});
        } catch (_) {}
        this.torrent = null;
      }
    });

    t.on('error',   (err)  => { this._stopProgressTimer(); this.status = 'error'; this.emit('error', err); });
    t.on('warning', (warn) => this.emit('warning', warn));
    t.on('wire',    (_w, addr) => this.emit('peer', { id: this.id, addr, peers: t.numPeers }));
  }

  _startProgressTimer() {
    this._stopProgressTimer();
    this._progressTimer = setInterval(() => {
      if (!this.torrent) return;
      this.emit('progress', this.getStats());
    }, 1000);
  }

  _stopProgressTimer() {
    if (this._progressTimer) { clearInterval(this._progressTimer); this._progressTimer = null; }
  }

  _applySelectiveDownload(indices) {
    this.torrent.files.forEach((file, i) => {
      indices.includes(i) ? file.select() : file.deselect();
    });
  }

  _fileList() {
    if (!this.torrent) return [];
    return this.torrent.files.map((f, i) => ({
      index:    i,
      name:     f.name,
      path:     f.path,
      length:   f.length,
      progress: (f.progress * 100).toFixed(1),
      done:     f.done,
    }));
  }
}

// ─────────────────────────────────────────────
//  TorrentEngine — manages all active torrents
// ─────────────────────────────────────────────

class TorrentEngine {
  constructor() {
    /** @type {Map<string, TorrentDownload>} */
    this.active = new Map();
  }

  add(opts) {
    const dl = new TorrentDownload(opts);
    this.active.set(opts.id ?? opts.source, dl);
    dl.start();
    return dl;
  }

  get(id)              { return this.active.get(id) ?? null; }
  pause(id)            { this.active.get(id)?.pause(); }
  resume(id)           { this.active.get(id)?.resume(); }

  async remove(id, deleteFiles = false) {
    const dl = this.active.get(id);
    if (dl) { await dl.remove(deleteFiles); this.active.delete(id); }
  }

  allStats() {
    return Array.from(this.active.values()).map((dl) => dl.getStats());
  }

  async destroy() {
    for (const dl of this.active.values()) await dl.remove(false);
    this.active.clear();
    await destroyClient();
    console.log('[TorrentEngine] Shutdown complete');
  }
}

// ─────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────
const torrentEngine = new TorrentEngine();

module.exports = { torrentEngine, TorrentEngine, TorrentDownload, destroyClient };
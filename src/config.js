/* ═══════════════════════════════════════════════
   Zest Downloader — src/config.js
   Centralised settings manager.
   Persists to JSON in the Electron userData folder.

   Every key here is read by real code. Settings for
   features that do not exist yet do not belong in
   this file — they read as promises the app cannot keep.
═══════════════════════════════════════════════ */

'use strict';

const path = require('path');
const fs   = require('fs-extra');

// ─────────────────────────────────────────────
//  Resolve config file path
//  Works whether called from main or a script
// ─────────────────────────────────────────────

function getConfigPath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'zest-config.json');
  } catch (_) {
    // Outside Electron (tests / CLI)
    return path.join(require('os').homedir(), '.zest', 'config.json');
  }
}

function getDefaultDownloadDir() {
  try {
    const { app } = require('electron');
    return app.getPath('downloads');
  } catch (_) {
    return path.join(require('os').homedir(), 'Downloads');
  }
}

// ─────────────────────────────────────────────
//  Default config
// ─────────────────────────────────────────────

function defaults() {
  return {
    // ── General ──────────────────────────────
    defaultDownloadDir: getDefaultDownloadDir(),

    // ── HTTP engine ──────────────────────────
    maxChunksPerFile:   8,                 // parallel segments per download
    maxConcurrentDl:    4,                 // simultaneous transfers
    retryLimit:         3,                 // auto-retries on chunk failure
    retryDelayMs:       2000,
    minChunkSizeBytes:  2 * 1024 * 1024,   // 2 MB — don't split below this

    // ── Torrent ──────────────────────────────
    seedAfterDownload:  true,              // keep seeding once complete
    maxPeersPerTorrent: 55,
    dhtEnabled:         true,
    torrentPort:        20000,
    trackers: [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://tracker.openbittorrent.com:6969/announce',
      'udp://open.stealth.si:80/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://exodus.desync.com:6969/announce',
    ],

    // ── Browser extension bridge ─────────────
    bridgePort:         6543,
  };
}

// ─────────────────────────────────────────────
//  Validation rules — a bad value is ignored,
//  never written, never crashes the app
// ─────────────────────────────────────────────

const RULES = {
  defaultDownloadDir: (v) => typeof v === 'string' && v.length > 0,
  maxChunksPerFile:   (v) => Number.isInteger(v) && v >= 1 && v <= 64,
  maxConcurrentDl:    (v) => Number.isInteger(v) && v >= 1 && v <= 20,
  retryLimit:         (v) => Number.isInteger(v) && v >= 0 && v <= 10,
  retryDelayMs:       (v) => Number.isInteger(v) && v >= 0 && v <= 60000,
  minChunkSizeBytes:  (v) => Number.isInteger(v) && v >= 64 * 1024,
  seedAfterDownload:  (v) => typeof v === 'boolean',
  maxPeersPerTorrent: (v) => Number.isInteger(v) && v >= 1 && v <= 500,
  dhtEnabled:         (v) => typeof v === 'boolean',
  torrentPort:        (v) => Number.isInteger(v) && v >= 1024 && v <= 65535,
  trackers:           (v) => Array.isArray(v) && v.every(t => typeof t === 'string'),
  bridgePort:         (v) => Number.isInteger(v) && v >= 1024 && v <= 65535,
};

// ─────────────────────────────────────────────
//  Config class
// ─────────────────────────────────────────────

class Config {
  constructor() {
    this._path = getConfigPath();
    this._data = null;   // lazy-loaded
  }

  // ── Lifecycle ─────────────────────────────

  /** Load config from disk, filling gaps with defaults */
  load() {
    const base = defaults();
    try {
      const raw   = fs.existsSync(this._path) ? fs.readFileSync(this._path, 'utf8').trim() : '';
      const saved = raw ? JSON.parse(raw) : {};
      // Saved values win, but only when they pass validation
      this._data = { ...base };
      for (const [key, value] of Object.entries(saved)) {
        if (!(key in base)) continue;                       // drop retired keys
        if (RULES[key] && !RULES[key](value)) {
          console.warn(`[Config] Ignoring invalid "${key}":`, value);
          continue;
        }
        this._data[key] = value;
      }
    } catch (e) {
      console.warn('[Config] Load failed, using defaults:', e.message);
      this._data = base;
    }
    return this;
  }

  /** Persist current config to disk */
  save() {
    this._ensureLoaded();
    try {
      fs.outputFileSync(this._path, JSON.stringify(this._data, null, 2), 'utf8');
    } catch (e) {
      console.error('[Config] Save failed:', e.message);
    }
    return this;
  }

  /** Reset all settings to defaults and save */
  reset() {
    this._data = defaults();
    this.save();
    return this;
  }

  // ── Get / Set ─────────────────────────────

  /**
   * Get a single setting value.
   * @param {string} key
   * @param {*}      [fallback]   returned if key is missing
   */
  get(key, fallback = undefined) {
    this._ensureLoaded();
    return key in this._data ? this._data[key] : fallback;
  }

  /**
   * Set a single setting and auto-save.
   * An invalid value is rejected rather than stored.
   * @returns {boolean} whether the value was accepted
   */
  set(key, value) {
    this._ensureLoaded();
    if (!this._validate(key, value)) return false;
    this._data[key] = value;
    this.save();
    return true;
  }

  /**
   * Merge multiple settings at once and save.
   * Invalid entries are skipped; the valid ones still apply.
   * @param {object} patch
   * @returns {string[]} keys that were rejected
   */
  update(patch = {}) {
    this._ensureLoaded();
    const rejected = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!this._validate(key, value)) { rejected.push(key); continue; }
      this._data[key] = value;
    }
    this.save();
    return rejected;
  }

  /**
   * Return a plain object snapshot of all settings.
   * Safe to JSON-stringify and send to the renderer.
   */
  all() {
    this._ensureLoaded();
    return { ...this._data };
  }

  // ── Shorthand getters (most-used values) ──

  get downloadDir()   { return this.get('defaultDownloadDir'); }
  get maxChunks()     { return this.get('maxChunksPerFile'); }
  get maxConcurrent() { return this.get('maxConcurrentDl'); }
  get retryLimit()    { return this.get('retryLimit'); }
  get retryDelayMs()  { return this.get('retryDelayMs'); }
  get minChunkSize()  { return this.get('minChunkSizeBytes'); }
  get seedAfterDl()   { return this.get('seedAfterDownload'); }
  get maxPeers()      { return this.get('maxPeersPerTorrent'); }
  get dht()           { return this.get('dhtEnabled'); }
  get torrentPort()   { return this.get('torrentPort'); }
  get trackers()      { return this.get('trackers'); }
  get bridgePort()    { return this.get('bridgePort'); }

  // ── Private ───────────────────────────────

  _ensureLoaded() {
    if (!this._data) this.load();
  }

  _validate(key, value) {
    if (!(key in defaults())) {
      console.warn(`[Config] Unknown setting "${key}" — ignored.`);
      return false;
    }
    if (RULES[key] && !RULES[key](value)) {
      console.warn(`[Config] Invalid value for "${key}":`, value, '— keeping previous.');
      return false;
    }
    return true;
  }
}

// ─────────────────────────────────────────────
//  Singleton
// ─────────────────────────────────────────────
const config = new Config();

module.exports = { config, Config, defaults };

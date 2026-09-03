/* ═══════════════════════════════════════════════
   Zest Downloader — src/queue.js
   SQLite queue manager using sql.js (pure JS,
   no native compilation needed).
═══════════════════════════════════════════════ */

'use strict';

const path    = require('path');
const fs      = require('fs-extra');

// ─────────────────────────────────────────────
//  DB path
// ─────────────────────────────────────────────
function getDbPath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'zest-queue.db');
  } catch (_) {
    return path.join(require('os').homedir(), '.zest', 'zest-queue.db');
  }
}

// ─────────────────────────────────────────────
//  Job status constants
// ─────────────────────────────────────────────
const STATUS = {
  QUEUED:      'queued',
  DOWNLOADING: 'downloading',
  PAUSED:      'paused',
  DONE:        'done',
  ERROR:       'error',
  CANCELLED:   'cancelled',
};

// ─────────────────────────────────────────────
//  Schema
// ─────────────────────────────────────────────
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT    PRIMARY KEY,
    url           TEXT    NOT NULL,
    save_path     TEXT    NOT NULL,
    filename      TEXT,
    type          TEXT    NOT NULL DEFAULT 'http',
    referrer      TEXT    DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'queued',
    total_bytes   INTEGER DEFAULT 0,
    downloaded    INTEGER DEFAULT 0,
    speed         TEXT    DEFAULT '0 B/s',
    eta           INTEGER DEFAULT 0,
    error_msg     TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    completed_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
`;

// ─────────────────────────────────────────────
//  DownloadQueue class
// ─────────────────────────────────────────────
class DownloadQueue {
  constructor() {
    this.db      = null;   // sql.js Database instance
    this.SQL     = null;   // sql.js module
    this.dbPath  = null;
    this._saveTimer = null;
  }

  // ── Lifecycle ─────────────────────────────

  async init() {
    this.dbPath = getDbPath();
    await fs.ensureDir(path.dirname(this.dbPath));

    // Dynamic import — sql.js is ESM in newer versions
    try {
      const sqljs = await import('sql.js');
      this.SQL    = await (sqljs.default || sqljs)();
    } catch (_) {
      // Fallback for CommonJS version
      const initSqlJs = require('sql.js');
      this.SQL = await initSqlJs();
    }

    // Load existing DB from disk or create fresh
    if (await fs.pathExists(this.dbPath)) {
      const fileBuffer = await fs.readFile(this.dbPath);
      this.db = new this.SQL.Database(fileBuffer);
    } else {
      this.db = new this.SQL.Database();
    }

    // Apply schema, then bring older databases up to date
    this.db.run(SCHEMA);
    this._migrate();
    this._reconcile();
    this._persist();   // save initial state

    console.log('[Queue] sql.js DB ready at', this.dbPath);
    return this;
  }

  /** Add columns introduced after the first release */
  _migrate() {
    let existing = [];
    try {
      existing = this._all('PRAGMA table_info(jobs)').map(r => r.name);
    } catch (_) { return; }

    const columns = { referrer: "TEXT DEFAULT ''" };
    for (const [name, decl] of Object.entries(columns)) {
      if (existing.includes(name)) continue;
      try {
        this.db.run(`ALTER TABLE jobs ADD COLUMN ${name} ${decl}`);
        console.log(`[Queue] Migrated: added column "${name}"`);
      } catch (e) {
        console.warn(`[Queue] Migration for "${name}" failed:`, e.message);
      }
    }
  }

  /**
   * Nothing survives a crash mid-transfer, so any job still marked
   * "downloading" belongs to a process that is gone. Park it as paused
   * so the UI shows a working Resume button instead of a dead progress bar.
   */
  _reconcile() {
    try {
      this.db.run(
        "UPDATE jobs SET status = 'paused', speed = '0 B/s', eta = 0, updated_at = :now " +
        "WHERE status IN ('downloading', 'queued')",
        { ':now': Date.now() }
      );
    } catch (e) {
      console.warn('[Queue] Reconcile failed:', e.message);
    }
  }

  close() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this._persist();
    this.db?.close();
  }

  // ── Persist to disk (debounced) ───────────

  _persist() {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.outputFileSync(this.dbPath, Buffer.from(data));
    } catch (e) {
      console.error('[Queue] Persist error:', e.message);
    }
  }

  /**
   * sql.js has no incremental writer — every save re-exports the whole
   * database. Debouncing keeps that off the hot path; `lazy` is for progress
   * ticks, which fire many times a second and are cheap to lose on a crash.
   */
  _schedulePersist(lazy = false) {
    const delay = lazy ? 2500 : 300;
    if (this._saveTimer) {
      // A pending urgent save must not be pushed back by progress noise
      if (lazy && !this._saveIsLazy) return;
      clearTimeout(this._saveTimer);
    }
    this._saveIsLazy = lazy;
    this._saveTimer  = setTimeout(() => {
      this._saveTimer = null;
      this._persist();
    }, delay);
  }

  // ── Helpers ───────────────────────────────

  _run(sql, params = {}, lazy = false) {
    this.db.run(sql, params);
    this._schedulePersist(lazy);
  }

  _get(sql, params = {}) {
    const stmt   = this.db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  }

  _all(sql, params = {}) {
    const stmt    = this.db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  }

  // ── CRUD ─────────────────────────────────

  add({ url, savePath, filename = null, type = 'http', referrer = '' }) {
    const id  = `zest_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    this._run(
      `INSERT INTO jobs (id, url, save_path, filename, type, referrer, status, created_at, updated_at)
       VALUES (:id, :url, :savePath, :filename, :type, :referrer, :status, :now, :now)`,
      { ':id': id, ':url': url, ':savePath': savePath, ':filename': filename,
        ':type': type, ':referrer': referrer || '', ':status': STATUS.QUEUED, ':now': now }
    );
    console.log(`[Queue] Added job ${id}`);
    return id;
  }

  get(id) {
    return this._get('SELECT * FROM jobs WHERE id = :id', { ':id': id });
  }

  getAll(status = null) {
    if (status) {
      return this._all(
        'SELECT * FROM jobs WHERE status = :status ORDER BY created_at DESC',
        { ':status': status }
      );
    }
    return this._all('SELECT * FROM jobs ORDER BY created_at DESC');
  }

  // ── Status updates ────────────────────────

  setDownloading(id) { this._updateStatus(id, STATUS.DOWNLOADING); }
  setPaused(id)      { this._updateStatus(id, STATUS.PAUSED); }
  setCancelled(id)   { this._updateStatus(id, STATUS.CANCELLED); }

  setError(id, errorMsg = '') {
    this._run(
      'UPDATE jobs SET status = :s, error_msg = :e, updated_at = :now WHERE id = :id',
      { ':s': STATUS.ERROR, ':e': errorMsg, ':now': Date.now(), ':id': id }
    );
  }

  /**
   * @param {number|null} [totalBytes] - final size, when the engine knows it
   *
   * The size must never be zeroed here. Servers that send no Content-Length
   * leave total_bytes at 0, and the old `downloaded = total_bytes` wiped the
   * byte count that had been counted during the transfer — so a finished
   * download displayed no size at all.
   */
  setDone(id, filename = null, totalBytes = null) {
    const now = Date.now();
    this._run(
      `UPDATE jobs
       SET status = :s,
           filename    = COALESCE(:fn, filename),
           total_bytes = CASE
                           WHEN :tb > 0        THEN :tb
                           WHEN total_bytes > 0 THEN total_bytes
                           ELSE downloaded
                         END,
           downloaded  = CASE
                           WHEN :tb > 0        THEN :tb
                           WHEN total_bytes > 0 THEN total_bytes
                           ELSE downloaded
                         END,
           speed = '0 B/s', eta = 0,
           updated_at = :now, completed_at = :now
       WHERE id = :id`,
      { ':s': STATUS.DONE, ':fn': filename, ':tb': totalBytes ?? 0, ':now': now, ':id': id }
    );
  }

  updateProgress(id, { downloaded, totalBytes, speed, eta, filename = null }) {
    this._run(
      `UPDATE jobs
       SET downloaded = :dl, total_bytes = :tb, speed = :sp, eta = :eta,
           filename = COALESCE(:fn, filename), updated_at = :now
       WHERE id = :id`,
      { ':dl': downloaded, ':tb': totalBytes, ':sp': speed,
        ':eta': eta ?? 0, ':fn': filename, ':now': Date.now(), ':id': id },
      true   // lazy — progress ticks must not thrash the disk
    );
  }

  // ── Scheduler support ─────────────────────

  setQueued(id) { this._updateStatus(id, STATUS.QUEUED); }

  /** How many jobs the engine is currently working on */
  countActive() {
    const row = this._get(
      "SELECT COUNT(*) AS n FROM jobs WHERE status = 'downloading'"
    );
    return row ? row.n : 0;
  }

  /** Oldest waiting job, or null when the queue is drained */
  getNextQueued() {
    return this._get(
      "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
    );
  }

  // ── Bulk ─────────────────────────────────

  retry(id) {
    this._run(
      "UPDATE jobs SET status = 'queued', error_msg = NULL, downloaded = 0, updated_at = :now WHERE id = :id",
      { ':now': Date.now(), ':id': id }
    );
  }

  remove(id) {
    this._run('DELETE FROM jobs WHERE id = :id', { ':id': id });
  }

  clearFinished() {
    this._run("DELETE FROM jobs WHERE status IN ('done', 'cancelled', 'error')");
  }

  stats() {
    const rows = this._all('SELECT status, COUNT(*) as count FROM jobs GROUP BY status');
    return Object.fromEntries(rows.map(r => [r.status, r.count]));
  }

  // ── Private ───────────────────────────────

  _updateStatus(id, status) {
    this._run(
      'UPDATE jobs SET status = :s, updated_at = :now WHERE id = :id',
      { ':s': status, ':now': Date.now(), ':id': id }
    );
  }
}

// ─────────────────────────────────────────────
//  Singleton
// ─────────────────────────────────────────────
const queue = new DownloadQueue();

module.exports = { queue, DownloadQueue, STATUS };
/* ═══════════════════════════════════════════════
   Zest Downloader — test/queue.test.js

   Covers the parts of the queue that only matter
   when something goes wrong: schema migration from
   an older database, and recovery after a crash.

   Run with:  node test/queue.test.js
═══════════════════════════════════════════════ */

'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs-extra');

const { DownloadQueue, STATUS } = require('../src/queue');

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else      { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

/**
 * A queue pinned to a throwaway db file.
 * init() resolves its own path from Electron/HOME, so the instance is wired
 * up by hand here instead — the tests must never touch the real database.
 */
async function makeQueue(dbPath) {
  await fs.ensureDir(path.dirname(dbPath));
  const q = new DownloadQueue();
  q.dbPath = dbPath;
  const sqljs = await import('sql.js');
  q.SQL = await (sqljs.default || sqljs)();
  q.db  = (await fs.pathExists(dbPath))
    ? new q.SQL.Database(await fs.readFile(dbPath))
    : new q.SQL.Database();
  return q;
}

async function main() {
  const dir    = await fs.mkdtemp(path.join(os.tmpdir(), 'zest-q-'));
  const dbPath = path.join(dir, 'q.db');

  try {
    console.log('\nbasic CRUD');
    const q = await makeQueue(dbPath);
    q.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, save_path TEXT NOT NULL,
        filename TEXT, type TEXT NOT NULL DEFAULT 'http', referrer TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued', total_bytes INTEGER DEFAULT 0,
        downloaded INTEGER DEFAULT 0, speed TEXT DEFAULT '0 B/s', eta INTEGER DEFAULT 0,
        error_msg TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );`);

    const id = q.add({ url: 'https://example.com/a.zip', savePath: dir, referrer: 'https://ref' });
    const job = q.get(id);
    eq('stores the url',      job.url, 'https://example.com/a.zip');
    eq('stores the referrer', job.referrer, 'https://ref');
    eq('starts queued',       job.status, STATUS.QUEUED);

    console.log('\nscheduler helpers');
    eq('nothing active yet', q.countActive(), 0);
    eq('next queued is our job', q.getNextQueued().id, id);
    q.setDownloading(id);
    eq('now counted as active', q.countActive(), 1);
    ok('queue is drained', q.getNextQueued() === null);
    q.setQueued(id);
    eq('back to waiting', q.countActive(), 0);

    console.log('\nmigration from a pre-referrer database');
    {
      const legacyPath = path.join(dir, 'legacy.db');
      const legacy = new DownloadQueue();
      legacy.dbPath = legacyPath;
      const sqljs = await import('sql.js');
      legacy.SQL = await (sqljs.default || sqljs)();
      legacy.db  = new legacy.SQL.Database();
      // Old schema: no referrer column
      legacy.db.run(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, url TEXT NOT NULL, save_path TEXT NOT NULL,
          filename TEXT, type TEXT NOT NULL DEFAULT 'http',
          status TEXT NOT NULL DEFAULT 'queued', total_bytes INTEGER DEFAULT 0,
          downloaded INTEGER DEFAULT 0, speed TEXT DEFAULT '0 B/s', eta INTEGER DEFAULT 0,
          error_msg TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          completed_at INTEGER
        );`);
      legacy.db.run(
        "INSERT INTO jobs (id,url,save_path,status,created_at,updated_at) " +
        "VALUES ('old1','https://x/y.zip','C:/tmp','downloading',1,1)"
      );

      const before = legacy._all('PRAGMA table_info(jobs)').map(r => r.name);
      ok('legacy db really lacks referrer', !before.includes('referrer'));

      legacy._migrate();
      const after = legacy._all('PRAGMA table_info(jobs)').map(r => r.name);
      ok('migration adds the referrer column', after.includes('referrer'));
      ok('existing row survived', legacy.get('old1') !== null);

      console.log('\ncrash recovery');
      eq('row was left mid-download', legacy.get('old1').status, 'downloading');
      legacy._reconcile();
      eq('reconcile parks it as paused', legacy.get('old1').status, STATUS.PAUSED);
      eq('stale speed is cleared', legacy.get('old1').speed, '0 B/s');

      legacy._migrate();   // must be safe to run twice
      ok('migration is idempotent', legacy.get('old1') !== null);
      legacy.db.close();
    }

    console.log('\nclearFinished');
    q.setDone(id, 'a.zip');
    eq('marked done', q.get(id).status, STATUS.DONE);
    q.clearFinished();
    ok('finished job removed', q.get(id) === null);

    q.db.close();
  } finally {
    await fs.remove(dir).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});

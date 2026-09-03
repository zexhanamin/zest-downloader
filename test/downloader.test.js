/* ═══════════════════════════════════════════════
   Zest Downloader — test/downloader.test.js

   Exercises the HTTP engine against a local server
   that can be told to behave badly: ignore Range,
   send hostile filenames, drop the connection.

   Run with:  node test/downloader.test.js
═══════════════════════════════════════════════ */

'use strict';

const http   = require('http');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const fs     = require('fs-extra');

const { Downloader, sanitizeFilename, uniquePath } = require('../src/downloader');

// ─────────────────────────────────────────────
//  Tiny assertion helpers
// ─────────────────────────────────────────────
let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else      { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ─────────────────────────────────────────────
//  Fixture: 6 MB of deterministic bytes
//  (big enough to be split into chunks)
// ─────────────────────────────────────────────
const BODY = crypto.randomBytes(6 * 1024 * 1024);
const BODY_SHA = crypto.createHash('sha256').update(BODY).digest('hex');

/**
 * Test server.
 *   /good              — honours Range
 *   /norange           — advertises ranges, then ignores them (the corruption trap)
 *   /nohead            — HEAD fails, GET works, no ranges
 *   /evil-name         — Content-Disposition tries to escape the directory
 *   /flaky             — kills the first request per range, then behaves
 *   /slow              — honours Range but trickles, so pause can catch it
 */
function makeServer() {
  const seenRanges = new Set();

  const server = http.createServer((req, res) => {
    const url   = new URL(req.url, 'http://127.0.0.1');
    // Match on the first path segment: requests look like /good/file.bin,
    // so comparing the whole pathname would never hit any route.
    const route = `/${url.pathname.split('/').filter(Boolean)[0] || ''}`;
    const range = req.headers.range;

    if (route === '/nohead' && req.method === 'HEAD') {
      res.writeHead(405); res.end(); return;
    }

    // Reproduces the real failure: a portal that answers an unauthenticated
    // request with its sign-in page, under a .pdf filename.
    if (route === '/authed') {
      const signedIn = (req.headers.cookie || '').includes('session=good');
      if (!signedIn) {
        const page = Buffer.from('<!DOCTYPE html><html><head><title>Sign in</title></head></html>');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(page.length),
          'Content-Disposition': 'attachment; filename="transcript.pdf"',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        res.end(page);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(BODY.length),
        'Content-Disposition': 'attachment; filename="transcript.pdf"',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      res.end(BODY);
      return;
    }

    if (route === '/evil-name') {
      res.writeHead(200, {
        'Content-Length': String(BODY.length),
        'Content-Disposition': 'attachment; filename="../../../../pwned.exe"',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      res.end(BODY);
      return;
    }

    const supportsRange = route === '/good' || route === '/flaky' || route === '/slow';

    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': String(BODY.length),
        'Accept-Ranges': supportsRange || route === '/norange' ? 'bytes' : 'none',
      });
      res.end();
      return;
    }

    // The trap: claims ranges, always answers with the entire body
    if (route === '/norange') {
      res.writeHead(200, { 'Content-Length': String(BODY.length) });
      res.end(BODY);
      return;
    }

    if (route === '/flaky' && range && !seenRanges.has(range)) {
      seenRanges.add(range);
      res.socket.destroy();     // first attempt at each range dies mid-flight
      return;
    }

    if (supportsRange && range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = parseInt(m[1], 10);
      const end   = m[2] ? parseInt(m[2], 10) : BODY.length - 1;
      const slice = BODY.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Length': String(slice.length),
        'Content-Range':  `bytes ${start}-${end}/${BODY.length}`,
        'Accept-Ranges':  'bytes',
      });

      if (route !== '/slow') { res.end(slice); return; }

      // Trickle in 32 KB steps so a pause reliably lands mid-transfer
      let off = 0;
      const STEP = 32 * 1024;
      const tick = () => {
        if (res.writableEnded || res.destroyed) return;
        if (off >= slice.length) { res.end(); return; }
        res.write(slice.subarray(off, off + STEP));
        off += STEP;
        setTimeout(tick, 25);
      };
      tick();
      return;
    }

    res.writeHead(200, { 'Content-Length': String(BODY.length) });
    res.end(BODY);
  });

  return server;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function run(dl) {
  return new Promise((resolve, reject) => {
    dl.once('done', resolve);
    dl.once('error', reject);
    dl.start();
  });
}

// ─────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zest-test-'));
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('\nsanitizeFilename');
    eq('strips directory traversal', sanitizeFilename('../../../../pwned.exe'), 'pwned.exe');
    eq('strips backslash paths',     sanitizeFilename('..\\..\\evil.bat'), 'evil.bat');
    eq('strips leading dots',        sanitizeFilename('...hidden.zip'), 'hidden.zip');
    eq('replaces illegal chars',     sanitizeFilename('a:b*c?.zip'), 'a_b_c_.zip');
    ok('rejects reserved names',     !/^con$/i.test(sanitizeFilename('CON')));
    ok('empty name gets a fallback', sanitizeFilename('').length > 0);
    eq('keeps ordinary names',       sanitizeFilename('Ubuntu 24.04.iso'), 'Ubuntu 24.04.iso');

    console.log('\nchunked download (server honours Range)');
    {
      const dl = new Downloader({ url: `${base}/good/file.bin`, savePath: dir, id: 'good' });
      const info = await run(dl);
      eq('file content matches', sha256File(info.path), BODY_SHA);
      ok('scratch dir cleaned up', !fs.existsSync(path.join(dir, '.zest-good.parts')));
      eq('progress reached total', dl.downloadedBytes, BODY.length);
    }

    console.log('\nserver lies about Range support');
    {
      const dl = new Downloader({ url: `${base}/norange/file.bin`, savePath: dir, id: 'lie' });
      const info = await run(dl);
      // Without the 206 check this merges 8 whole copies into one file
      eq('falls back to a correct single stream', sha256File(info.path), BODY_SHA);
      eq('size is right, not a multiple', fs.statSync(info.path).size, BODY.length);
    }

    console.log('\nHEAD unsupported');
    {
      const dl = new Downloader({ url: `${base}/nohead/file.bin`, savePath: dir, id: 'nohead' });
      const info = await run(dl);
      eq('still downloads correctly', sha256File(info.path), BODY_SHA);
    }

    console.log('\nhostile Content-Disposition');
    {
      const dl = new Downloader({ url: `${base}/evil-name`, savePath: dir, id: 'evil' });
      const info = await run(dl);
      eq('written inside the download dir', path.dirname(path.resolve(info.path)), path.resolve(dir));
      eq('name is defanged', path.basename(info.path), 'pwned.exe');
      ok('nothing escaped upwards', !fs.existsSync(path.resolve(dir, '../../../../pwned.exe')));
    }

    console.log('\nsession-protected download');
    {
      // No cookie: the portal returns its login page named transcript.pdf
      const bare = new Downloader({ url: `${base}/authed`, savePath: dir, id: 'noauth' });
      let err = null;
      try { await run(bare); } catch (e) { err = e; }
      ok('refuses to save the login page', err !== null, 'it completed instead');
      ok('error explains the sign-in problem',
         !!err && /signed in|web page/i.test(err.message), err && err.message);
      ok('nothing was written to disk', !fs.existsSync(path.join(dir, 'transcript.pdf')));

      // With the browser's cookie forwarded, the real file comes through
      const authed = new Downloader({
        url: `${base}/authed`, savePath: dir, id: 'auth', cookie: 'session=good',
      });
      const info = await run(authed);
      eq('cookie unlocks the real file', sha256File(info.path), BODY_SHA);
      eq('saved under the right name', path.basename(info.path), 'transcript.pdf');
    }

    console.log('\nretry after a dropped connection');
    {
      const dl = new Downloader({ url: `${base}/flaky/file.bin`, savePath: dir, id: 'flaky' });
      const info = await run(dl);
      eq('recovers and matches', sha256File(info.path), BODY_SHA);
      eq('progress is not double counted', dl.downloadedBytes, BODY.length);
    }

    console.log('\npause then resume');
    {
      const dl = new Downloader({ url: `${base}/slow/resume.bin`, savePath: dir, id: 'res' });
      // A paused download emits 'paused', never 'done' — wait on that instead
      const paused = new Promise((resolve) => dl.once('paused', resolve));
      dl.start().catch(() => {});

      // Wait until real bytes have landed, then stop mid-transfer
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (dl.downloadedBytes > 200 * 1024) { clearInterval(check); resolve(); }
        }, 20);
      });
      const atPause = dl.downloadedBytes;
      dl.pause();
      await paused;
      await new Promise((r) => setTimeout(r, 150));   // let sockets unwind

      const scratch = path.join(dir, '.zest-res.parts');
      ok('paused before finishing', atPause > 0 && atPause < BODY.length);
      ok('partial data kept for resume', fs.existsSync(scratch));

      const onDisk = fs.readdirSync(scratch)
        .filter(f => f.startsWith('part_'))
        .reduce((sum, f) => sum + fs.statSync(path.join(scratch, f)).size, 0);
      ok('partial bytes survived on disk', onDisk > 0, `only ${onDisk} bytes`);

      // A second Downloader with the same job id must continue, not restart
      const dl2 = new Downloader({ url: `${base}/slow/resume.bin`, savePath: dir, id: 'res' });
      let firstProgress = null;
      dl2.once('progress', (p) => { firstProgress = p.downloadedBytes; });
      const info = await run(dl2);

      eq('resumed file matches', sha256File(info.path), BODY_SHA);
      eq('final byte count is exact', dl2.downloadedBytes, BODY.length);
      ok('resume started from the saved offset, not zero',
         firstProgress > 0, `first progress tick was ${firstProgress}`);
      ok('scratch cleaned after completion', !fs.existsSync(scratch));
    }

    console.log('\nsame filename downloaded twice at once');
    {
      // Both resolve to the same target name. Sharing a temp file made the
      // second one die with ENOENT once the first moved it into place.
      const a = new Downloader({ url: `${base}/good/dupe.bin`, savePath: dir, id: 'race-a' });
      const b = new Downloader({ url: `${base}/good/dupe.bin`, savePath: dir, id: 'race-b' });
      const [ia, ib] = await Promise.all([run(a), run(b)]);

      ok('both finished', !!ia.path && !!ib.path);
      ok('they did not collide on one name', ia.path !== ib.path, `both wrote ${ia.path}`);
      // Whichever finishes first takes the plain name — the order is a race,
      // so assert the pair rather than which job won it
      const names = [path.basename(ia.path), path.basename(ib.path)].sort();
      eq('one plain name and one renamed', names.join(' + '), 'dupe (1).bin + dupe.bin');
      eq('first file is intact',  sha256File(ia.path), BODY_SHA);
      eq('second file is intact', sha256File(ib.path), BODY_SHA);

      const leftovers = fs.readdirSync(dir).filter(f => f.startsWith('.zest-race'));
      eq('no temp files left behind', leftovers.length, 0);
    }

    console.log('\nfilename collision');
    {
      const p1 = await uniquePath(dir, 'dupe.txt');
      await fs.writeFile(p1, 'first');
      const p2 = await uniquePath(dir, 'dupe.txt');
      eq('second copy is renamed', path.basename(p2), 'dupe (1).txt');
    }
  } finally {
    server.close();
    await fs.remove(dir).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});

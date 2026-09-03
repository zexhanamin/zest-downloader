/* ═══════════════════════════════════════════════
   Zest Downloader — test/displayname.test.js

   The list label is derived, not stored, and the
   inputs are messy: Windows paths from the file
   picker, 200-character magnet URIs, URLs with
   query strings. Run with: node test/displayname.test.js
═══════════════════════════════════════════════ */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  if (actual === expected) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

/**
 * renderer.js is a browser script, not a module. Load it into a sandbox with
 * just enough of a DOM for the top-level statements, then reach in for the
 * helpers under test.
 */
function loadRenderer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const noop = () => {};
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      readyState: 'loading',
      addEventListener: noop,
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop }),
      body: { appendChild: noop },
      head: { appendChild: noop },
    },
    URL,
    decodeURIComponent,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'renderer.js' });

  // `function` declarations land on the sandbox global, but `const state`
  // is a lexical binding and has to be read back by evaluating its name.
  return {
    displayName:  sandbox.displayName,
    filterJobs:   sandbox.filterJobs,
    sizeLabel:    sandbox.sizeLabel,
    etaLabel:     sandbox.etaLabel,
    footerStats:  sandbox.footerStats,
    state:        vm.runInContext('state', sandbox),
  };
}

function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function main() {
  const { displayName, filterJobs, sizeLabel, etaLabel, footerStats, state } = loadRenderer();

  console.log('\nsize is always shown');
  eq('running transfer shows progress out of the total',
     sizeLabel({ status: 'downloading', downloaded: 1048576, total_bytes: 10485760 }),
     '1.0 MB / 10.0 MB');
  eq('finished transfer shows the final size',
     sizeLabel({ status: 'done', downloaded: 10485760, total_bytes: 10485760 }),
     '10.0 MB');
  eq('no Content-Length still reports what arrived',
     sizeLabel({ status: 'downloading', downloaded: 2097152, total_bytes: 0 }),
     '2.0 MB / unknown');
  eq('finished without a total falls back to the byte count',
     sizeLabel({ status: 'done', downloaded: 559104, total_bytes: 0 }),
     '546.0 KB');
  eq('nothing known yet still says something',
     sizeLabel({ status: 'queued', downloaded: 0, total_bytes: 0 }),
     'Size unknown');

  console.log('\ntime remaining');
  eq('counts down while running',
     etaLabel({ status: 'downloading', eta: 90, total_bytes: 100 }), '1m 30s left');
  eq('says so before the first estimate',
     etaLabel({ status: 'downloading', eta: 0, total_bytes: 100 }), 'Estimating…');
  eq('unknown when the size is unknown',
     etaLabel({ status: 'downloading', eta: 0, total_bytes: 0 }), 'Unknown time');
  eq('paused transfers do not show a stale estimate',
     etaLabel({ status: 'paused', eta: 90 }), 'Paused');

  console.log('\nfooter always carries speed and time');
  const running = footerStats({ status: 'downloading', speed: '3.2 MB/s', eta: 45, total_bytes: 100 });
  ok('shows the speed', running.includes('3.2 MB/s'), running);
  ok('shows the time left', running.includes('45s left'), running);
  const stalled = footerStats({ status: 'downloading', speed: '0 B/s', eta: 0, total_bytes: 100 });
  ok('a stalled transfer still shows both fields',
     stalled.includes('↓ —') && stalled.includes('Estimating'), stalled);
  ok('an error is escaped, not injected',
     !footerStats({ status: 'error', error_msg: '<img src=x onerror=alert(1)>' }).includes('<img'));

  console.log('\ndisplayName');

  eq('local .torrent path shows just the file',
     displayName({ url: 'C:\\Users\\state\\Downloads\\big-buck-bunny.torrent' }),
     'big-buck-bunny.torrent');
  eq('unix path shows just the file',
     displayName({ url: '/home/me/stuff/movie.mkv' }),
     'movie.mkv');
  eq('magnet uses its display name',
     displayName({ url: 'magnet:?xt=urn:btih:dd8255ec&dn=Big+Buck+Bunny' }),
     'Big Buck Bunny');
  eq('magnet without dn falls back to the hash',
     displayName({ url: 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81' }),
     'Torrent dd8255ecdc7c…');
  eq('query string is dropped',
     displayName({ url: 'https://x.com/a/movie.mp4?token=abc#frag' }),
     'movie.mp4');
  eq('resolved filename wins over the url',
     displayName({ url: 'https://portal.example.edu/cms/student/transcript', filename: 'transcript.pdf' }),
     'transcript.pdf');
  eq('percent-encoding is decoded',
     displayName({ url: 'https://x.com/My%20File%20Name.zip' }),
     'My File Name.zip');
  eq('a stored full path is reduced too',
     displayName({ filename: 'C:\\Downloads\\report.pdf', url: '' }),
     'report.pdf');
  eq('nothing usable still returns something',
     displayName({ url: '' }),
     'Unknown file');

  console.log('\nsidebar view filtering');
  const jobs = [
    { id: 'a', type: 'http',    status: 'downloading' },
    { id: 'b', type: 'torrent', status: 'downloading' },
    { id: 'c', type: 'http',    status: 'done' },
    { id: 'd', type: 'torrent', status: 'done' },
    { id: 'e', type: 'http',    status: 'paused' },
  ];

  state.activeView = 'torrents'; state.activeFilter = 'all';
  eq('Torrents shows only torrents',
     filterJobs(jobs).map(j => j.id).join(''), 'bd');

  state.activeView = 'downloads';
  eq('Downloads shows only http transfers',
     filterJobs(jobs).map(j => j.id).join(''), 'ace');

  state.activeView = 'completed';
  eq('Completed shows finished of both kinds',
     filterJobs(jobs).map(j => j.id).join(''), 'cd');

  console.log('\nview and status tabs combine');
  state.activeView = 'torrents'; state.activeFilter = 'done';
  eq('Torrents + Done', filterJobs(jobs).map(j => j.id).join(''), 'd');

  state.activeView = 'downloads'; state.activeFilter = 'paused';
  eq('Downloads + Paused', filterJobs(jobs).map(j => j.id).join(''), 'e');

  state.activeView = 'downloads'; state.activeFilter = 'downloading';
  eq('Downloads + Active excludes torrents',
     filterJobs(jobs).map(j => j.id).join(''), 'a');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();

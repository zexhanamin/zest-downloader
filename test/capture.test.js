/* ═══════════════════════════════════════════════
   Zest Downloader — test/capture.test.js

   The extension decides what counts as a download.
   Getting this wrong is expensive in both directions:
   too strict and real files slip past, too loose and
   every inline image on a restored tab is downloaded.

   Run with:  node test/capture.test.js
═══════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * background.js is an MV3 service worker. Load it into a sandbox with a
 * stubbed chrome API so the top-level listener registrations succeed, then
 * pull out the pure decision helpers.
 */
function loadBackground() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };
  const chrome = {
    runtime:      { ...listener, lastError: null, onMessage: listener, onInstalled: listener, onStartup: listener },
    downloads:    { onCreated: listener, cancel: noop, erase: noop, download: noop },
    webRequest:   { onHeadersReceived: listener },
    webNavigation:{ onBeforeNavigate: listener },
    contextMenus: { onClicked: listener, create: noop, removeAll: (cb) => cb && cb() },
    commands:     { onCommand: listener },
    alarms:       { onAlarm: listener, create: noop },
    action:       { setBadgeText: noop, setBadgeBackgroundColor: noop },
    notifications:{ create: noop },
    storage:      { local: { get: async () => ({}), set: async () => {} }, onChanged: listener },
    cookies:      { getAll: async () => [] },
    tabs:         { remove: noop },
  };
  const sandbox = {
    console, chrome, URL,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController,
    // A successful hand-off: a failed one is rolled back out of the
    // duplicate window, which would hide the behaviour under test.
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background.js' });

  return {
    isApiLikeUrl:     sandbox.isApiLikeUrl,
    isFetchableByZest: sandbox.isFetchableByZest,
    isFreshDownload:   sandbox.isFreshDownload,
    capture:           sandbox.captureDownload,
    types:            vm.runInContext('DOWNLOADABLE_REQ_TYPES', sandbox),
  };
}

async function main() {
  const { isApiLikeUrl, isFetchableByZest, isFreshDownload, capture, types } = loadBackground();

  console.log('\nrequest types the header layer will act on');
  // The regression: Gmail sends inline images as
  // `Content-Disposition: attachment; filename="unnamed.png"`, so restoring
  // a Gmail tab downloaded every picture on the page.
  ok('images are not downloads',      !types.has('image'));
  ok('media is not a download',       !types.has('media'));
  ok('scripts are not downloads',     !types.has('script'));
  ok('stylesheets are not downloads', !types.has('stylesheet'));
  ok('fonts are not downloads',       !types.has('font'));
  ok('subframes are not downloads',   !types.has('sub_frame'));
  ok('xhr is not a download',         !types.has('xmlhttprequest'));
  ok('fetch is not a download',       !types.has('fetch'));
  ok('top-level navigation counts',    types.has('main_frame'));
  // "other" is web app manifests, beacons and prefetches. Google serves JSON
  // endpoints with Content-Disposition: attachment to blunt XSSI, so allowing
  // it meant every visit to Gmail downloaded its manifest.json.
  ok('"other" is not a download',     !types.has('other'));
  ok('objects are not downloads',     !types.has('object'));
  ok('pings are not downloads',       !types.has('ping'));
  ok('websockets are not downloads',  !types.has('websocket'));

  console.log('\nonly downloads that are starting right now');
  // Chrome replays onCreated for the whole download list whenever the service
  // worker re-registers its listener. Without this guard, opening the browser
  // grabbed every past download, cancelled it, erased it from history and
  // re-fetched it against long-expired one-time URLs.
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

  ok('a download starting now is taken',
     isFreshDownload({ state: 'in_progress', bytesReceived: 0, startTime: now }));
  ok('a finished history entry is ignored',
     !isFreshDownload({ state: 'complete', bytesReceived: 999, startTime: old }));
  ok('an interrupted history entry is ignored',
     !isFreshDownload({ state: 'interrupted', bytesReceived: 10, startTime: old }));
  ok('a days-old entry replayed as in_progress is ignored',
     !isFreshDownload({ state: 'in_progress', bytesReceived: 0, startTime: old }));
  ok('a transfer already underway is ignored',
     !isFreshDownload({ state: 'in_progress', bytesReceived: 4096, startTime: now }));
  ok('a missing timestamp is ignored rather than guessed',
     !isFreshDownload({ state: 'in_progress', bytesReceived: 0 }));
  ok('a garbage timestamp is ignored',
     !isFreshDownload({ state: 'in_progress', bytesReceived: 0, startTime: 'not-a-date' }));

  console.log('\na deliberate click is never deduped');
  // The duplicate window exists so downloads.onCreated and the header layer do
  // not both queue one automatic capture. Applied to a button press it meant
  // the same file could not be fetched twice, or taken at a second quality,
  // for thirty seconds — the click simply did nothing.
  {
    // A zip is auto-capturable; an image deliberately is not, so it could
    // never demonstrate the automatic path being refused.
    const url = 'https://example.com/archive.zip';
    const first = await capture({ url, force: true });
    const again = await capture({ url, force: true });
    const auto  = await capture({ url, filename: 'archive.zip' });

    ok('a click is accepted', first.ok, JSON.stringify(first));
    ok('the same click again is accepted', again.ok, JSON.stringify(again));
    ok('an automatic repeat is still refused',
       auto.reason === 'duplicate', JSON.stringify(auto));
  }

  console.log('\nurls the app can actually fetch');
  ok('https is fetchable',   isFetchableByZest('https://x.com/a.zip'));
  ok('http is fetchable',    isFetchableByZest('http://x.com/a.zip'));
  ok('magnet is fetchable',  isFetchableByZest('magnet:?xt=urn:btih:abc'));
  ok('blob is left to Chrome', !isFetchableByZest('blob:https://example.com/abc-123'));
  ok('data is left to Chrome', !isFetchableByZest('data:application/pdf;base64,JVBER'));
  ok('file is left to Chrome', !isFetchableByZest('file:///C:/x.pdf'));

  console.log('\napi endpoints stay filtered');
  ok('batchexecute is an api call',
     isApiLikeUrl('https://ogs.google.com/u/0/_/OneGoogleWidgetUi/data/batchexecute?rpcid=x', true));
  ok('gen_204 is an api call',
     isApiLikeUrl('https://www.google.com/gen_204', true));
  ok('a confirmed file on an extensionless path is not an api call',
     !isApiLikeUrl('https://portal.example.edu/cms/student/transcript', true));
  ok('an unconfirmed extensionless path is still treated as an api call',
     isApiLikeUrl('https://portal.example.edu/cms/student/transcript', false));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();

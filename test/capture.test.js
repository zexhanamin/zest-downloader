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
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background.js' });

  return {
    isApiLikeUrl:     sandbox.isApiLikeUrl,
    isFetchableByZest: sandbox.isFetchableByZest,
    types:            vm.runInContext('DOWNLOADABLE_REQ_TYPES', sandbox),
  };
}

function main() {
  const { isApiLikeUrl, isFetchableByZest, types } = loadBackground();

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
  ok('"other" counts',                 types.has('other'));

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

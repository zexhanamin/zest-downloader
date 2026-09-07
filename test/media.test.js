/* ═══════════════════════════════════════════════
   Zest Downloader — test/media.test.js

   The video engine's decisions, without touching
   the network or yt-dlp itself: which links belong
   to it, and which format selector it builds.

   Run with:  node test/media.test.js
═══════════════════════════════════════════════ */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  isMediaUrl, mediaSiteFor, qualitiesFor, formatSelector, MEDIA_HOSTS,
  MediaDownload, friendlyError, cookiesToNetscape,
  shouldCheckForUpdate, UPDATE_CHECK_EVERY,
} = require('../src/media');

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

/** Stand in for the list yt-dlp writes with --print-to-file */
function writeList(lines) {
  const p = path.join(os.tmpdir(), `zest-test-list-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

async function main() {
  console.log('\nlinks the video engine claims');
  eq('a YouTube watch page',   mediaSiteFor('https://www.youtube.com/watch?v=abc123'), 'YouTube');
  eq('a youtu.be short link',  mediaSiteFor('https://youtu.be/abc123'), 'YouTube');
  eq('an Instagram reel',      mediaSiteFor('https://www.instagram.com/reel/XYZ/'), 'Instagram');
  eq('a TikTok video',         mediaSiteFor('https://www.tiktok.com/@user/video/123'), 'TikTok');
  eq('an X post',              mediaSiteFor('https://x.com/user/status/123'), 'X');

  console.log('\nlinks it leaves to the normal HTTP engine');
  // A plain file must keep going through the chunked downloader, which is
  // faster and resumable — handing it to yt-dlp would be a downgrade.
  ok('a direct mp4',     !isMediaUrl('https://cdn.example.com/movie.mp4'));
  ok('an installer',     !isMediaUrl('https://example.com/setup.exe'));
  ok('a magnet link',    !isMediaUrl('magnet:?xt=urn:btih:abc'));
  ok('a blob url',       !isMediaUrl('blob:https://example.com/abc'));
  ok('nonsense',         !isMediaUrl('not a url'));
  ok('an empty string',  !isMediaUrl(''));

  console.log('\nhostname matching is not a substring match');
  // "youtube.com.evil.tld" must not read as YouTube
  ok('a lookalike domain is rejected',
     !isMediaUrl('https://www.youtube.com.evil.tld/watch?v=x'));
  ok('a path mentioning youtube is rejected',
     !isMediaUrl('https://example.com/youtube.com/watch?v=x'));
  ok('every host entry is anchored',
     MEDIA_HOSTS.every(h => h.re.source.includes('$')));

  console.log('\nquality list');
  const info = {
    formats: [
      { vcodec: 'avc1', height: 1080 },
      { vcodec: 'avc1', height: 720 },
      { vcodec: 'avc1', height: 720 },
      { vcodec: 'none', acodec: 'mp4a' },      // audio-only stream
      { vcodec: 'avc1', height: 144 },
      { vcodec: 'avc1' },                       // no height — unusable
    ],
  };
  const q = qualitiesFor(info);
  eq('heights are de-duplicated and sorted',
     q.filter(x => x.height).map(x => x.label).join(','), '1080p,720p,144p');
  ok('audio-only is always offered', q.some(x => x.id === 'audio'));
  ok('formats without a height are dropped', !q.some(x => x.height === undefined));

  console.log('\nformat selector');
  // Above 720p YouTube sends video and audio separately. Without ffmpeg to
  // merge them, asking for the best video stream yields a silent file — so
  // fall back to streams that already carry both.
  const withFf = formatSelector('1080', true);
  const noFf   = formatSelector('1080', false);
  ok('with ffmpeg it merges the best of each', withFf.includes('bestvideo') && withFf.includes('bestaudio'));
  ok('without ffmpeg it never asks for a video-only stream', !noFf.includes('bestvideo'));
  ok('without ffmpeg it caps at the chosen height', noFf.includes('[height<=1080]'));
  ok('audio-only asks for audio either way',
     formatSelector('audio', true).includes('bestaudio')
     && formatSelector('audio', false).includes('bestaudio'));
  ok('an unknown quality still produces a usable selector',
     formatSelector('best', true).includes('best'));

  console.log('\nprogress across a merged download');
  // yt-dlp fetches the video stream, then the audio stream, and each phase
  // restarts its byte count at zero. Reported straight through, the bar
  // fills up and snaps back to nothing halfway.
  {
    const dl = new MediaDownload({ url: 'https://youtu.be/x', savePath: '.', id: 't' });
    const seen = [];
    dl.on('progress', p => seen.push(p.downloadedBytes));

    const tick = (got, total) => dl._onProgressLine(`ZESTPROGRESS|${got}|${total}|NA|1000|5`);

    tick(1000, 4000); tick(2500, 4000); tick(4000, 4000);   // video phase
    tick(500, 1000);  tick(1000, 1000);                     // audio phase restarts at 0

    const monotonic = seen.every((v, i) => i === 0 || v >= seen[i - 1]);
    ok('progress never goes backwards', monotonic, seen.join(' -> '));
    eq('final byte count spans both phases', seen[seen.length - 1], 5000);
    ok('total covers both phases', dl.totalBytes >= 5000, `total was ${dl.totalBytes}`);
  }

  console.log('\ncookies become a jar, not a header');
  // yt-dlp treats --add-header Cookie: as a security risk, and on YouTube real
  // session cookies passed that way break extraction outright.
  {
    const jar = cookiesToNetscape('SID=abc; HSID=def', 'https://www.youtube.com/watch?v=x');
    const rows = jar.trim().split('\n');
    ok('starts with the format header', rows[0].startsWith('# Netscape'));
    eq('one row per cookie', rows.length - 1, 2);

    const cells = rows[1].split('\t');
    eq('seven tab-separated fields', cells.length, 7);
    eq('domain is scoped to the site', cells[0], '.youtube.com');
    eq('name lands in the right column', cells[5], 'SID');
    eq('value lands in the right column', cells[6], 'abc');

    const insta = cookiesToNetscape('A=1', 'https://www.instagram.com/reel/x');
    eq('www is stripped so subdomains match',
       insta.trim().split('\n')[1].split('\t')[0], '.instagram.com');

    ok('no cookies means no jar at all', cookiesToNetscape('', 'https://x.com/a') === null);
    ok('a junk url yields no jar', cookiesToNetscape('A=1', 'not a url') === null);
    ok('a header with no pairs yields no jar',
       cookiesToNetscape('garbage', 'https://x.com/a') === null);
  }

  console.log('\nerror messages a person can act on');
  {
    const login = friendlyError('ERROR: [Instagram] xyz: Requested content is not available, rate-limit reached or login required');
    ok('a login wall explains the way out', /signed in|extension/i.test(login), login);
    ok('it does not just echo yt-dlp', !login.includes('rate-limit reached or login'));

    const gone = friendlyError('ERROR: [youtube] abc: Video unavailable');
    ok('an unavailable video says why it might be', /private|removed|region/i.test(gone), gone);

    const odd = friendlyError('ERROR: Unsupported URL: https://example.com/x');
    ok('an unsupported link says so plainly', /not one the video helper/i.test(odd), odd);

    const other = friendlyError('ERROR: HTTP Error 503: Service Unavailable');
    eq('anything else is passed through untouched',
       other, 'ERROR: HTTP Error 503: Service Unavailable');
  }

  console.log('\nprogress across a playlist');
  // Each entry restarts its byte count. Without banking the finished ones the
  // bar would reset on every video, and the card could not say where it is.
  {
    const dl = new MediaDownload({
      url: 'https://youtube.com/playlist?list=X', savePath: '.', id: 'p', playlist: true,
    });
    const seen = [];
    dl.on('progress', p => seen.push(p));
    const tick = (got, total, idx) =>
      dl._onProgressLine(`ZESTPROGRESS|${got}|${total}|NA|1000|5|${idx}|3`);

    tick(500, 1000, 1); tick(1000, 1000, 1);   // entry 1
    tick(400, 1000, 2); tick(1000, 1000, 2);   // entry 2
    tick(300, 1000, 3);                        // entry 3

    const bytes = seen.map(p => p.downloadedBytes);
    ok('bytes never go backwards between entries',
       bytes.every((v, i) => i === 0 || v >= bytes[i - 1]), bytes.join(' -> '));
    eq('bytes accumulate across entries', bytes[bytes.length - 1], 2300);
    eq('reports the entry it is on', seen[seen.length - 1].item, 3);
    eq('reports how many there are', seen[seen.length - 1].itemCount, 3);
    ok('total is projected past the current entry',
       seen[seen.length - 1].totalBytes >= 3000,
       `total was ${seen[seen.length - 1].totalBytes}`);
  }

  console.log('\na single video reports no playlist position');
  {
    const dl = new MediaDownload({ url: 'https://youtu.be/x', savePath: '.', id: 's' });
    let last = null;
    dl.on('progress', p => { last = p; });
    dl._onProgressLine('ZESTPROGRESS|100|1000|NA|500|2|NA|NA');
    eq('item is zero', last.item, 0);
    eq('itemCount is zero', last.itemCount, 0);
  }

  console.log('\nunparseable progress fields');
  {
    const dl = new MediaDownload({ url: 'https://youtu.be/x', savePath: '.', id: 't2' });
    let last = null;
    dl.on('progress', p => { last = p; });
    // yt-dlp writes NA for anything it does not know yet
    dl._onProgressLine('ZESTPROGRESS|NA|NA|NA|NA|NA');
    ok('NA never becomes NaN',
       Number.isFinite(last.downloadedBytes) && Number.isFinite(last.totalBytes)
       && Number.isFinite(last.speedRaw));
    ok('percent stays null while the size is unknown', last.percent === null);
  }

  console.log('\nthe path Open will use');
  // yt-dlp used to report this through --print, which goes out via the
  // console encoding: on Windows that quietly deletes every character it
  // cannot draw, so a title with emoji or Arabic in it produced a path to
  // a file that did not exist and Open said "File not found" about a file
  // sitting in the folder. It is read back from a UTF-8 file now.
  {
    const dir  = path.join(os.tmpdir(), 'zest-dl');
    const real = path.join(dir, 'أسماء 🌍 ｜ video.mp4');

    const dl = new MediaDownload({ url: 'https://youtu.be/x', savePath: dir, id: 'p1' });
    const list = writeList([real]);
    await dl._readFinishedFiles(list);

    eq('the name keeps every character', dl.finalPath, real);
    eq('the filename comes off that path', dl.filename, 'أسماء 🌍 ｜ video.mp4');
    ok('the list file is not left behind', !fs.existsSync(list));
  }

  {
    // A run that was cancelled writes nothing. Leaving finalPath alone beats
    // pointing it at an empty string.
    const dl = new MediaDownload({ url: 'https://youtu.be/x', savePath: '.', id: 'p2' });
    await dl._readFinishedFiles(path.join(os.tmpdir(), 'zest-test-list-missing.txt'));
    eq('no list means no path', dl.finalPath, null);
  }

  {
    // Forty entries land in a folder of their own. Open should mean the
    // folder, not whichever video happened to finish last.
    const dir    = path.join(os.tmpdir(), 'zest-dl');
    const folder = path.join(dir, 'Road Trip Mix');
    const dl = new MediaDownload({
      url: 'https://youtube.com/playlist?list=PL1', savePath: dir, id: 'p3', playlist: true,
    });
    const list = writeList([
      path.join(folder, '01 - First.mp4'),
      path.join(folder, '02 - Second.mp4'),
      path.join(folder, '03 - Third.mp4'),
    ]);
    await dl._readFinishedFiles(list);

    eq('a playlist points at its folder', dl.finalPath, folder);
    eq('and is named after it', dl.filename, 'Road Trip Mix');
  }

  {
    // One video reached through a ?list= link is not a playlist download
    const dir = path.join(os.tmpdir(), 'zest-dl');
    const one = path.join(dir, 'Only One.mp4');
    const dl = new MediaDownload({
      url: 'https://youtube.com/watch?v=x', savePath: dir, id: 'p4', playlist: true,
    });
    await dl._readFinishedFiles(writeList([one]));
    eq('a single entry still points at the file', dl.finalPath, one);
  }

  console.log('\nwhen yt-dlp gets replaced on its own');
  // The sites break yt-dlp every few weeks. Left to the user that means a
  // download that worked last month failing on an extractor error nobody
  // outside this file could interpret, so the app keeps its own copy current.
  {
    const now  = Date.parse('2026-09-07T12:00:00Z');
    const base = { enabled: true, installed: true, busy: false, checkedAt: 0, now };
    const why  = (patch) => shouldCheckForUpdate({ ...base, ...patch }).reason;

    eq('a fresh install with no check on record is due', why({}), 'due');
    eq('turned off means no check',        why({ enabled: false }), 'disabled');
    eq('nothing to update before setup',   why({ installed: false }), 'not-installed');
    // Windows locks a running .exe, so replacing it mid-download would fail
    // on the move and leave the user with an error for something they never
    // asked for. Waiting an hour costs nothing.
    eq('a running video download defers it', why({ busy: true }), 'busy');
    eq('a check an hour ago is enough',
       why({ checkedAt: now - 60 * 60 * 1000 }), 'checked-recently');
    eq('a check yesterday is not',
       why({ checkedAt: now - UPDATE_CHECK_EVERY - 1000 }), 'due');

    // Order matters: a locked binary must be reported as busy, because the
    // caller comes back in an hour for that and only tomorrow for the rest.
    eq('busy outranks the daily clock',
       why({ busy: true, checkedAt: now - 60 * 1000 }), 'busy');
    eq('off outranks everything', why({ enabled: false, installed: false }), 'disabled');

    ok('a due check says so', shouldCheckForUpdate({ ...base }).check === true);
    ok('a refused one does not', shouldCheckForUpdate({ ...base, busy: true }).check === false);
    ok('checking is a day apart, not an hour', UPDATE_CHECK_EVERY === 24 * 60 * 60 * 1000);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();

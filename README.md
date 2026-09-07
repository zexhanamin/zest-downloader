# Zest Downloader

A download manager for Windows, built with Electron. HTTP multi-chunk
downloading with real pause/resume, BitTorrent support, a dark/light UI, and a
Chrome extension that hands downloads over from the browser.

> **Status: pre-release.** The download engine is covered by tests and works,
> but the app has not been through wide real-world testing yet. Expect rough
> edges, and please open an issue when you hit one.

---

## Features

**Working today**

- **HTTP chunked downloading** — splits a file into up to 8 parallel byte-range
  segments. Verifies the server actually honours `Range` (returns `206`) and
  falls back to a single stream when it doesn't, instead of writing a corrupt file.
- **Real pause / resume** — partial segments are kept on disk with a state
  sidecar, so resuming continues from where it stopped rather than restarting.
  Survives closing the app.
- **Automatic retry** — each segment retries up to 3 times with backoff, picking
  up from the bytes already written.
- **BitTorrent + magnet links** — WebTorrent with DHT and a default tracker set.
- **Persistent queue** — SQLite (via `sql.js`, no native build step). Transfers
  interrupted by a crash come back as paused with a working Resume button.
- **Concurrency limit** — 4 transfers at a time by default; the rest wait.
- **Browser extension** — Chrome/Edge/Brave (MV3). Captures download links and
  magnet links and forwards them to the app.
- **Video downloads** — YouTube, Instagram, TikTok, X, Reddit, Facebook, Vimeo,
  Dailymotion and Twitch. Paste a link in the Video tab, pick a quality, or use
  the Download button the extension puts on the page.
- **Playlists** — a YouTube playlist or channel downloads every entry into its
  own numbered folder. A link that merely carries `?list=` offers the choice
  rather than taking it.
- **Search and filters** — free-text search across names and source URLs, plus
  an Unfinished tab for everything that did not complete, whatever stopped it.
- **Removing a download** asks whether the file should go too. Clearing the
  entry and deleting what was downloaded are separate choices, and the file is
  only ever deleted from the folder that job saved into.
- **Dark & light theme**, custom titlebar, system tray, drag & drop, right-click
  context menu on each download.

**Not implemented yet** (contributions welcome)

- Global speed limits (per-torrent limits exist over IPC but have no UI)
- Selective file download from a multi-file torrent (engine + IPC exist, no UI)
- Download scheduler / active-hours window
- Torrent streaming (watch while downloading)
- A settings UI — `zest-config.json` has to be edited by hand for now
- Firefox support — the extension is MV3 with a service worker, which Firefox
  does not load as-is

---

## Project structure

```
zest-downloader/
├── main.js                 # Electron main process, IPC, scheduler, bridge server
├── preload.js              # contextBridge API (window.zest) with a channel allow-list
├── index.html              # App shell + styles + UI glue
├── eslint.config.js
│
├── src/
│   ├── downloader.js       # HTTP chunked engine: resume, range checks, safe naming
│   ├── media.js            # yt-dlp wrapper: YouTube/Instagram/TikTok and friends
│   ├── queue.js            # sql.js persistent queue + migrations + crash recovery
│   ├── torrent.js          # WebTorrent integration
│   ├── config.js           # Settings manager (JSON in userData)
│   ├── extension-installer.js  # Helpers for getting the extension into a browser
│   ├── updater.js          # electron-updater wiring
│   ├── renderer.js         # UI logic + live event handling
│   └── styles.css          # Supplemental styles
│
├── extension/              # Chrome MV3 extension
│   ├── manifest.json
│   ├── background.js       # Service worker — capture layers
│   ├── content.js          # Click interception + magnet scanning
│   ├── video.js            # Download button on video pages
│   └── popup.html/.js      # Extension popup UI
│
├── build/
│   └── installer.nsh       # NSIS hooks for electron-builder
│
├── test/
│   ├── downloader.test.js  # HTTP engine against a deliberately hostile local server
│   ├── queue.test.js       # Migration + crash recovery
│   └── displayname.test.js # List labels and sidebar filtering
│
└── assets/                 # App icons
```

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- npm v9 or higher

### Install and run

```bash
git clone https://github.com/zexhanamin/zest-downloader.git
cd zest-downloader
npm install
npm run dev
```

### Tests and linting

```bash
npm test
npm run lint
```

`npm test` spins up a local HTTP server that misbehaves on purpose — ignores
`Range`, rejects `HEAD`, drops connections mid-transfer, and sends a
`Content-Disposition` filename that tries to escape the download directory —
and asserts the engine handles each case.

### Build distributables

```bash
npm run build:win     # NSIS installer + portable exe
```

Output lands in `dist/`.

**Windows only for now.** The macOS and Linux targets were removed from the
build config rather than left in place untested — Electron can package for
them, but nobody has run the result, and shipping an untried binary is worse
than shipping none. The code itself has no Windows-only assumptions outside
`src/extension-installer.js`, so adding those targets back is mostly a matter
of someone testing them.

---

## Browser extension

The extension is not on the Chrome Web Store yet, so it has to be side-loaded.

1. In Zest, click **Extension** in the toolbar to see the folder path
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the `extension/` folder

The same modal has a **Launch test browser** button, which opens
Chrome/Edge/Brave in a separate throwaway profile with the extension already
loaded — useful for a quick try without touching your main profile.

### How capture works

The extension talks to the app over a local HTTP bridge on `127.0.0.1:6543`,
which Zest opens while it is running. Six layers catch downloads:

| Layer | Catches |
|---|---|
| `downloads.onCreated` | Anything Chrome would show in its download bar |
| `webRequest.onHeadersReceived` | Token/redirect URLs that only reveal themselves via `Content-Disposition` |
| `webNavigation.onBeforeNavigate` | `magnet:` navigations and `window.open` |
| Content script click handler | Direct file links, `data-*` URLs, magnet links |
| Context menu | "Download with Zest" on any link, image, video or audio |
| Hover button | A Download button over any image or video on any page |

### The button on the page

Hovering an image or a video large enough to be the thing you are looking at
puts a small **⬇ Zest** button in its corner. What that button does depends on
what the element actually is:

- An `<img>`, or a `<video>` whose `src` is an ordinary URL — Zest fetches that
  URL directly, with the page as referrer and that site's cookies.
- A player streaming through MSE, where `src` is a `blob:` that exists only
  inside the tab — there is no file to take. On YouTube, Instagram, TikTok and
  the other known sites the page URL goes to yt-dlp instead; anywhere else the
  button says so rather than failing quietly.

One button follows the pointer rather than one being injected per element:
pages carry hundreds of images, and adding a node inside each would be slow and
would disturb layouts that were never expecting it. Icons and avatars are
skipped — an image has to be at least 160px on both sides to be offered.

The extension popup's **On this page** tab lists the same media, for when the
button is in the way or the layout hides it.

On a player site the button does not download straight away. It asks Zest what
that video actually offers and shows the list — 2160p down to 144p, plus audio
only — and queues nothing until a choice is made. A plain image or video file
has exactly one version, so those go immediately.

### Video quality and the JS runtime

YouTube protects its stream URLs with a challenge that has to be executed, and
yt-dlp needs a JavaScript runtime to solve it. Without one it still works but
warns that extraction is deprecated and that formats may be missing — in
testing the same video topped out well below its real resolution without a
runtime and reached 2160p with one.

Zest uses its own copy of deno if one has been fetched, otherwise whichever of
`deno`, `node` or `bun` is on PATH. If none is found, the Video tab offers to
download deno (~41 MB, about 93 MB unpacked) the same way it offers ffmpeg. Nothing is
required — without a runtime the app still works, it just reaches fewer formats.

### The progress popup

A capture does not raise the app. A small always-on-top window appears in
the corner with the name, progress, speed and time left, and once the file
exists it offers **Open**, **Open folder** and **Close**. A failure shows the
reason and only Close, because there is nothing to open.

It has no taskbar entry and never takes focus, so it cannot interrupt what
you were typing. The full window is raised from one place only — the **See
all downloads** link on the popup, where you asked for it.

### Logged-in downloads

Downloads behind a sign-in (a university portal, a paid host, anything with a
session) only work if Zest sends the browser's cookies. The extension reads the
cookies for that URL and passes them along with the link.

They reach yt-dlp as a short-lived Netscape cookie file rather than a `Cookie:`
header. yt-dlp warns that a raw header is a security risk, and on YouTube it
breaks extraction outright — the session arrives without the tokens yt-dlp
negotiates for itself and the site answers "The page needs to be reloaded". The
file is deleted as soon as the command that needed it finishes, and a probe
that fails with a session retries without one, so a site that needs cookies
still works and a public video is not broken by carrying them.

Those cookies are live credentials, so they are never written to the queue
database in the clear. They are encrypted with the OS keystore through
Electron's `safeStorage` — DPAPI on Windows, Keychain on macOS, libsecret on
Linux — which ties them to your user account on this machine, the same way a
browser protects its own cookie jar. They are wiped as soon as the download
finishes or is cancelled.

Worth knowing:

- The extension needs the `cookies` permission. Without it, protected downloads
  come back as the site's sign-in page.
- Where the OS provides no keystore, cookies stay in memory for that run only,
  and resuming after a restart fails rather than falling back to plaintext.

If a server answers with a web page when a real file was expected, Zest refuses
the download and says so, instead of saving 9 KB of HTML as `transcript.pdf`.

**Capture only intercepts when Zest is actually running.** If the app is closed
or capture is switched off with `Alt+Z`, clicks and downloads are left entirely
to the browser. If a handoff fails after Chrome's download was already
cancelled, the extension restarts it in Chrome so nothing is lost.

---

## Video downloads

YouTube, Instagram and TikTok do not serve a video as a file. They stream it in
segments behind signed, short-lived URLs, and YouTube additionally ciphers the
signature and throttles playback with a parameter it changes regularly. The
chunked HTTP engine cannot resolve any of that, so Zest drives
[yt-dlp](https://github.com/yt-dlp/yt-dlp) for these sites.

**yt-dlp is not bundled.** It is fetched from its official GitHub release the
first time you open the Video tab, with a button you have to press, and stored
in `%APPDATA%\zest-downloader\bin\`. Keeping it separate means it can be
re-downloaded when a site changes and breaks it — which happens regularly, and
is the main reason a bundled copy would go stale.

**It keeps itself current.** A site changing how it serves video is what breaks
yt-dlp, and it happens every few weeks; left alone that surfaces as videos that
downloaded fine last month failing on an extractor error that means nothing to
the person reading it. So Zest asks GitHub once a day whether the release has
moved, and replaces its copy if it has — no prompt, and nothing to remember.
The Video tab shows the version it is on and when it last looked, with a button
for the day a site breaks and tomorrow is not soon enough.

A check is skipped while a video is downloading, because Windows locks a
running executable; it retries an hour later. `autoUpdateHelper: false` in the
config file turns the whole thing off.

Two ways to use it:

- **Video tab** — paste a link, press Fetch, pick a quality
- **The extension** — a Download button appears on YouTube, Instagram and TikTok
  video pages and sends the page URL straight to Zest

### ffmpeg

Above 720p, YouTube sends video and audio as separate streams that must be
joined back together, and some videos have no combined stream at all. That
needs ffmpeg. Zest offers a second one-click download for it (from the build
the yt-dlp project maintains) and works without it at reduced quality — the
Video tab says which qualities are actually available either way.

### Worth knowing

- Downloading from these sites is generally against their terms of service.
  That is your call to make; the tooling is here.
- YouTube playlists work — a link carrying `?list=` offers the whole playlist
  as a checkbox, and the entries land in a folder named after it. Channels are
  not supported.
- yt-dlp and ffmpeg are separate open-source projects under their own licences
  (Unlicense and GPL respectively). They are downloaded, not redistributed.

---

## Configuration

Settings live in a JSON file. There is no settings UI yet — edit the file and
restart the app.

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%\zest-downloader\zest-config.json` |
| macOS    | `~/Library/Application Support/zest-downloader/zest-config.json` |
| Linux    | `~/.config/zest-downloader/zest-config.json` |

Only the Windows path applies to the released build; the other two are where
the file lands when running from source on those platforms.

Every key below is read by real code; invalid values are ignored with a warning
and the previous value is kept.

```json
{
  "defaultDownloadDir":  "~/Downloads",
  "startAtLogin":        true,
  "autoUpdateHelper":    true,
  "helperCheckedAt":     0,
  "maxChunksPerFile":    8,
  "maxConcurrentDl":     4,
  "retryLimit":          3,
  "retryDelayMs":        2000,
  "minChunkSizeBytes":   2097152,
  "seedAfterDownload":   true,
  "maxPeersPerTorrent":  55,
  "dhtEnabled":          true,
  "torrentPort":         20000,
  "trackers":            ["udp://tracker.opentrackr.org:1337/announce", "..."],
  "bridgePort":          6543
}
```

`helperCheckedAt` is the app's own bookkeeping — when the yt-dlp update check
last got an answer — rather than something to set by hand.

The download folder chosen in the UI and the theme are stored separately, in
the renderer's `localStorage`.

---

## How downloads work

### HTTP

```
URL → HEAD, then a 1-byte ranged GET to confirm size and real range support
    ↓
Range supported and file > 4 MB?
    ├─ yes → split into N chunks, download in parallel into <dir>/.zest-<id>.parts/
    │         each chunk appends to its own part file and is verified for length
    │         → merge in order into a temp file → rename into place
    └─ no  → single stream into <name>.part → rename into place
```

Pause aborts the transfer but keeps the parts and a `state.json` sidecar
describing the chunk layout. Resume re-reads what is on disk and requests only
the missing byte ranges. Cancel deletes everything.

Filenames from `Content-Disposition` are sanitised before they touch the
filesystem: path separators, `..`, control characters and Windows-illegal
characters are stripped, and reserved device names are replaced. A name that
already exists becomes `name (1).ext` instead of overwriting.

### Torrents

```
Magnet / .torrent → WebTorrent client
                  → DHT + tracker peer discovery
                  → piece-by-piece download with SHA-1 verification
                  → seeds after completion (set "seedAfterDownload": false to stop)
```

**Seeding uploads to other peers.** It is on by default, as in any BitTorrent
client, and the download shows a "Seeding" badge while it is happening.

---

## Security notes

This is a download manager, so it handles a lot of attacker-controlled input.
What is done about it:

- **Bridge access control** — the local bridge only accepts requests from a
  browser-extension origin. A web page reaching `127.0.0.1:6543` is refused, so
  a site cannot queue downloads into your Downloads folder.
- **Path traversal** — every filename is sanitised before `path.join`.
- **Renderer XSS** — filenames and server error strings are HTML-escaped before
  rendering, and the page runs under a CSP that blocks remote script and all
  outbound network requests.
- **Session cookies** — forwarded from the extension to the local app for
  logged-in downloads, held in memory for the life of the job, never persisted.
- **IPC surface** — the preload bridge routes every call through an explicit
  channel allow-list, and the renderer cannot ask the main process to open an
  arbitrary path, only a download folder or a file belonging to a queue job.

Found something? Open an issue.

---

## IPC API (preload bridge)

The renderer talks to the main process via `window.zest`:

```js
// Add an HTTP download — returns { id } or { error }
const res = await window.zest.downloadAdd('https://example.com/file.zip');

// Add a torrent (magnet or .torrent path)
await window.zest.torrentAdd('magnet:?xt=urn:btih:...', '/downloads', [0, 1]);

// Pause / resume / cancel
await window.zest.downloadPause(id);
await window.zest.downloadResume(id);
await window.zest.downloadCancel(id);

// Listen to live progress
const off = window.zest.on('download:progress', (p) => {
  console.log(`${p.percent}% @ ${p.speed} — ETA ${p.eta}s`);
});
off();   // unsubscribe
```

Events: `download:meta`, `download:progress`, `download:merging`,
`download:done`, `download:paused`, `download:error`, `torrent:meta`,
`torrent:progress`, `torrent:done`, `torrent:paused`, `torrent:resumed`,
`torrent:peer`, `torrent:warning`, `torrent:error`, `bridge:error`, and the
`update:*` family.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | [Electron](https://electronjs.org/) 31 |
| HTTP engine | Axios + Node.js streams |
| Torrent engine | [WebTorrent](https://webtorrent.io/) |
| Queue / persistence | [sql.js](https://sql.js.org/) (SQLite compiled to WebAssembly) |
| Build / packaging | [electron-builder](https://www.electron.build/) |
| Browser extension | Chrome MV3 |

### Known dependency advisories

`npm audit` reports high-severity advisories along this chain:

```
webtorrent → torrent-discovery → bittorrent-tracker → ip@2.0.1
```

Everything above `ip` is only reported because it depends on `ip`. The advisory
itself (CVE-2024-29415, `isPublic()` misclassifying addresses) has **no fix
available**: `ip` has three published versions, all affected, and the package is
no longer maintained. Upgrading does not help either — the newest
`bittorrent-tracker` still requires `ip@^2.0.1`, and WebTorrent 3.x pulls the
same `torrent-discovery` line.

`npm audit fix --force` "resolves" it by downgrading WebTorrent from 2.x to
**0.7.3**, which removes almost everything the app uses. Don't run it.

What limits the impact here: `ip` is imported by exactly one file,
`bittorrent-tracker/lib/server/parse-udp.js`, which parses inbound requests to a
UDP **tracker server**. Zest only ever runs the tracker *client*, so that parser
never sees input. The dependency is loaded, but the vulnerable function is not
reachable from anything Zest does.

This will keep showing up in `npm audit` until upstream drops `ip`.

---

## License

MIT — see [LICENSE](LICENSE).

# Zest Downloader

A cross-platform download manager built with Electron. HTTP multi-chunk
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
npm run build:mac     # dmg + zip
npm run build:linux   # AppImage, deb, rpm
```

Output lands in `dist/`. Only the Windows build has been tested so far.

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
which Zest opens while it is running. Five layers catch downloads:

| Layer | Catches |
|---|---|
| `downloads.onCreated` | Anything Chrome would show in its download bar |
| `webRequest.onHeadersReceived` | Token/redirect URLs that only reveal themselves via `Content-Disposition` |
| `webNavigation.onBeforeNavigate` | `magnet:` navigations and `window.open` |
| Content script click handler | Direct file links, `data-*` URLs, magnet links |
| Context menu | "Download with Zest" on any link, image, video or audio |

### Logged-in downloads

Downloads behind a sign-in (a university portal, a paid host, anything with a
session) only work if Zest sends the browser's cookies. The extension reads the
cookies for that URL and passes them along with the link; the app keeps them
**in memory only** and never writes them to the queue database.

Two consequences worth knowing:

- The extension needs the `cookies` permission. Without it, protected downloads
  come back as the site's sign-in page.
- Resuming such a download after restarting Zest loses the session, so it will
  fail. That is deliberate — the alternative is storing live credentials on disk.

If a server answers with a web page when a real file was expected, Zest refuses
the download and says so, instead of saving 9 KB of HTML as `transcript.pdf`.

**Capture only intercepts when Zest is actually running.** If the app is closed
or capture is switched off with `Alt+Z`, clicks and downloads are left entirely
to the browser. If a handoff fails after Chrome's download was already
cancelled, the extension restarts it in Chrome so nothing is lost.

---

## Configuration

Settings live in a JSON file. There is no settings UI yet — edit the file and
restart the app.

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%\zest-downloader\zest-config.json` |
| macOS    | `~/Library/Application Support/zest-downloader/zest-config.json` |
| Linux    | `~/.config/zest-downloader/zest-config.json` |

Every key below is read by real code; invalid values are ignored with a warning
and the previous value is kept.

```json
{
  "defaultDownloadDir":  "~/Downloads",
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

`npm audit` reports high-severity advisories in the
`webtorrent → torrent-discovery → bittorrent-tracker` chain. Clearing them
needs a major WebTorrent upgrade, which has not been done yet.

---

## License

MIT — see [LICENSE](LICENSE).

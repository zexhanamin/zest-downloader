/* ═══════════════════════════════════════════════
   Zest Downloader — src/updater.js
   Auto-update using electron-updater.
   Checks GitHub Releases for new versions and
   downloads + installs silently in background.
═══════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────
//  Setup
// ─────────────────────────────────────────────
let autoUpdater = null;
let _mainWindow = null;
let _send       = null;

function send(channel, data) {
  if (_send) _send(channel, data);
}

// ─────────────────────────────────────────────
//  Init updater
// ─────────────────────────────────────────────
function initUpdater(mainWindow, sendFn) {
  _mainWindow = mainWindow;
  _send       = sendFn;

  try {
    const { autoUpdater: au } = require('electron-updater');
    autoUpdater = au;
  } catch (e) {
    console.warn('[Updater] electron-updater not available:', e.message);
    return;
  }

  // Silent background updates — don't annoy the user
  autoUpdater.autoDownload    = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // ── Events ──────────────────────────────────

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for update…');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Update available:', info.version);
    send('update:available', { version: info.version, releaseNotes: info.releaseNotes });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] App is up to date');
    send('update:not-available', {});
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Updater] Downloading: ${progress.percent.toFixed(1)}%`);
    send('update:download-progress', {
      percent:       progress.percent,
      transferred:   progress.transferred,
      total:         progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] Update downloaded:', info.version);
    send('update:downloaded', { version: info.version });
    // Show notification in app
    showUpdateNotification(info.version);
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message);
    send('update:error', { message: err.message });
  });
}

// ─────────────────────────────────────────────
//  Check + install
// ─────────────────────────────────────────────

function checkForUpdates() {
  if (!autoUpdater) return;
  try {
    autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    console.warn('[Updater] Check failed:', e.message);
  }
}

function installUpdate() {
  if (!autoUpdater) return;
  autoUpdater.quitAndInstall(false, true);
}

// ─────────────────────────────────────────────
//  Update notification in app window
// ─────────────────────────────────────────────

function showUpdateNotification(version) {
  if (!_mainWindow || _mainWindow.isDestroyed()) return;

  // Inject a toast into the renderer
  _mainWindow.webContents.executeJavaScript(`
    (function() {
      const c = document.getElementById('toasts');
      if (!c) return;
      const t = document.createElement('div');
      t.className = 'toast info';
      t.style.maxWidth = '300px';
      t.innerHTML = \`
        <div class="toast-dot"></div>
        <span>Update v${version} ready — will install on next restart</span>
        <button onclick="window.zest && window.zest.installUpdate && window.zest.installUpdate(); this.closest('.toast').remove();"
          style="margin-left:8px;border:none;background:var(--accent);color:#fff;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;flex-shrink:0">
          Restart
        </button>\`;
      c.appendChild(t);
      // Don't auto-remove this one — user needs to act
    })();
  `).catch(() => {});
}

// ─────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────
module.exports = { initUpdater, checkForUpdates, installUpdate };

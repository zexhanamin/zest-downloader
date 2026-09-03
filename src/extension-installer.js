/* ═══════════════════════════════════════════════
   Zest Downloader — src/extension-installer.js

   Automatically installs the browser extension
   into Chrome and Edge — exactly like IDM does.

   HOW IDM DOES IT:
   ────────────────
   1. Ships a .crx file inside the installer
   2. Writes Windows Registry keys under
      Chrome/Edge ExtensionInstallForcelist policy
   3. Chrome reads this policy on next launch and
      silently installs the extension

   OUR APPROACH (works without CRX signing):
   ──────────────────────────────────────────
   • Use Chrome's --load-extension flag (dev mode)
   • OR guide user via one-click setup page
   • Registry method also included (enterprise)
═══════════════════════════════════════════════ */

'use strict';

const { execSync, exec } = require('child_process');
const path = require('path');
const fs   = require('fs-extra');
const os   = require('os');

// ─────────────────────────────────────────────
//  Browser paths (Windows)
// ─────────────────────────────────────────────

const BROWSERS = {
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  ],
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(os.homedir(), 'AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'),
  ],
  brave: [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    path.join(os.homedir(), 'AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
  ],
};

// Chrome Web Store Extension ID
// After publishing to Chrome Web Store, replace this with real ID
// For local installs, we use the unpacked extension path
const CHROME_STORE_ID   = null;  // set after publishing e.g. 'abcdefghijklmnopqrstuvwxyz123456'

// ─────────────────────────────────────────────
//  Find installed browsers
// ─────────────────────────────────────────────

function findBrowser(name) {
  const paths = BROWSERS[name] || [];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findAnyBrowser() {
  for (const name of Object.keys(BROWSERS)) {
    const p = findBrowser(name);
    if (p) return { name, path: p };
  }
  return null;
}

// ─────────────────────────────────────────────
//  Method 1 — Registry Policy (IDM method)
//  Works for Chrome & Edge enterprise policy
//  Requires admin OR HKCU (current user) key
// ─────────────────────────────────────────────

function installViaRegistry(extensionId, updateUrl) {
  if (process.platform !== 'win32') return false;

  const policies = [
    // Chrome — current user (no admin needed)
    `HKCU\\Software\\Google\\Chrome\\Extensions\\${extensionId}`,
    // Edge — current user
    `HKCU\\Software\\Microsoft\\Edge\\Extensions\\${extensionId}`,
  ];

  // For Chrome Web Store hosted extensions
  if (extensionId && updateUrl) {
    let success = false;
    for (const regPath of policies) {
      try {
        execSync(`reg add "${regPath}" /v "update_url" /t REG_SZ /d "${updateUrl}" /f`, {
          stdio: 'ignore',
          windowsHide: true,
        });
        success = true;
        console.log(`[ExtInstaller] Registry key written: ${regPath}`);
      } catch (e) {
        console.warn(`[ExtInstaller] Registry write failed for ${regPath}:`, e.message);
      }
    }
    return success;
  }
  return false;
}

// ─────────────────────────────────────────────
//  Method 2 — Open browser with extension
//  loaded automatically (--load-extension)
//  Works immediately, no signing needed
// ─────────────────────────────────────────────

function openBrowserWithExtension(extFolderPath, browserName = null) {
  if (process.platform !== 'win32') return false;

  let browser;
  if (browserName) {
    const p = findBrowser(browserName);
    if (p) browser = { name: browserName, path: p };
  }
  if (!browser) browser = findAnyBrowser();
  if (!browser) {
    console.warn('[ExtInstaller] No browser found');
    return false;
  }

  // IMPORTANT: --load-extension is ignored if the browser already has
  // a running instance on the default profile (Chrome just focuses the
  // existing window and drops the flag). Launching with a dedicated
  // user-data-dir guarantees a fresh process where the flag is honored,
  // regardless of whether Chrome is already open elsewhere.
  const profileDir = path.join(
    os.homedir(), 'AppData', 'Local', 'ZestDownloader', `${browser.name}-ext-profile`
  );
  fs.ensureDirSync(profileDir);

  const args = [
    `--load-extension="${extFolderPath}"`,
    `--user-data-dir="${profileDir}"`,
    '--no-first-run',
  ];

  exec(`"${browser.path}" ${args.join(' ')}`, (err) => {
    if (err) console.warn('[ExtInstaller] Browser open failed:', err.message);
    else console.log(`[ExtInstaller] Opened ${browser.name} with extension pre-loaded`);
  });

  return true;
}

// ─────────────────────────────────────────────
//  Method 3 — One-click setup page
//  Opens a local HTML page that guides the user
//  to install the extension in 2 clicks
// ─────────────────────────────────────────────

function createSetupPage(extFolderPath, outputDir) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Install Zest Extension</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, sans-serif;
    background: #111114;
    color: #EDEDF0;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
  }
  .card {
    background: #18181C;
    border: 1px solid #2A2A34;
    border-radius: 16px;
    padding: 36px;
    max-width: 480px;
    width: 100%;
    text-align: center;
  }
  .logo {
    width: 56px; height: 56px;
    background: #5B5EF4;
    border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    font-size: 28px; font-weight: 700; color: #fff;
    margin: 0 auto 20px;
  }
  h1 { font-size: 20px; margin-bottom: 8px; }
  p  { font-size: 13px; color: #8888A0; line-height: 1.6; margin-bottom: 24px; }
  .steps {
    text-align: left;
    background: #1E1E24;
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 24px;
  }
  .step {
    display: flex; gap: 12px; align-items: flex-start;
    margin-bottom: 12px; font-size: 13px; color: #EDEDF0;
  }
  .step:last-child { margin-bottom: 0; }
  .step-num {
    width: 22px; height: 22px; min-width: 22px;
    background: #5B5EF4; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; color: #fff;
  }
  .btn {
    display: inline-block;
    background: #5B5EF4; color: #fff;
    padding: 12px 28px;
    border-radius: 8px; border: none;
    font-size: 14px; font-weight: 600;
    cursor: pointer; text-decoration: none;
    transition: background 150ms;
    width: 100%;
  }
  .btn:hover { background: #4446c7; }
  .path {
    background: #111114;
    border: 1px solid #2A2A34;
    border-radius: 6px;
    padding: 6px 10px;
    font-family: monospace;
    font-size: 11px;
    color: #5B5EF4;
    word-break: break-all;
    margin-top: 6px;
  }
  .note { font-size: 11px; color: #55556A; margin-top: 16px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">Z</div>
  <h1>Install Zest Extension</h1>
  <p>Add the Zest Downloader extension to Chrome or Edge in 3 easy steps.</p>

  <div class="steps">
    <div class="step">
      <div class="step-num">1</div>
      <div>Open Chrome and go to <strong>chrome://extensions/</strong></div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div>Enable <strong>Developer mode</strong> (toggle in top-right corner)</div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div>
        Click <strong>"Load unpacked"</strong> and select this folder:
        <div class="path">${extFolderPath}</div>
      </div>
    </div>
  </div>

  <button class="btn" onclick="openExtPage()">Open chrome://extensions/</button>
  <p class="note">
    Make sure Zest Downloader app is running before using the extension.
  </p>
</div>
<script>
  function openExtPage() {
    // Try to open chrome extensions page
    window.open('chrome://extensions/', '_blank');
    setTimeout(() => {
      // Fallback — copy path to clipboard
      navigator.clipboard?.writeText('${extFolderPath}').catch(()=>{});
    }, 500);
  }
</script>
</body>
</html>`;

  const setupPath = path.join(outputDir, 'install-extension.html');
  fs.writeFileSync(setupPath, html, 'utf8');
  return setupPath;
}

// ─────────────────────────────────────────────
//  Main export — call this on first app launch
// ─────────────────────────────────────────────

/**
 * Smart auto-install:
 * 1. If Chrome Web Store ID is set → use registry (silent, IDM style)
 * 2. Otherwise → directly launch Chrome/Edge with the extension
 *    pre-loaded via --load-extension (zero clicks — no manual
 *    "Load unpacked" needed, no chrome://extensions navigation)
 *
 * @param {object} opts
 * @param {string} opts.extFolderPath   - path to extension/ folder
 */
async function autoInstallExtension({ extFolderPath }) {
  if (process.platform !== 'win32') return;

  const appData    = path.join(os.homedir(), 'AppData', 'Local', 'ZestDownloader');
  const flagFile   = path.join(appData, '.ext-installed');

  // Only do this once per installation
  if (fs.existsSync(flagFile)) return;

  await fs.ensureDir(appData);

  // Register native messaging host so extension can talk to app

  // If we have a Chrome Web Store ID, use registry (full IDM method —
  // fully silent, no browser window needed at all)
  if (CHROME_STORE_ID) {
    const updateUrl = `https://clients2.google.com/service/update2/crx`;
    const success   = installViaRegistry(CHROME_STORE_ID, updateUrl);
    if (success) {
      fs.writeFileSync(flagFile, new Date().toISOString());
      console.log('[ExtInstaller] Registry install done — Chrome will install on next launch');
      return;
    }
  }

  // Fallback (no Web Store publish yet) — launch the browser with the
  // extension already loaded. This is the closest thing to "automatic"
  // possible for an unpublished extension: the user does not need to
  // open chrome://extensions, enable dev mode, or click "Load unpacked".
  const launched = openBrowserWithExtension(extFolderPath);

  if (!launched) {
    // No supported browser found — fall back to the guided setup page
    const setupPage = createSetupPage(extFolderPath, appData);
    const { shell } = require('electron');
    await shell.openExternal(`file://${setupPage}`);
  }

  fs.writeFileSync(flagFile, new Date().toISOString());
  console.log('[ExtInstaller] Extension auto-load attempted on first launch');

}

// ─────────────────────────────────────────────
//  Reset (for testing — removes flag file)
// ─────────────────────────────────────────────

function resetExtensionInstallFlag() {
  const flagFile = path.join(
    os.homedir(), 'AppData', 'Local', 'ZestDownloader', '.ext-installed'
  );
  try { fs.removeSync(flagFile); } catch (_) {}
}

module.exports = {
  autoInstallExtension,
  openBrowserWithExtension,
  installViaRegistry,
  resetExtensionInstallFlag,
  findBrowser,
  findAnyBrowser,
};
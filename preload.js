const { contextBridge, ipcRenderer, webUtils } = require('electron');

// ─────────────────────────────────────────────
//  Allowed IPC channels
//  Only these can cross the main ↔ renderer bridge.
//  Every call below is routed through invoke()/send()
//  so an unlisted channel can never be reached.
// ─────────────────────────────────────────────

const INVOKE_CHANNELS = new Set([
  // HTTP downloads
  'download:add',
  'download:pause',
  'download:resume',
  'download:cancel',
  'download:retry',

  // Torrent downloads
  'torrent:add',
  'torrent:pause',
  'torrent:resume',
  'torrent:remove',
  'torrent:selectFiles',
  'torrent:setLimits',

  // Queue
  'queue:getAll',
  'queue:get',
  'queue:remove',
  'queue:clearFinished',
  'queue:stats',
  'queue:open',
  'queue:showInFolder',
  'queue:fileIcon',

  // Shell / Dialog / App
  'shell:openDownloadDir',
  'dialog:pickFolder',
  'dialog:pickTorrent',
  'app:getDefaultDir',
  'app:extensionInfo',
  'app:revealExtension',
  'app:launchBrowserWithExtension',
  'app:quit',
  'win:isMaximized',

  // Updates
  'update:check',
  'update:install',
]);

const SEND_CHANNELS = new Set([
  'win:minimize',
  'win:maximize',
  'win:close',
]);

const EVENT_CHANNELS = new Set([
  // HTTP download events
  'download:meta',
  'download:progress',
  'download:merging',
  'download:done',
  'download:paused',
  'download:error',

  // Torrent events
  'torrent:meta',
  'torrent:progress',
  'torrent:done',
  'torrent:paused',
  'torrent:resumed',
  'torrent:peer',
  'torrent:warning',
  'torrent:error',

  // App events
  'bridge:error',
  'update:available',
  'update:not-available',
  'update:download-progress',
  'update:downloaded',
  'update:error',
]);

// ─────────────────────────────────────────────
//  Guarded transports
// ─────────────────────────────────────────────

function invoke(channel, payload) {
  if (!INVOKE_CHANNELS.has(channel)) {
    return Promise.reject(new Error(`[zest] Blocked IPC channel: "${channel}"`));
  }
  return ipcRenderer.invoke(channel, payload);
}

function post(channel, payload) {
  if (!SEND_CHANNELS.has(channel)) {
    console.warn(`[zest] Blocked IPC channel: "${channel}"`);
    return;
  }
  ipcRenderer.send(channel, payload);
}

// ─────────────────────────────────────────────
//  Expose API to renderer via window.zest
// ─────────────────────────────────────────────

contextBridge.exposeInMainWorld('zest', {

  // ── HTTP Downloads ────────────────────────

  /**
   * Add a new HTTP download.
   * @param {string} url
   * @param {string} [savePath]
   * @returns {Promise<{id?: string, error?: string}>}
   */
  downloadAdd: (url, savePath) => invoke('download:add', { url, savePath }),

  /** @param {string} id */
  downloadPause: (id) => invoke('download:pause', { id }),

  /** @param {string} id */
  downloadResume: (id) => invoke('download:resume', { id }),

  /** @param {string} id */
  downloadCancel: (id) => invoke('download:cancel', { id }),

  /** @param {string} id */
  downloadRetry: (id) => invoke('download:retry', { id }),

  // ── Torrent Downloads ─────────────────────

  /**
   * Add a new torrent (magnet or .torrent file path).
   * @param {string}   source
   * @param {string}   [savePath]
   * @param {number[]} [selectFiles]  - file indices to download
   * @returns {Promise<{id: string}>}
   */
  torrentAdd: (source, savePath, selectFiles) =>
    invoke('torrent:add', { source, savePath, selectFiles }),

  /** @param {string} id */
  torrentPause: (id) => invoke('torrent:pause', { id }),

  /** @param {string} id */
  torrentResume: (id) => invoke('torrent:resume', { id }),

  /**
   * @param {string}  id
   * @param {boolean} [deleteFiles]
   */
  torrentRemove: (id, deleteFiles = false) =>
    invoke('torrent:remove', { id, deleteFiles }),

  /**
   * Change selected files for an active torrent.
   * @param {string}   id
   * @param {number[]} indices
   */
  torrentSelectFiles: (id, indices) => invoke('torrent:selectFiles', { id, indices }),

  /**
   * Set speed limits for a torrent.
   * @param {string} id
   * @param {number} [downloadLimit]  bytes/sec, 0 = unlimited
   * @param {number} [uploadLimit]    bytes/sec, 0 = unlimited
   */
  torrentSetLimits: (id, downloadLimit, uploadLimit) =>
    invoke('torrent:setLimits', { id, downloadLimit, uploadLimit }),

  // ── Queue ─────────────────────────────────

  /** @returns {Promise<object[]>} */
  queueGetAll: () => invoke('queue:getAll'),

  /** @param {string} id @returns {Promise<object|null>} */
  queueGet: (id) => invoke('queue:get', { id }),

  /** @param {string} id */
  queueRemove: (id) => invoke('queue:remove', { id }),

  /** Open a completed download file */
  queueOpen: (id) => invoke('queue:open', { id }),

  /** Show a completed download in its folder */
  queueShowInFolder: (id) => invoke('queue:showInFolder', { id }),

  /** Thumbnail or system file icon for a finished download, as a data URI */
  queueFileIcon: (id) => invoke('queue:fileIcon', { id }),

  /** Remove all done/cancelled/errored jobs */
  queueClearFinished: () => invoke('queue:clearFinished'),

  /** @returns {Promise<object>} counts per status */
  queueStats: () => invoke('queue:stats'),

  // ── Shell / Dialog ────────────────────────

  /**
   * Open a download folder in the system file manager.
   * Only folders — arbitrary file paths are no longer openable from the
   * renderer, so a hostile filename cannot be turned into "launch this".
   */
  openDownloadDir: (dirPath) => invoke('shell:openDownloadDir', { dirPath }),

  /** Show folder picker dialog @returns {Promise<string|null>} */
  pickFolder: () => invoke('dialog:pickFolder'),

  /** Show .torrent file picker @returns {Promise<string|null>} */
  pickTorrent: () => invoke('dialog:pickTorrent'),

  /** Get system default downloads directory */
  getDefaultDir: () => invoke('app:getDefaultDir'),

  /**
   * Real path of a dropped File. `File.path` was removed in Electron 32,
   * so drag & drop has to go through webUtils.
   * @param {File} file
   */
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); }
    catch (_) { return file?.path || ''; }
  },

  // ── Browser extension setup ───────────────

  /** Where the unpacked extension lives + bridge port */
  extensionInfo: () => invoke('app:extensionInfo'),

  /** Reveal the extension folder in the file manager */
  revealExtension: () => invoke('app:revealExtension'),

  /** Launch Chrome/Edge/Brave with the extension pre-loaded */
  launchBrowserWithExtension: () => invoke('app:launchBrowserWithExtension'),

  // ── Window controls ───────────────────────

  winMinimize:    () => post('win:minimize'),
  winMaximize:    () => post('win:maximize'),
  winClose:       () => post('win:close'),
  winIsMaximized: () => invoke('win:isMaximized'),
  quitApp:        () => invoke('app:quit'),

  // ── Updates ───────────────────────────────

  checkForUpdates: () => invoke('update:check'),
  installUpdate:   () => invoke('update:install'),

  // ── Event listeners ───────────────────────

  /**
   * Subscribe to a main-process event.
   * Returns an unsubscribe function.
   *
   * @param {string}   channel
   * @param {Function} callback
   * @returns {Function} unsubscribe
   *
   * @example
   * const off = window.zest.on('download:progress', (data) => console.log(data));
   * // later:
   * off();
   */
  on(channel, callback) {
    if (!EVENT_CHANNELS.has(channel)) {
      console.warn(`[zest] Unknown event channel: "${channel}"`);
      return () => {};
    }
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);

    // Return unsubscribe function
    return () => ipcRenderer.removeListener(channel, handler);
  },

  /**
   * Subscribe to an event only once.
   * @param {string}   channel
   * @param {Function} callback
   */
  once(channel, callback) {
    if (!EVENT_CHANNELS.has(channel)) {
      console.warn(`[zest] Unknown event channel: "${channel}"`);
      return;
    }
    ipcRenderer.once(channel, (_event, data) => callback(data));
  },
});

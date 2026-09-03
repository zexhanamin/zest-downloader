/**
 * ESLint 9 flat config.
 *
 * Three environments live in this repo and each has a different global
 * surface, so they are configured separately rather than with one loose
 * catch-all that would miss real typos.
 */
'use strict';

const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable',
  process: 'readonly', __dirname: 'readonly', __filename: 'readonly',
  Buffer: 'readonly', console: 'readonly', URL: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  AbortController: 'readonly', fetch: 'readonly',
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  localStorage: 'readonly', console: 'readonly', URL: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', MutationObserver: 'readonly',
  File: 'readonly', Element: 'readonly', AbortController: 'readonly',
  fetch: 'readonly', location: 'readonly',
};

const sharedRules = {
  // `catch (_)` is the convention throughout this codebase
  'no-unused-vars': ['warn', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
  'no-undef': 'error',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'prefer-const': 'warn',
  eqeqeq: ['warn', 'smart'],
};

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'test/**'],
  },
  {
    // Electron main process + modules it loads
    files: ['main.js', 'preload.js', 'src/config.js', 'src/downloader.js',
            'src/queue.js', 'src/torrent.js', 'src/updater.js',
            'src/extension-installer.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: sharedRules,
  },
  {
    // Renderer — runs in the BrowserWindow, no Node globals
    files: ['src/renderer.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: browserGlobals,
    },
    rules: sharedRules,
  },
  {
    // Browser extension — MV3 service worker, content script, popup
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...browserGlobals, chrome: 'readonly', self: 'readonly' },
    },
    rules: sharedRules,
  },
];

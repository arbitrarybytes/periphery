'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    // src-tauri/target holds Rust build output, including generated JS assets
    // that are not ours to lint. build/ holds generated images.
    ignores: ['node_modules/**', 'src-tauri/target/**', 'dist/**', 'build/**'],
  },
  {
    // Main process, connectors, stores, server, tests: plain Node CommonJS.
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Express error middleware and event handlers need fixed arity.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Sandboxed renderer scripts: browser globals plus the preload bridges.
    // bridge.js is the shell adapter and runs in the same context.
    files: ['ui/bridge.js', 'ui/renderer.js', 'ui/settings.js', 'ui/onboarding.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // The static landing page (docs/ = GitHub Pages) runs in a plain browser.
    files: ['docs/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
  {
    // Preloads run in Electron's bridged context: Node require + browser window.
    files: ['preload.js', 'preload-settings.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];

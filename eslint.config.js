'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    ignores: ['node_modules/**'],
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
    files: ['renderer.js', 'settings.js'],
    languageOptions: {
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

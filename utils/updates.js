'use strict';

/**
 * Auto-update wiring (electron-updater over the NSIS build; see ai-native/ADR.md
 * ADR 3). On-brand delivery: no dialogs — an update downloads in the
 * background and announces itself as one quiet cue; it installs on quit.
 *
 * Everything is guarded: updates only run from a packaged build, only while
 * the feature toggle is on, and a missing/broken electron-updater module can
 * never take the app down.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * @param {object} options
 * @param {boolean} options.isPackaged - app.isPackaged; dev runs never update
 * @param {() => boolean} options.isEnabled - the autoUpdateEnabled toggle, read per check
 * @param {(payload: object) => void} options.onCue - quiet "update ready" announcement
 * @param {number} [options.checkIntervalMs]
 * @param {object} [options.updater] - injectable for tests; defaults to electron-updater's autoUpdater
 * @returns {{start: () => void, stop: () => void}}
 */
function createAutoUpdate({ isPackaged, isEnabled, onCue, checkIntervalMs = CHECK_INTERVAL_MS, updater }) {
  let timerId = null;

  function resolveUpdater() {
    if (updater) return updater;
    try {
      return require('electron-updater').autoUpdater;
    } catch (err) {
      console.error('[Updates] electron-updater unavailable; auto-update disabled.', err.message);
      return null;
    }
  }

  function check(autoUpdater) {
    if (!isEnabled()) return;
    autoUpdater.checkForUpdates().catch((err) => {
      // Offline, feed unreachable, etc. — routine, and never worth a cue.
      console.error('[Updates] Check failed:', err.message);
    });
  }

  return {
    start() {
      if (!isPackaged || timerId) return;
      const autoUpdater = resolveUpdater();
      if (!autoUpdater) return;

      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true; // installs silently on quit
      autoUpdater.on('update-downloaded', (info) => {
        onCue({
          cue: 'glow-bottom',
          msg: `Periphery ${info?.version || 'update'} is ready — installs when you quit`,
          icon: 'alert',
        });
      });
      autoUpdater.on('error', (err) => console.error('[Updates] Updater error:', err.message));

      check(autoUpdater);
      timerId = setInterval(() => check(autoUpdater), checkIntervalMs);
      if (typeof timerId.unref === 'function') timerId.unref();
    },
    stop() {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
    },
  };
}

module.exports = { createAutoUpdate, CHECK_INTERVAL_MS };

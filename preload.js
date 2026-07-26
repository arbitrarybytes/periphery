'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Overlay bridge. The renderer gets exactly one capability — being told about
 * a cue — instead of the full Node API it had under nodeIntegration.
 */
contextBridge.exposeInMainWorld('periphery', {
  /**
   * @param {(payload: object) => void} handler
   */
  onCue(handler) {
    ipcRenderer.on('trigger-cue', (event, payload) => handler(payload));
  },
  /**
   * Presentation hints from the main process: the OS accent colour and
   * whether the machine is on battery (which selects the low-power profile).
   * @param {(theme: object) => void} handler
   */
  onTheme(handler) {
    ipcRenderer.on('set-theme', (event, theme) => handler(theme));
  },
  /**
   * Constellation state: the cues currently held by focus mode, rendered as
   * dim stars. An empty list fades the stars out.
   * @param {(data: object) => void} handler
   */
  onConstellation(handler) {
    ipcRenderer.on('constellation', (event, data) => handler(data));
  },
});

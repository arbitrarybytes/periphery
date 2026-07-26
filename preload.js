'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Overlay bridge. The renderer gets exactly one capability — being told about
 * a cue — instead of the full Node API it had under nodeIntegration.
 */
contextBridge.exposeInMainWorld('flowstate', {
  /**
   * @param {(payload: object) => void} handler
   */
  onCue(handler) {
    ipcRenderer.on('trigger-cue', (event, payload) => handler(payload));
  },
});

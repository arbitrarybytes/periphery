'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Settings bridge. Note that no method can read a stored secret back out —
 * `getConfig` only reports whether one is present.
 */
contextBridge.exposeInMainWorld('peripherySettings', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  /** @param {object} config */
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  /** @param {'gitlabPat'|'githubPat'|'outlookToken'} field */
  clearSecret: (field) => ipcRenderer.invoke('clear-secret', field),
  /** @param {string} cue */
  sendTestCue: (cue) => ipcRenderer.invoke('send-test-cue', cue),
});

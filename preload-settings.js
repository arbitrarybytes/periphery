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
  /**
   * Live connector-health pushes while the window is open.
   * @param {(issues: object[]) => void} handler
   */
  onConnectorHealth(handler) {
    ipcRenderer.on('connector-health', (event, issues) => handler(issues));
  },

  // Projects: same registry and detection the onboarding wizard uses, so
  // Settings and setup can never show different hook states.
  listProjects: () => ipcRenderer.invoke('projects-list'),
  addProject: () => ipcRenderer.invoke('projects-add'),
  /** @param {string} dir */
  removeProject: (dir) => ipcRenderer.invoke('projects-remove', dir),
  /** @param {{dir: string, gitHook?: boolean, npmScripts?: boolean}} options */
  wireProject: (options) => ipcRenderer.invoke('projects-wire', options),
});

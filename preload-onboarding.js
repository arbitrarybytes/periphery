'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Onboarding bridge. The wizard can fire a test cue, ask the main process to
 * detect and wire a project folder, and mark onboarding done — nothing else.
 * All filesystem work happens in the main process behind these calls.
 */
contextBridge.exposeInMainWorld('peripheryOnboarding', {
  /** @param {string} cue */
  sendTestCue: (cue) => ipcRenderer.invoke('send-test-cue', cue),
  /** Opens the folder picker; resolves to a detection result or null. */
  pickProject: () => ipcRenderer.invoke('onboarding-pick-project'),
  /** @param {{dir: string, gitHook: boolean, npmScripts: boolean}} options */
  apply: (options) => ipcRenderer.invoke('onboarding-apply', options),
  finish: () => ipcRenderer.invoke('onboarding-finish'),
});

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
  /**
   * The user is back at the keyboard: fade all agent beacons, replaying each
   * one's message pill once on the way out.
   * @param {() => void} handler
   */
  onAgentAck(handler) {
    ipcRenderer.on('agent-ack', () => handler());
  },
  /**
   * Digest panel content (end-of-focus, or "while you were away").
   * @param {(data: object) => void} handler
   */
  onDigest(handler) {
    ipcRenderer.on('digest', (event, data) => handler(data));
  },
  /**
   * Blocked-agent state: how many agents are waiting on approval and how
   * insistent the beacon should be. A count of 0 fades it out.
   * @param {(state: object) => void} handler
   */
  onBlocked(handler) {
    ipcRenderer.on('blocked-agents', (event, state) => handler(state));
  },
  /**
   * Asks the main process for real mouse events while the pointer is over
   * the digest panel; false restores the overlay's click-through state.
   * @param {boolean} interactive
   */
  setDigestInteractive(interactive) {
    ipcRenderer.send('digest-interactive', interactive === true);
  },
});

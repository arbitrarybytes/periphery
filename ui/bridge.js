'use strict';

/**
 * Shell adapter. Gives the frontend one API — `window.periphery` — regardless
 * of whether it is running under Electron or Tauri.
 *
 * Periphery ships as two editions of one product (see ai-native/versioning.md),
 * and `ui/` is shared between them verbatim. That sharing is what stops the two
 * from drifting into genuinely different apps, but it only works if the
 * frontend never has to know which shell it is inside. This file is where that
 * knowledge stops.
 *
 * Under Electron, `preload.js` has already defined `window.periphery` by the
 * time this runs, so this is a no-op. Under Tauri there is no preload, so the
 * same surface is rebuilt from the event and command APIs.
 *
 * Loaded before every other script. Must stay dependency-free.
 */

(() => {
  // Progress marker. A silent failure here leaves the whole overlay inert, and
  // "no cue appeared" looks identical to "the shell never sent one", so record
  // how far this got.
  window.__peripheryBridge = 'started';

  // Electron's contextBridge got there first; nothing to do.
  if (window.periphery) {
    window.__peripheryBridge = 'electron';
    return;
  }

  const tauri = window.__TAURI__;
  if (!tauri) {
    // Neither shell. Opening the page directly in a browser is a legitimate
    // way to inspect the markup, so say so once rather than throwing.
    console.warn('[Bridge] No Periphery shell detected; cues will not arrive.');
    window.periphery = {
      onCue() {},
      onTheme() {},
      onConstellation() {},
      onAgentAck() {},
      onDigest() {},
      onBlocked() {},
      setDigestInteractive() {},
    };
    return;
  }

  const { listen } = tauri.event;
  const { invoke } = tauri.core;

  /**
   * Tauri delivers `{ payload }`; Electron's preload already unwrapped it.
   * Normalising here keeps the renderer free of shell-shaped conditionals.
   * @param {string} name
   * @param {(payload: unknown) => void} handler
   */
  const on = (name, handler) => {
    listen(name, (event) => handler(event.payload));
  };

  window.periphery = {
    onCue(handler) { on('trigger-cue', handler); },
    onTheme(handler) { on('set-theme', handler); },
    onConstellation(handler) { on('constellation', handler); },
    onDigest(handler) { on('digest', handler); },
    onBlocked(handler) { on('blocked-agents', handler); },

    // Carries no payload: the renderer only needs to know that it happened.
    onAgentAck(handler) { on('agent-ack', () => handler()); },

    setDigestInteractive(interactive) {
      // Fire-and-forget, exactly like Electron's ipcRenderer.send. A rejection
      // here would mean the overlay stays click-through, which is the safe
      // failure — so it is logged rather than propagated.
      invoke('set_digest_interactive', { interactive: interactive === true })
        .catch((err) => console.error('[Bridge] set_digest_interactive failed', err));
    },
  };

  window.__peripheryBridge = 'tauri';
})();

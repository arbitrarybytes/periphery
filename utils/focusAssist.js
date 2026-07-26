'use strict';

const { execFile } = require('node:child_process');

const { isDoNotDisturb } = require('./win11');

const DEFAULT_INTERVAL_MS = 45 * 1000;
const PROBE_TIMEOUT_MS = 10 * 1000;

/**
 * PowerShell probe for `SHQueryUserNotificationState` — the supported shell
 * API behind "would Windows show a toast right now". It reflects Focus
 * Assist / Do Not Disturb, presentation mode, and full-screen apps, without
 * requiring a native Node module or the fragile CloudStore registry blobs.
 */
const PROBE_SCRIPT = [
  'Add-Type -Namespace FlowState -Name Shell -MemberDefinition',
  '\'[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);\';',
  '$s = 0;',
  '[void][FlowState.Shell]::SHQueryUserNotificationState([ref]$s);',
  '$s',
].join(' ');

/**
 * Polls the Windows notification state and reports transitions. The probe is
 * best-effort: on any spawn or parse failure the last known state is kept, so
 * a missing PowerShell can never break cue delivery.
 */
class FocusAssistMonitor {
  /**
   * @param {object} options
   * @param {(dnd: boolean) => void} options.onChange - called on every transition
   * @param {number} [options.intervalMs]
   * @param {typeof execFile} [options.exec] - injectable for tests
   */
  constructor({ onChange, intervalMs = DEFAULT_INTERVAL_MS, exec = execFile }) {
    this.onChange = onChange;
    this.intervalMs = intervalMs;
    this.exec = exec;
    this.timerId = null;
    this.dnd = false;
  }

  start() {
    if (this.timerId) return;
    this._probe();
    this.timerId = setInterval(() => this._probe(), this.intervalMs);
    // A background poll must not hold the process open on quit.
    if (typeof this.timerId.unref === 'function') this.timerId.unref();
  }

  /** Stops polling and reports "not disturbed", so held cues get flushed. */
  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this._set(false);
  }

  _probe() {
    this.exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PROBE_SCRIPT],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) return;
        const state = Number.parseInt(String(stdout).trim(), 10);
        if (Number.isNaN(state)) return;
        this._set(isDoNotDisturb(state));
      },
    );
  }

  /** @param {boolean} dnd */
  _set(dnd) {
    if (dnd === this.dnd) return;
    this.dnd = dnd;
    this.onChange(dnd);
  }
}

module.exports = { FocusAssistMonitor, PROBE_SCRIPT, DEFAULT_INTERVAL_MS };

'use strict';

const { spawn } = require('node:child_process');

const { isDoNotDisturb } = require('./win11');

const DEFAULT_INTERVAL_MS = 45 * 1000;

/**
 * PowerShell probe for `SHQueryUserNotificationState` — the supported shell
 * API behind "would Windows show a toast right now". It reflects Focus
 * Assist / Do Not Disturb, presentation mode, and full-screen apps, without
 * requiring a native Node module or the fragile CloudStore registry blobs.
 *
 * One persistent child runs the loop: the P/Invoke stub compiles once and
 * each poll is a bare syscall. Spawning a fresh powershell.exe per probe
 * would pay cold start plus an Add-Type compile (~1s of CPU) every interval.
 * @param {number} intervalSeconds
 * @returns {string}
 */
function probeScript(intervalSeconds) {
  return [
    'Add-Type -Namespace Periphery -Name Shell -MemberDefinition',
    '\'[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);\';',
    'while ($true) {',
    '$s = 0;',
    '[void][Periphery.Shell]::SHQueryUserNotificationState([ref]$s);',
    '[Console]::Out.WriteLine($s);',
    `Start-Sleep -Seconds ${intervalSeconds};`,
    '}',
  ].join(' ');
}

/**
 * Watches the Windows notification state and reports transitions. Best
 * effort: a failed or garbled probe keeps the last known state, so a missing
 * PowerShell can never break cue delivery.
 */
class FocusAssistMonitor {
  /**
   * @param {object} options
   * @param {(dnd: boolean) => void} options.onChange - called on every transition
   * @param {number} [options.intervalMs]
   * @param {typeof spawn} [options.spawn] - injectable for tests
   */
  constructor({ onChange, intervalMs = DEFAULT_INTERVAL_MS, spawn: spawnFn = spawn }) {
    this.onChange = onChange;
    this.intervalMs = intervalMs;
    this.spawn = spawnFn;
    this.child = null;
    this.respawnTimer = null;
    this.running = false;
    this.dnd = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._spawnChild();
  }

  /** Stops probing and reports "not disturbed", so held cues get flushed. */
  stop() {
    this.dispose();
    this._set(false);
  }

  /**
   * Stops probing without reporting a state change. For shutdown, where
   * stop()'s flush would fire a summary cue into windows being torn down.
   */
  dispose() {
    this.running = false;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  _spawnChild() {
    const intervalSeconds = Math.max(1, Math.round(this.intervalMs / 1000));
    let child;
    try {
      child = this.spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', probeScript(intervalSeconds)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      return;
    }
    this.child = child;

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const state = Number.parseInt(line.trim(), 10);
        if (!Number.isNaN(state)) this._set(isDoNotDisturb(state));
      }
    });

    child.on('error', () => {});
    child.on('exit', () => {
      if (this.child !== child) return; // superseded or disposed
      this.child = null;
      if (!this.running) return;
      // PowerShell missing or killed externally: retry after one interval.
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        this._spawnChild();
      }, this.intervalMs);
      if (typeof this.respawnTimer.unref === 'function') this.respawnTimer.unref();
    });
  }

  /** @param {boolean} dnd */
  _set(dnd) {
    if (dnd === this.dnd) return;
    this.dnd = dnd;
    this.onChange(dnd);
  }
}

module.exports = { FocusAssistMonitor };

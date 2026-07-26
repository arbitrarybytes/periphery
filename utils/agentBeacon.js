'use strict';

/**
 * Acknowledgment watcher for persistent agent cues (`glow-agent`).
 *
 * The beacon exists so a coding agent's "task complete" is known even when
 * the dev misses the moment it fired: it keeps breathing in the corner until
 * someone is demonstrably back at the keyboard. This watcher decides when
 * that has happened. A beacon is acknowledged when:
 *
 *   - it has been visible for at least `minVisibleMs` (so a dev who was
 *     present the whole time still gets a real look at it), AND
 *   - the user is active right now (input idle below `activeIdleSeconds`),
 *
 * or unconditionally after `maxLingerMs`, purely as an OLED-burn-in guard.
 * A dev who is away for hours keeps the beacon for hours — that is the point.
 *
 * Pure logic — no Electron. The host injects `getIdleSeconds` (from
 * powerMonitor.getSystemIdleTime) and `onAcknowledge` (the overlay broadcast,
 * which fades the beacons and replays their message pills once).
 */

/** Minimum time a beacon stays up, even with the user at the keyboard. */
const MIN_VISIBLE_MS = 45 * 1000;
/** Input idle below this means "someone is at the keyboard right now". */
const ACTIVE_IDLE_SECONDS = 5;
/** Absolute cap, only to spare the panel a day-long standing animation. */
const MAX_LINGER_MS = 2 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5000;

class AgentAckWatcher {
  /**
   * @param {object} options
   * @param {() => number} options.getIdleSeconds - seconds since last input
   * @param {() => void} options.onAcknowledge - called once per pending batch
   * @param {() => number} [options.now] - injectable clock for tests
   * @param {number} [options.minVisibleMs]
   * @param {number} [options.activeIdleSeconds]
   * @param {number} [options.maxLingerMs]
   * @param {number} [options.checkIntervalMs]
   */
  constructor({
    getIdleSeconds,
    onAcknowledge,
    now = Date.now,
    minVisibleMs = MIN_VISIBLE_MS,
    activeIdleSeconds = ACTIVE_IDLE_SECONDS,
    maxLingerMs = MAX_LINGER_MS,
    checkIntervalMs = CHECK_INTERVAL_MS,
  }) {
    this.getIdleSeconds = getIdleSeconds;
    this.onAcknowledge = onAcknowledge;
    this.now = now;
    this.minVisibleMs = minVisibleMs;
    this.activeIdleSeconds = activeIdleSeconds;
    this.maxLingerMs = maxLingerMs;
    this.checkIntervalMs = checkIntervalMs;

    this.pending = 0;
    /** When the oldest unacknowledged beacon was delivered. */
    this.oldestAt = 0;
    this.timerId = null;
  }

  /** Call when a `glow-agent` cue is broadcast to the overlay. */
  notifyDelivered() {
    if (this.pending === 0) this.oldestAt = this.now();
    this.pending += 1;
    this._ensureTimer();
  }

  /** Drives one acknowledgment check; exposed for tests. */
  check() {
    if (this.pending === 0) {
      this._clearTimer();
      return;
    }
    const elapsed = this.now() - this.oldestAt;
    const userIsBack = elapsed >= this.minVisibleMs
      && this.getIdleSeconds() < this.activeIdleSeconds;
    if (userIsBack || elapsed >= this.maxLingerMs) {
      this.pending = 0;
      this._clearTimer();
      this.onAcknowledge();
    }
  }

  /** Drops pending state without acknowledging (shutdown). */
  stop() {
    this._clearTimer();
    this.pending = 0;
  }

  _ensureTimer() {
    if (this.timerId) return;
    this.timerId = setInterval(() => this.check(), this.checkIntervalMs);
    if (typeof this.timerId.unref === 'function') this.timerId.unref();
  }

  _clearTimer() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }
}

module.exports = {
  AgentAckWatcher,
  MIN_VISIBLE_MS,
  ACTIVE_IDLE_SECONDS,
  MAX_LINGER_MS,
};

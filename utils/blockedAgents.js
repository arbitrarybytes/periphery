'use strict';

/**
 * Blocked-agent tracking with age-based escalation.
 *
 * An agent waiting for approval is the most expensive kind of stall. A
 * *finished* task merely waits to be noticed — the cost of missing it is
 * bounded. A *blocked* task burns wall-clock for work already in flight, and
 * that cost compounds every second. So the cue's insistence compounds with it.
 *
 * Escalation is deliberately bounded at level 2. It gets brighter, larger, and
 * more rhythmic — it never becomes a comet, never makes a sound, and never
 * covers anything. The goal is "progressively harder to ignore in peripheral
 * vision", not "alarm".
 *
 * The critical difference from the completion beacon (utils/agentBeacon.js):
 * returning to the keyboard does NOT clear a blocked cue. Presence is not
 * approval. It clears only when the agent reports itself unblocked, when the
 * user dismisses it, or after a long safety timeout that assumes the agent
 * died holding the lock.
 *
 * Pure logic — no Electron — so the escalation curve is unit-tested.
 */

/** Age at which the cue moves from "subtle" to "noticeable". */
const LEVEL_1_MS = 60 * 1000;
/** Age at which it becomes insistent — real time is now being wasted. */
const LEVEL_2_MS = 4 * 60 * 1000;
/** Safety valve: an agent this stale is presumed dead, not waiting. */
const MAX_AGE_MS = 60 * 60 * 1000;
const TICK_MS = 5000;
/** Bound on tracked entries; a fleet larger than this collapses into a count. */
const MAX_ENTRIES = 12;

class BlockedAgentTracker {
  /**
   * @param {object} options
   * @param {(state: object) => void} options.onChange - called when the count
   *   or escalation level changes (not on every tick)
   * @param {() => number} [options.now] - injectable clock for tests
   * @param {number} [options.tickMs]
   * @param {number} [options.level1Ms]
   * @param {number} [options.level2Ms]
   * @param {number} [options.maxAgeMs]
   */
  constructor({
    onChange,
    now = Date.now,
    tickMs = TICK_MS,
    level1Ms = LEVEL_1_MS,
    level2Ms = LEVEL_2_MS,
    maxAgeMs = MAX_AGE_MS,
  }) {
    this.onChange = onChange;
    this.now = now;
    this.tickMs = tickMs;
    this.level1Ms = level1Ms;
    this.level2Ms = level2Ms;
    this.maxAgeMs = maxAgeMs;

    /** @type {Map<string, {ref: string, msg: string|null, color: string|null, at: number}>} */
    this.entries = new Map();
    this.timerId = null;
    this.lastLevel = 0;
    this.autoRef = 0;
  }

  /**
   * Registers a blocked agent, or refreshes one already tracked.
   * @param {{ref?: string, msg?: string, color?: string}} payload - validated
   * @returns {string} the ref, so a caller can resolve it later
   */
  block(payload = {}) {
    const ref = typeof payload.ref === 'string' && payload.ref.length > 0
      ? payload.ref
      : `auto-${++this.autoRef}`;

    const existing = this.entries.get(ref);
    if (existing) {
      // A re-ping of the same block is the *same* stall: refresh the wording,
      // never reset the clock, or an agent that repeats itself would escalate
      // forever without ever getting more urgent.
      existing.msg = typeof payload.msg === 'string' ? payload.msg : existing.msg;
      return ref;
    }

    if (this.entries.size >= MAX_ENTRIES) {
      // Drop the newest-but-one rather than the oldest: escalation is driven
      // by the oldest entry, which is the one actually costing time.
      const newest = [...this.entries.keys()].pop();
      this.entries.delete(newest);
    }

    this.entries.set(ref, {
      ref,
      msg: typeof payload.msg === 'string' ? payload.msg : null,
      color: typeof payload.color === 'string' ? payload.color : null,
      at: this.now(),
    });
    this._ensureTimer();
    this._announce();
    return ref;
  }

  /**
   * @param {string} ref
   * @returns {boolean} whether something was actually cleared
   */
  resolve(ref) {
    if (!this.entries.delete(ref)) return false;
    this._announce();
    return true;
  }

  /**
   * Clears everything (agent said "all clear", or the user dismissed).
   * @returns {number} how many were cleared
   */
  resolveAll() {
    const count = this.entries.size;
    if (count === 0) return 0;
    this.entries.clear();
    this._announce();
    return count;
  }

  /** @returns {number} 0 (subtle) | 1 (noticeable) | 2 (insistent) */
  level() {
    const oldest = this._oldestAt();
    if (oldest === null) return 0;
    const age = this.now() - oldest;
    if (age >= this.level2Ms) return 2;
    if (age >= this.level1Ms) return 1;
    return 0;
  }

  count() {
    return this.entries.size;
  }

  /**
   * The payload the overlay renders from.
   * @returns {{count: number, level: number, entries: Array<object>}}
   */
  state() {
    return {
      count: this.entries.size,
      level: this.level(),
      entries: [...this.entries.values()].map((entry) => ({
        ref: entry.ref,
        msg: entry.msg,
        color: entry.color,
        at: entry.at,
      })),
    };
  }

  /**
   * One escalation tick: drops abandoned entries, re-announces on a level
   * change. Exposed for tests.
   */
  tick() {
    const cutoff = this.now() - this.maxAgeMs;
    let expired = false;
    for (const [ref, entry] of this.entries) {
      if (entry.at <= cutoff) {
        this.entries.delete(ref);
        expired = true;
      }
    }
    if (expired) {
      this._announce();
      return;
    }
    if (this.entries.size === 0) {
      this._clearTimer();
      return;
    }
    if (this.level() !== this.lastLevel) this._announce();
  }

  /** Drops everything without announcing (shutdown). */
  stop() {
    this._clearTimer();
    this.entries.clear();
  }

  _oldestAt() {
    let oldest = null;
    for (const entry of this.entries.values()) {
      if (oldest === null || entry.at < oldest) oldest = entry.at;
    }
    return oldest;
  }

  _announce() {
    this.lastLevel = this.level();
    if (this.entries.size === 0) this._clearTimer();
    this.onChange(this.state());
  }

  _ensureTimer() {
    if (this.timerId) return;
    this.timerId = setInterval(() => this.tick(), this.tickMs);
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
  BlockedAgentTracker,
  LEVEL_1_MS,
  LEVEL_2_MS,
  MAX_AGE_MS,
  MAX_ENTRIES,
};

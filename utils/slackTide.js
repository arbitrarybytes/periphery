'use strict';

/**
 * Slack-tide delivery: ambient (tier 2-3) cues are held while the user is in
 * a burst of keyboard/mouse activity and released in the next natural
 * micro-pause, so a notification lands exactly when attention is already
 * loose. Named for the moment between tides when the water goes still.
 *
 * Pure logic — no Electron. The host injects `getIdleSeconds` (from
 * powerMonitor.getSystemIdleTime) and `deliver` (the overlay broadcast).
 */

/** Idle gap that counts as a natural pause worth delivering into. */
const PAUSE_SECONDS = 6;
/** Never hold a cue longer than this, pause or no pause. */
const MAX_HOLD_MS = 90 * 1000;
const CHECK_INTERVAL_MS = 2000;
/** Gap between cues released from the same pause, so pills don't pile up. */
const STAGGER_MS = 1500;
const MAX_QUEUE = 12;

class SlackTideQueue {
  /**
   * @param {object} options
   * @param {(payload: object) => void} options.deliver
   * @param {() => number} options.getIdleSeconds - seconds since last input
   * @param {() => number} [options.now] - injectable clock for tests
   * @param {number} [options.pauseSeconds]
   * @param {number} [options.maxHoldMs]
   * @param {number} [options.checkIntervalMs]
   * @param {number} [options.staggerMs] - 0 delivers synchronously (tests)
   * @param {number} [options.maxQueue]
   */
  constructor({
    deliver,
    getIdleSeconds,
    now = Date.now,
    pauseSeconds = PAUSE_SECONDS,
    maxHoldMs = MAX_HOLD_MS,
    checkIntervalMs = CHECK_INTERVAL_MS,
    staggerMs = STAGGER_MS,
    maxQueue = MAX_QUEUE,
  }) {
    this.deliver = deliver;
    this.getIdleSeconds = getIdleSeconds;
    this.now = now;
    this.pauseSeconds = pauseSeconds;
    this.maxHoldMs = maxHoldMs;
    this.checkIntervalMs = checkIntervalMs;
    this.staggerMs = staggerMs;
    this.maxQueue = maxQueue;

    /** @type {Array<{payload: object, heldAt: number}>} */
    this.queue = [];
    /** Cues dropped once the queue is full, reported as one "+N more". */
    this.overflow = 0;
    this.timerId = null;
    this.staggerTimers = new Set();
  }

  size() {
    return this.queue.length + this.overflow;
  }

  /**
   * Routes one cue: delivered immediately when the user is already pausing,
   * otherwise held for the next pause.
   * @param {object} payload - already validated by the caller
   * @returns {boolean} whether the cue was held
   */
  push(payload) {
    if (this.getIdleSeconds() >= this.pauseSeconds) {
      this.deliver(payload);
      return false;
    }
    if (this.queue.length >= this.maxQueue) {
      this.overflow += 1;
    } else {
      this.queue.push({ payload, heldAt: this.now() });
    }
    this._ensureTimer();
    return true;
  }

  /** Releases everything, oldest first, spaced by staggerMs. */
  flush() {
    const payloads = this.queue.map((entry) => entry.payload);
    if (this.overflow > 0) {
      // No color: the renderer falls back to the OS accent.
      payloads.push({
        cue: 'glow-bottom',
        msg: `+${this.overflow} more update${this.overflow === 1 ? '' : 's'}`,
      });
    }
    this.queue = [];
    this.overflow = 0;
    this._clearTimer();

    payloads.forEach((payload, i) => {
      if (i === 0 || this.staggerMs === 0) {
        this.deliver(payload);
        return;
      }
      const timer = setTimeout(() => {
        this.staggerTimers.delete(timer);
        this.deliver(payload);
      }, i * this.staggerMs);
      this.staggerTimers.add(timer);
    });
  }

  /** Drops everything without delivering (shutdown). */
  stop() {
    this._clearTimer();
    for (const timer of this.staggerTimers) clearTimeout(timer);
    this.staggerTimers.clear();
    this.queue = [];
    this.overflow = 0;
  }

  _ensureTimer() {
    if (this.timerId) return;
    this.timerId = setInterval(() => this._check(), this.checkIntervalMs);
    if (typeof this.timerId.unref === 'function') this.timerId.unref();
  }

  _clearTimer() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  _check() {
    if (this.size() === 0) {
      this._clearTimer();
      return;
    }
    const oldestHeldAt = this.queue.length > 0 ? this.queue[0].heldAt : this.now();
    const overdue = this.now() - oldestHeldAt >= this.maxHoldMs;
    if (overdue || this.getIdleSeconds() >= this.pauseSeconds) {
      this.flush();
    }
  }
}

module.exports = {
  SlackTideQueue,
  PAUSE_SECONDS,
  MAX_HOLD_MS,
  STAGGER_MS,
  MAX_QUEUE,
};

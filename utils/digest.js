'use strict';

/**
 * Digest bookkeeping: what arrived while the user was focused (end-of-focus
 * digest) or locked ("while you were away"). The main process appends
 * already-validated cue payloads; the renderer gets a small list it can show
 * in the expandable digest panel.
 *
 * Pure logic — no Electron — so it stays unit-testable and portable.
 */

/** Most entries a digest keeps; beyond this the oldest are dropped but counted. */
const DIGEST_MAX_ENTRIES = 50;
/** A lock shorter than this is a coffee refill, not an absence worth a summary. */
const AWAY_THRESHOLD_MS = 30 * 60 * 1000;

class DigestLog {
  /**
   * @param {object} [options]
   * @param {number} [options.maxEntries]
   * @param {() => number} [options.now] - injectable clock for tests
   */
  constructor({ maxEntries = DIGEST_MAX_ENTRIES, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    /** @type {Array<{msg: string|null, icon: string|null, color: string|null, at: number}>} */
    this.entries = [];
    /** Entries dropped once full; still reported in the total. */
    this.dropped = 0;
  }

  /**
   * Records one delivered-or-held cue. Payloads are already validated by
   * utils/cuePayload.js, so fields are trusted here.
   * @param {{msg?: string, icon?: string, color?: string}} payload
   */
  add(payload) {
    if (this.entries.length >= this.maxEntries) {
      this.entries.shift();
      this.dropped += 1;
    }
    this.entries.push({
      msg: typeof payload.msg === 'string' ? payload.msg : null,
      icon: typeof payload.icon === 'string' ? payload.icon : null,
      color: typeof payload.color === 'string' ? payload.color : null,
      at: this.now(),
    });
  }

  size() {
    return this.entries.length + this.dropped;
  }

  /**
   * Returns everything recorded and resets the log.
   * @returns {{entries: Array<object>, total: number}}
   */
  drain() {
    const result = { entries: this.entries, total: this.size() };
    this.entries = [];
    this.dropped = 0;
    return result;
  }
}

/**
 * Tracks screen locks so an unlock after a long absence can be greeted with
 * a "while you were away" digest instead of nothing.
 */
class AwayTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.thresholdMs] - minimum lock length that counts as away
   * @param {() => number} [options.now] - injectable clock for tests
   */
  constructor({ thresholdMs = AWAY_THRESHOLD_MS, now = Date.now } = {}) {
    this.thresholdMs = thresholdMs;
    this.now = now;
    /** @type {number|null} */
    this.lockedAt = null;
  }

  lock() {
    // A second lock event without an unlock keeps the original timestamp.
    if (this.lockedAt === null) this.lockedAt = this.now();
  }

  isLocked() {
    return this.lockedAt !== null;
  }

  /**
   * @returns {{away: boolean, awayMs: number}} whether the lock was long
   *   enough to count as an absence
   */
  unlock() {
    if (this.lockedAt === null) return { away: false, awayMs: 0 };
    const awayMs = this.now() - this.lockedAt;
    this.lockedAt = null;
    return { away: awayMs >= this.thresholdMs, awayMs };
  }
}

module.exports = {
  DigestLog,
  AwayTracker,
  DIGEST_MAX_ENTRIES,
  AWAY_THRESHOLD_MS,
};

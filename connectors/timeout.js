'use strict';

const BaseConnector = require('./BaseConnector');

const DEFAULT_DURATION_MS = 25 * 60 * 1000; // Pomodoro default
const MIN_DURATION_MS = 60 * 1000;

/**
 * Timeout Connector
 * A simple timer that reminds the user to take a break after a specified duration.
 * Config expects:
 * - durationMs: Milliseconds before triggering the break reminder
 * - cueName: The cue to trigger (see utils/cuePayload.js CUE_NAMES)
 * - color: The color of the cue
 * - message: The message to display
 */
class TimeoutConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.timerId = null;

    const requested = Number(config.durationMs);
    // A sub-minute reminder is never intentional and would spam the overlay.
    this.durationMs = Number.isFinite(requested) && requested >= MIN_DURATION_MS
      ? requested
      : DEFAULT_DURATION_MS;
  }

  start() {
    super.start();
    this._scheduleNext();
  }

  stop() {
    super.stop();
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  _scheduleNext() {
    if (!this.isRunning) return;

    this.timerId = setTimeout(() => {
      this.triggerCue({
        cue: this.config.cueName || 'comet',
        color: this.config.color || 'rgba(0, 200, 255, 0.8)',
        msg: this.config.message || 'Time to take a break!',
        icon: 'pomodoro',
      });

      this._scheduleNext();
    }, this.durationMs);
  }
}

module.exports = TimeoutConnector;
module.exports.DEFAULT_DURATION_MS = DEFAULT_DURATION_MS;
module.exports.MIN_DURATION_MS = MIN_DURATION_MS;

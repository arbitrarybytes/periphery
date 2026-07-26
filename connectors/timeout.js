const BaseConnector = require('./BaseConnector');

/**
 * Timeout Connector
 * A simple timer that reminds the user to take a break after a specified duration.
 * Config expects:
 * - durationMs: Number of milliseconds before triggering the break reminder
 * - cueName: The type of cue to trigger (e.g., 'comet', 'glow-pulse')
 * - color: The color of the cue
 * - message: The message to display
 */
class TimeoutConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.timerId = null;
    
    // Default to 25 minutes if not provided (Pomodoro default)
    this.durationMs = config.durationMs || 25 * 60 * 1000;
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
        icon: 'https://img.icons8.com/color/48/tomato.png'
      });

      // Automatically reschedule the next break
      this._scheduleNext();
    }, this.durationMs);
  }
}

module.exports = TimeoutConnector;

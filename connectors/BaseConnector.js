const EventEmitter = require('events');

/**
 * Base class for all FlowState Connectors.
 * Connectors are plugins that monitor external states and emit events 
 * when a visual cue should be triggered.
 */
class BaseConnector extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.isRunning = false;
  }

  /**
   * Starts the connector (e.g. begins polling, starts a timer, opens a socket)
   */
  start() {
    this.isRunning = true;
    console.log(`[Connector] ${this.constructor.name} started.`);
  }

  /**
   * Stops the connector and cleans up resources
   */
  stop() {
    this.isRunning = false;
    console.log(`[Connector] ${this.constructor.name} stopped.`);
  }

  /**
   * Helper to trigger a visual cue on the main UI
   * @param {Object} payload 
   * @param {string} payload.cue - The visual cue name (e.g., 'glow-bottom', 'comet')
   * @param {string} payload.color - CSS color string
   * @param {string} payload.msg - Optional text message
   */
  triggerCue(payload) {
    this.emit('trigger-cue', payload);
  }
}

module.exports = BaseConnector;

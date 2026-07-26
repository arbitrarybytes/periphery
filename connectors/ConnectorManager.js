'use strict';

/**
 * Manages the lifecycle of all loaded connectors and forwards their cues to
 * the host.
 */
class ConnectorManager {
  /**
   * @param {(payload: object) => void} sendCue - delivers a cue to the overlay.
   *   A callback rather than a BrowserWindow, because the overlay windows are
   *   recreated when displays change (and on macOS 'activate'); a captured
   *   window reference would silently point at a destroyed window forever.
   */
  constructor(sendCue) {
    this.sendCue = sendCue;
    this.connectors = new Map();
  }

  /**
   * Registers and starts a new connector
   * @param {string} id - Unique identifier for the connector instance
   * @param {import('./BaseConnector')} connectorInstance
   */
  register(id, connectorInstance) {
    if (this.connectors.has(id)) {
      this.unregister(id);
    }

    connectorInstance.on('trigger-cue', (payload) => this.sendCue(payload));

    this.connectors.set(id, connectorInstance);
    connectorInstance.start();
  }

  /**
   * Stops and removes a connector
   * @param {string} id
   */
  unregister(id) {
    const connector = this.connectors.get(id);
    if (connector) {
      connector.stop();
      connector.removeAllListeners();
      this.connectors.delete(id);
    }
  }

  /**
   * Stops all running connectors
   */
  stopAll() {
    for (const id of Array.from(this.connectors.keys())) {
      this.unregister(id);
    }
  }
}

module.exports = ConnectorManager;

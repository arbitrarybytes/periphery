/**
 * Manages the lifecycle of all loaded connectors.
 */
class ConnectorManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.connectors = new Map();
  }

  /**
   * Registers and starts a new connector
   * @param {string} id - Unique identifier for the connector instance
   * @param {BaseConnector} connectorInstance - The instantiated connector
   */
  register(id, connectorInstance) {
    if (this.connectors.has(id)) {
      this.unregister(id);
    }

    // Listen to cue events from this connector and forward them to the Electron Renderer
    connectorInstance.on('trigger-cue', (payload) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        const configStore = require('../utils/configStore');
        const enrichedPayload = {
          ...payload,
          repeats: configStore.get('glowRepeats', 3),
          verbose: configStore.get('verboseMode', true)
        };
        this.mainWindow.webContents.send('trigger-cue', enrichedPayload);
      }
    });

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
    for (const [id] of this.connectors) {
      this.unregister(id);
    }
  }
}

module.exports = ConnectorManager;

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
  /**
   * @param {(issues: Array<{id: string, name: string, status: string, detail: string|null}>) => void} [onHealthChange]
   *   called with the full issue list on every poller health transition —
   *   the host surfaces it in the tray and settings.
   */
  constructor(sendCue, onHealthChange) {
    this.sendCue = sendCue;
    this.onHealthChange = onHealthChange;
    this.connectors = new Map();
  }

  /**
   * Every connector whose health is not 'ok'. Reconfiguring a connector
   * recreates it, which is what clears an auth-failed entry.
   * @returns {Array<{id: string, name: string, status: string, detail: string|null}>}
   */
  getHealthIssues() {
    const issues = [];
    for (const [id, connector] of this.connectors) {
      if (connector.health.status !== 'ok') {
        issues.push({
          id,
          name: connector.constructor.name.replace(/Connector$/, ''),
          status: connector.health.status,
          detail: connector.health.detail,
        });
      }
    }
    return issues;
  }

  _notifyHealth() {
    if (this.onHealthChange) this.onHealthChange(this.getHealthIssues());
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
    connectorInstance.on('health', () => this._notifyHealth());

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
      this._notifyHealth();
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

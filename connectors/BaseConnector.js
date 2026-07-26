'use strict';

const EventEmitter = require('events');

const { WARN } = require('../utils/palette');

/** Bound on the "already notified" sets connectors keep, so they cannot grow forever. */
const SEEN_LIMIT = 200;
const SEEN_KEEP = 100;

/**
 * Base class for all Periphery Connectors.
 * Connectors are plugins that monitor external states and emit events
 * when a visual cue should be triggered.
 *
 * Connectors never import Electron: everything they need from the host
 * (currently just secret lookup) arrives through `config`. That keeps the
 * polling logic unit-testable and portable to Tauri (see docs/ADR.md).
 */
class BaseConnector extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.isRunning = false;
    this.authFailureReported = false;
  }

  /**
   * Starts the connector (e.g. begins polling, starts a timer, opens a socket)
   */
  start() {
    this.isRunning = true;
    this.authFailureReported = false;
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
   * @param {string} payload.cue - Cue name, one of utils/cuePayload.js CUE_NAMES
   * @param {string} [payload.color] - CSS color string
   * @param {string} [payload.msg] - Optional text message
   * @param {string} [payload.icon] - Bundled icon name, see cuePayload.js ICON_NAMES
   */
  triggerCue(payload) {
    this.emit('trigger-cue', payload);
  }

  /**
   * Reads a secret through the injected store.
   * @param {string} key
   * @returns {string|null}
   */
  getSecret(key) {
    const store = this.config.secretStore;
    if (!store) {
      console.error(`[Connector] ${this.constructor.name} has no secretStore configured.`);
      return null;
    }
    return store.getSecret(key);
  }

  /**
   * Surfaces an expired/revoked credential once and stops polling, rather
   * than looping on a 401 forever with nothing but console noise. The
   * connector is re-created when the user saves new credentials.
   * @param {string} message
   */
  reportAuthFailure(message) {
    if (this.authFailureReported) return;
    this.authFailureReported = true;
    console.error(`[Connector] ${this.constructor.name}: ${message}`);
    this.triggerCue({
      cue: 'glow-bottom',
      color: WARN,
      msg: message,
      icon: 'alert',
    });
    this.stop();
  }

  /**
   * @param {Response} response
   * @returns {boolean} whether the response was an auth failure (and polling stopped)
   */
  handleAuthResponse(response, message) {
    if (response.status !== 401 && response.status !== 403) return false;
    this.reportAuthFailure(message);
    return true;
  }

  /**
   * Authenticated GET against the connector's API. Subclasses set
   * `this.apiBase`, `this.logTag`, `this.authFailureMessage` and implement
   * `_authHeaders()`.
   * @param {string} pathAndQuery
   * @param {string} label - what is being fetched, for error logs
   * @returns {Promise<Response|null>} null when the request failed or auth was rejected
   */
  async _get(pathAndQuery, label) {
    const response = await fetch(`${this.apiBase}${pathAndQuery}`, {
      headers: this._authHeaders(),
    });

    if (this.handleAuthResponse(response, this.authFailureMessage)) return null;
    if (!response.ok) {
      console.error(`[${this.logTag}] Error fetching ${label}: ${response.status} ${response.statusText}`);
      return null;
    }
    return response;
  }

  /**
   * Caps an "already notified" set at its most recent entries. Relies on Sets
   * iterating in insertion order.
   * @param {Set<*>} seen
   * @returns {Set<*>} the same set, or a trimmed replacement
   */
  trimSeen(seen) {
    if (seen.size <= SEEN_LIMIT) return seen;
    return new Set(Array.from(seen).slice(-SEEN_KEEP));
  }
}

module.exports = BaseConnector;

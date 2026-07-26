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
 * polling logic unit-testable and portable to Tauri (see ai-native/ADR.md).
 */
class BaseConnector extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.isRunning = false;
    this.authFailureReported = false;
    /**
     * Poller health, surfaced in the tray and settings instead of dying in
     * the console. Statuses: 'ok' | 'auth-failed' | 'rate-limited' | 'error'.
     * @type {{status: string, detail: string|null}}
     */
    this.health = { status: 'ok', detail: null };
  }

  /**
   * Records a health transition and announces it. Deduplicated so a poller
   * erroring every 30s emits one event, not a stream.
   * @param {string} status
   * @param {string|null} [detail]
   */
  setHealth(status, detail = null) {
    if (this.health.status === status && this.health.detail === detail) return;
    this.health = { status, detail };
    this.emit('health', this.health);
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
    this.setHealth('auth-failed', message);
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
  /**
   * @param {Response} response
   * @returns {boolean} whether this is an API rate limit rather than a real
   *   auth problem. GitHub signals limits as 403 with a drained quota header,
   *   so this must be checked before treating a 403 as a revoked token.
   */
  isRateLimited(response) {
    if (response.status === 429) return true;
    return response.status === 403
      && response.headers?.get?.('x-ratelimit-remaining') === '0';
  }

  async _get(pathAndQuery, label) {
    const response = await fetch(`${this.apiBase}${pathAndQuery}`, {
      headers: this._authHeaders(),
    });

    if (this.isRateLimited(response)) {
      // Transient by definition: keep polling, recover on the next 2xx.
      this.setHealth('rate-limited', `${this.logTag}: API rate limit hit`);
      return null;
    }
    if (this.handleAuthResponse(response, this.authFailureMessage)) return null;
    if (!response.ok) {
      console.error(`[${this.logTag}] Error fetching ${label}: ${response.status} ${response.statusText}`);
      this.setHealth('error', `${this.logTag}: HTTP ${response.status} fetching ${label}`);
      return null;
    }
    this.setHealth('ok');
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

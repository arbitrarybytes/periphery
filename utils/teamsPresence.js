'use strict';

/**
 * Teams presence sync: polls Microsoft Graph `/me/presence` so that being in
 * a call, presenting, or on Do Not Disturb in Teams holds ambient cues the
 * same way Focus Assist does. Note that Teams' "Focusing" status surfaces
 * through Graph as DoNotDisturb, which is exactly the behaviour we want.
 *
 * Requires a Graph token with the delegated `Presence.Read` scope (the same
 * token slot the Outlook connector uses; see ai-native/agents.md and settings).
 *
 * Best effort, like the Focus Assist probe: a failed poll keeps the last
 * known state, and an auth failure fails OPEN (hold released) — presence
 * sync must never be able to mute cues forever.
 *
 * No Electron imports. The host injects `getToken` (the secret store lookup),
 * `onChange`, and `onAuthFailure`; `fetchFn` is injectable for tests.
 */

const PRESENCE_URL = 'https://graph.microsoft.com/v1.0/me/presence';
const DEFAULT_INTERVAL_MS = 60 * 1000;

/**
 * Activities that mean "do not draw on this person's screen right now".
 * Availability `DoNotDisturb` also covers Teams' "Focusing" custom status.
 */
const HOLD_ACTIVITIES = new Set([
  'InACall',
  'InAConferenceCall',
  'InAMeeting',
  'Presenting',
  'UrgentInterruptionsOnly',
]);

/**
 * @param {{availability?: string, activity?: string}|null|undefined} presence
 * @returns {boolean} whether cues should be held for this presence
 */
function presenceHolds(presence) {
  if (presence === null || typeof presence !== 'object') return false;
  if (presence.availability === 'DoNotDisturb') return true;
  return HOLD_ACTIVITIES.has(presence.activity);
}

class TeamsPresenceMonitor {
  /**
   * @param {object} options
   * @param {() => (string|null)} options.getToken - Graph bearer token, read
   *   per poll so a token replaced in Settings is picked up automatically
   * @param {(hold: boolean) => void} options.onChange - called on transitions
   * @param {(message: string) => void} [options.onAuthFailure] - called once
   *   when the token is missing/expired; polling stops until restarted
   * @param {number} [options.intervalMs]
   * @param {typeof fetch} [options.fetchFn] - injectable for tests
   */
  constructor({
    getToken,
    onChange,
    onAuthFailure,
    intervalMs = DEFAULT_INTERVAL_MS,
    fetchFn = fetch,
  }) {
    this.getToken = getToken;
    this.onChange = onChange;
    this.onAuthFailure = onAuthFailure;
    this.intervalMs = intervalMs;
    this.fetchFn = fetchFn;

    this.running = false;
    this.timerId = null;
    this.hold = false;
    this.authFailureReported = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.authFailureReported = false;
    // First poll immediately, so enabling the toggle takes effect now and not
    // a minute from now.
    this.poll().then(() => this._scheduleNext());
  }

  /** Stops polling and releases any hold, so cues can never stay muted. */
  stop() {
    this.dispose();
    this._set(false);
  }

  /** Stops polling without reporting a state change (shutdown). */
  dispose() {
    this.running = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  _scheduleNext() {
    if (!this.running) return;
    this.timerId = setTimeout(async () => {
      await this.poll();
      this._scheduleNext();
    }, this.intervalMs);
    if (typeof this.timerId.unref === 'function') this.timerId.unref();
  }

  /** One presence probe; exposed for tests. */
  async poll() {
    if (!this.running) return;

    const token = this.getToken();
    if (!token) {
      this._reportAuthFailure('Teams presence: no Microsoft Graph token stored');
      return;
    }

    try {
      const response = await this.fetchFn(PRESENCE_URL, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401 || response.status === 403) {
        this._reportAuthFailure('Teams presence: sign-in expired, re-enter your Graph token');
        return;
      }
      if (!response.ok) {
        console.error(`[TeamsPresence] Error fetching presence: ${response.status}`);
        return; // keep last known state
      }
      this._set(presenceHolds(await response.json()));
    } catch (err) {
      console.error('[TeamsPresence] Poll error', err);
    }
  }

  /**
   * Auth failures fail open: release the hold, say so once, stop polling.
   * The monitor is restarted when the user saves a new token.
   * @param {string} message
   */
  _reportAuthFailure(message) {
    const report = !this.authFailureReported;
    this.authFailureReported = true;
    if (report) console.error(`[TeamsPresence] ${message}`);
    this.dispose();
    this._set(false);
    if (report && this.onAuthFailure) this.onAuthFailure(message);
  }

  /** @param {boolean} hold */
  _set(hold) {
    if (hold === this.hold) return;
    this.hold = hold;
    this.onChange(hold);
  }
}

module.exports = { TeamsPresenceMonitor, presenceHolds, PRESENCE_URL };

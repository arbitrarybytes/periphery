'use strict';

const BaseConnector = require('./BaseConnector');
const { INFO, SUBTLE, MEETING } = require('../utils/palette');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
/** Unread messages fetched per poll. Sized so a normal burst is not dropped. */
const MESSAGE_PAGE_SIZE = 25;
/** Only look far enough ahead to cover the reminder threshold plus one poll. */
const CALENDAR_LOOKAHEAD_MINUTES = 6;
const MEETING_REMINDER_MINUTES = 5;
const OUTLOOK_ICON = 'outlook';

/**
 * Outlook Connector
 * Polls Microsoft Graph for unread mail (distinguishing 'To' from 'CC') and
 * for imminent meetings.
 *
 * Config expects:
 * - tokenKey: The key used to retrieve the OAuth token from the secret store
 * - secretStore: Object exposing getSecret(key)
 * - userEmail: The user's address, used to tell 'To' from 'CC'
 * - pollIntervalMs: How often to check (default 60s)
 */
class OutlookConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.apiBase = GRAPH_BASE;
    this.logTag = 'Outlook';
    this.authFailureMessage = 'Outlook: sign-in expired, re-enter your token';
    this.pollIntervalMs = config.pollIntervalMs || 60000;
    this.timerId = null;
    this.processedMessageIds = new Set();
    this.notifiedMeetingIds = new Set();
  }

  _authHeaders() {
    return { Authorization: `Bearer ${this.token}` };
  }

  start() {
    super.start();
    this.token = this.getSecret(this.config.tokenKey);
    if (!this.token) {
      console.error(`[Outlook] No token found for key: ${this.config.tokenKey}`);
      this.isRunning = false;
      return;
    }
    if (!this.config.userEmail) {
      console.error('[Outlook] No userEmail configured.');
      this.isRunning = false;
      return;
    }

    // Initial fetch so existing unread mail does not all fire at once.
    this._checkEmails(true)
      .catch((err) => console.error('[Outlook] Baseline fetch failed', err))
      .then(() => this._scheduleNext());
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
    this.timerId = setTimeout(async () => {
      await Promise.all([this._checkEmails(false), this._checkCalendar()]);
      this._scheduleNext();
    }, this.pollIntervalMs);
  }

  /**
   * @param {Array<{emailAddress?: {address?: string}}>|undefined} recipients
   * @returns {boolean}
   */
  _includesUser(recipients) {
    if (!Array.isArray(recipients)) return false;
    const userEmail = this.config.userEmail.toLowerCase();
    return recipients.some((r) => r.emailAddress?.address?.toLowerCase() === userEmail);
  }

  async _checkEmails(isBaseline = false) {
    try {
      const query = [
        '$filter=isRead eq false',
        '$orderby=receivedDateTime desc',
        `$top=${MESSAGE_PAGE_SIZE}`,
        '$select=id,from,toRecipients,ccRecipients',
      ].join('&');
      const response = await this._get(`/me/mailFolders/Inbox/messages?${query}`, 'emails');
      if (!response) return;

      const data = await response.json();
      const messages = Array.isArray(data.value) ? data.value : [];

      // Oldest first so a burst is announced in the order it arrived.
      for (const msg of [...messages].reverse()) {
        if (this.processedMessageIds.has(msg.id)) continue;
        this.processedMessageIds.add(msg.id);
        if (isBaseline) continue;

        const senderName = msg.from?.emailAddress?.name || 'Someone';

        if (this._includesUser(msg.toRecipients)) {
          // Addressed directly -> higher priority.
          this.triggerCue({
            cue: 'comet',
            color: INFO,
            msg: `Email from ${senderName}`,
            icon: OUTLOOK_ICON,
          });
        } else if (this._includesUser(msg.ccRecipients)) {
          // Merely CC'd -> very subtle, low priority.
          this.triggerCue({
            cue: 'glow-bottom',
            color: SUBTLE,
            msg: `CC'd by ${senderName}`,
            icon: OUTLOOK_ICON,
          });
        }
      }

      this.processedMessageIds = this.trimSeen(this.processedMessageIds);
    } catch (err) {
      console.error('[Outlook] Email Poll error', err);
    }
  }

  async _checkCalendar() {
    try {
      const now = new Date();
      const end = new Date(now.getTime() + CALENDAR_LOOKAHEAD_MINUTES * 60000);

      const query = [
        `startDateTime=${encodeURIComponent(now.toISOString())}`,
        `endDateTime=${encodeURIComponent(end.toISOString())}`,
        '$orderby=start/dateTime',
        '$select=id,subject,start',
      ].join('&');
      const response = await this._get(`/me/calendarView?${query}`, 'calendar');
      if (!response) return;

      const data = await response.json();
      const events = Array.isArray(data.value) ? data.value : [];

      for (const event of events) {
        if (this.notifiedMeetingIds.has(event.id)) continue;

        const eventStart = this._parseEventStart(event.start);
        if (!eventStart) continue;

        const minutesUntilStart = (eventStart.getTime() - now.getTime()) / 60000;

        // Fire once the meeting is imminent, but not for one already under way.
        if (minutesUntilStart <= MEETING_REMINDER_MINUTES && minutesUntilStart > -1) {
          this.notifiedMeetingIds.add(event.id);

          this.triggerCue({
            cue: 'glow-pulse',
            color: MEETING,
            msg: `Meeting: ${event.subject} starts in ${Math.max(0, Math.round(minutesUntilStart))} min`,
            icon: 'calendar',
            // Time-critical: must pierce focus mode (tier 1).
            urgent: true,
          });
        }
      }

      this.notifiedMeetingIds = this.trimSeen(this.notifiedMeetingIds);
    } catch (err) {
      console.error('[Outlook] Calendar Poll error', err);
    }
  }

  /**
   * Graph returns `{ dateTime, timeZone }` with no offset in the string. We do
   * not send a Prefer:outlook.timezone header, so the values come back as UTC.
   * @param {{dateTime?: string, timeZone?: string}|undefined} start
   * @returns {Date|null}
   */
  _parseEventStart(start) {
    if (!start || typeof start.dateTime !== 'string') return null;
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(start.dateTime);
    const parsed = new Date(hasZone ? start.dateTime : `${start.dateTime}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}

module.exports = OutlookConnector;

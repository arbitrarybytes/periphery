const BaseConnector = require('./BaseConnector');
const secureStore = require('../utils/secureStore');

/**
 * Outlook Connector
 * Polls Microsoft Graph API for unread emails and distinguishes between 
 * 'To' vs 'CC' priority.
 * 
 * Config expects:
 * - tokenKey: The key used to retrieve the OAuth token from secureStore
 * - userEmail: The email address of the user (to distinguish To vs CC)
 * - pollIntervalMs: How often to check (default 60s)
 */
class OutlookConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.pollIntervalMs = config.pollIntervalMs || 60000;
    this.timerId = null;
    this.processedMessageIds = new Set();
    this.notifiedMeetingIds = new Set();
  }

  start() {
    super.start();
    this.token = secureStore.getSecret(this.config.tokenKey);
    if (!this.token) {
      console.error(`[Outlook] No Token found for key: ${this.config.tokenKey}`);
      return;
    }
    if (!this.config.userEmail) {
      console.error(`[Outlook] No userEmail configured.`);
      return;
    }
    
    // Initial fetch to get baseline of current unread emails
    this._checkEmails(true).then(() => {
      this._scheduleNext();
    });
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
      await Promise.all([
        this._checkEmails(false),
        this._checkCalendar()
      ]);
      this._scheduleNext();
    }, this.pollIntervalMs);
  }

  async _checkEmails(isBaseline = false) {
    try {
      // Fetch latest 5 unread emails
      const response = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$filter=isRead eq false&$orderby=receivedDateTime desc&$top=5`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });
      
      if (!response.ok) {
        console.error(`[Outlook] Error fetching emails: ${response.statusText}`);
        return;
      }

      const data = await response.json();
      const messages = data.value || [];

      for (const msg of messages) {
        // If it's the baseline run, just record the ID so we ignore existing unread emails
        if (isBaseline) {
          this.processedMessageIds.add(msg.id);
          continue;
        }

        // Skip if we've already notified about this email
        if (this.processedMessageIds.has(msg.id)) continue;
        
        this.processedMessageIds.add(msg.id);

        // Analyze if user is To or CC
        const isTo = msg.toRecipients && msg.toRecipients.some(r => r.emailAddress.address.toLowerCase() === this.config.userEmail.toLowerCase());
        const isCc = msg.ccRecipients && msg.ccRecipients.some(r => r.emailAddress.address.toLowerCase() === this.config.userEmail.toLowerCase());

        let senderName = msg.from?.emailAddress?.name || 'Someone';

        if (isTo) {
          // Direct email -> Higher priority notification
          this.triggerCue({
            cue: 'comet',
            color: 'rgba(0, 150, 255, 0.9)',
            msg: `Email from ${senderName}`,
            icon: 'https://img.icons8.com/color/48/microsoft-outlook-2019--v2.png'
          });
        } else if (isCc) {
          // CC'd email -> Very subtle low-priority notification
          this.triggerCue({
            cue: 'glow-bottom',
            color: 'rgba(100, 100, 100, 0.5)',
            msg: `CC'd by ${senderName}`,
            icon: 'https://img.icons8.com/color/48/microsoft-outlook-2019--v2.png'
          });
        }
      }

      // Cleanup Set to prevent memory leaks if it gets too large
      if (this.processedMessageIds.size > 100) {
        const arr = Array.from(this.processedMessageIds);
        this.processedMessageIds = new Set(arr.slice(-50));
      }

    } catch (err) {
      console.error('[Outlook] Email Poll error', err);
    }
  }

  async _checkCalendar() {
    try {
      // Get meetings from now until 30 minutes from now
      const now = new Date();
      const end = new Date(now.getTime() + 30 * 60000);
      
      const startIso = now.toISOString();
      const endIso = end.toISOString();
      
      const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${startIso}&endDateTime=${endIso}&$orderby=start/dateTime`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (!response.ok) {
        console.error(`[Outlook] Error fetching calendar: ${response.statusText}`);
        return;
      }

      const data = await response.json();
      const events = data.value || [];

      for (const event of events) {
        if (this.notifiedMeetingIds.has(event.id)) continue;

        // Parse UTC start time
        const eventStart = new Date(event.start.dateTime + 'Z');
        const timeUntilStartMs = eventStart.getTime() - now.getTime();
        const minutesUntilStart = timeUntilStartMs / 60000;

        // Check if meeting starts in <= 5 minutes (and hasn't already started long ago)
        if (minutesUntilStart <= 5 && minutesUntilStart > -1) {
          this.notifiedMeetingIds.add(event.id);
          
          this.triggerCue({
            cue: 'glow-pulse',
            color: 'rgba(255, 165, 0, 0.8)', // Orange warning
            msg: `Meeting: ${event.subject} starts in 5 mins`,
            icon: 'https://img.icons8.com/color/48/event-accepted.png'
          });
        }
      }

      // Cleanup meeting ids
      if (this.notifiedMeetingIds.size > 50) {
        const arr = Array.from(this.notifiedMeetingIds);
        this.notifiedMeetingIds = new Set(arr.slice(-20));
      }
    } catch (err) {
      console.error('[Outlook] Calendar Poll error', err);
    }
  }
}

module.exports = OutlookConnector;

'use strict';

const BaseConnector = require('./BaseConnector');
const { INFO, SUCCESS, DANGER } = require('../utils/palette');
const { version } = require('../package.json');

const API_BASE = 'https://api.github.com';
/** Identifies the product and edition to GitHub. See ai-native/versioning.md. */
const USER_AGENT = `periphery/${version} (node edition)`;
/** Workflow runs fetched per poll. More than 1 so a burst between polls is not lost. */
const RUN_PAGE_SIZE = 10;
/** Conclusions that deserve a cue; the rest are marked seen silently. */
const RUN_CONCLUSION_CUES = new Set(['success', 'failure']);
const GITHUB_ICON = 'github';

/**
 * GitHub Connector
 * Monitors a repository's Actions workflow runs, plus the user's
 * notifications (review requests, mentions, assignments).
 *
 * Config expects:
 * - repo: "owner/name" of the repository to watch
 * - patKey: The key used to retrieve the PAT from the secret store
 * - secretStore: Object exposing getSecret(key)
 * - pollIntervalMs: How often to check (default 45s)
 * - apiBase: Override for GitHub Enterprise Server (default api.github.com)
 *
 * The PAT needs `repo` (or fine-grained Actions read) for workflow runs and
 * `notifications` for the notifications feed.
 */
class GitHubConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.apiBase = config.apiBase || API_BASE;
    this.logTag = 'GitHub';
    this.authFailureMessage = 'GitHub: access token expired or revoked';
    this.pollIntervalMs = config.pollIntervalMs || 45000;
    this.timerId = null;
    /** Completed runs already handled; in-progress ones stay out for later. */
    this.processedRunIds = new Set();
    /** Notification threads keyed by id:updated_at, so new activity re-fires. */
    this.processedThreadKeys = new Set();
  }

  _authHeaders() {
    return {
      Authorization: `Bearer ${this.pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects requests without a User-Agent. Naming the edition here
      // means a rate-limit or abuse report identifies which shell made the call.
      'User-Agent': USER_AGENT,
    };
  }

  start() {
    super.start();
    this.pat = this.getSecret(this.config.patKey);
    if (!this.pat) {
      console.error(`[GitHub] No PAT found for key: ${this.config.patKey}`);
      this.isRunning = false;
      return;
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(String(this.config.repo || ''))) {
      console.error(`[GitHub] Repo must be "owner/name", got: ${this.config.repo}`);
      this.isRunning = false;
      return;
    }

    // Initial fetch to establish a baseline of what is already resolved.
    Promise.all([this._checkWorkflowRuns(true), this._checkNotifications(true)])
      .catch((err) => console.error('[GitHub] Baseline fetch failed', err))
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
      await Promise.all([this._checkWorkflowRuns(false), this._checkNotifications(false)]);
      this._scheduleNext();
    }, this.pollIntervalMs);
  }

  async _checkWorkflowRuns(isBaseline = false) {
    try {
      const response = await this._get(
        `/repos/${this.config.repo}/actions/runs?per_page=${RUN_PAGE_SIZE}`,
        'workflow runs',
      );
      if (!response) return;

      const data = await response.json();
      const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];

      // The API returns newest first; walk oldest first so a burst of finished
      // runs is reported in the order it actually happened.
      for (const run of [...runs].reverse()) {
        if (run.status !== 'completed') continue;
        if (this.processedRunIds.has(run.id)) continue;

        this.processedRunIds.add(run.id);
        if (isBaseline) continue;
        if (!RUN_CONCLUSION_CUES.has(run.conclusion)) continue;

        const name = run.name || 'Workflow';
        if (run.conclusion === 'success') {
          this.triggerCue({
            cue: 'glow-pulse',
            color: SUCCESS,
            msg: `GitHub: ${name} passed!`,
            icon: GITHUB_ICON,
          });
        } else {
          this.triggerCue({
            cue: 'glow-bottom',
            color: DANGER,
            msg: `GitHub: ${name} failed`,
            icon: GITHUB_ICON,
          });
        }
      }

      this.processedRunIds = this.trimSeen(this.processedRunIds);
    } catch (err) {
      console.error('[GitHub] Workflow poll error', err);
    }
  }

  async _checkNotifications(isBaseline = false) {
    try {
      const response = await this._get('/notifications?per_page=50', 'notifications');
      if (!response) return;

      const threads = await response.json();
      if (!Array.isArray(threads)) return;

      for (const thread of threads) {
        const key = `${thread.id}:${thread.updated_at}`;
        if (this.processedThreadKeys.has(key)) continue;
        this.processedThreadKeys.add(key);
        if (isBaseline) continue;

        const cue = this._cueForThread(thread);
        if (cue) this.triggerCue(cue);
      }

      this.processedThreadKeys = this.trimSeen(this.processedThreadKeys);
    } catch (err) {
      console.error('[GitHub] Notification poll error', err);
    }
  }

  /**
   * Maps a notification thread to a cue, or null for reasons we deliberately
   * stay quiet about (ci_activity is already covered by the runs poll;
   * subscriptions would be noise).
   * @param {object} thread
   * @returns {object|null}
   */
  _cueForThread(thread) {
    const title = thread.subject?.title || 'an item';
    switch (thread.reason) {
      case 'review_requested':
        return { cue: 'comet', color: INFO, msg: `GitHub: Review requested on ${title}`, icon: GITHUB_ICON };
      case 'assign':
        return { cue: 'comet', color: INFO, msg: `GitHub: ${title} assigned to you`, icon: GITHUB_ICON };
      case 'mention':
      case 'team_mention':
        return { cue: 'comet', color: INFO, msg: `GitHub: You were mentioned in ${title}`, icon: GITHUB_ICON };
      case 'author':
        return { cue: 'glow-pulse', color: INFO, msg: `GitHub: Activity on your ${title}`, icon: GITHUB_ICON };
      default:
        return null;
    }
  }
}

module.exports = GitHubConnector;

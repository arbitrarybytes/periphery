'use strict';

const BaseConnector = require('./BaseConnector');

const API_BASE = 'https://gitlab.com/api/v4';
/** Pipelines fetched per poll. More than 1 so a burst between polls is not lost. */
const PIPELINE_PAGE_SIZE = 10;
/** Statuses that will never change again, so they can be marked as handled. */
const TERMINAL_STATUSES = new Set(['success', 'failed', 'canceled', 'skipped']);
const GITLAB_ICON = 'gitlab';

/**
 * GitLab Connector
 * Monitors a specific GitLab project for pipeline successes or failures,
 * plus the user's pending todos.
 *
 * Config expects:
 * - projectId: The GitLab project ID
 * - patKey: The key used to retrieve the PAT from the secret store
 * - secretStore: Object exposing getSecret(key)
 * - pollIntervalMs: How often to check (default 30s)
 */
class GitLabConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.pollIntervalMs = config.pollIntervalMs || 30000;
    this.timerId = null;
    /** Pipelines already resolved; running ones stay out so we catch them later. */
    this.processedPipelineIds = new Set();
    this.processedTodoIds = new Set();
  }

  start() {
    super.start();
    this.pat = this.getSecret(this.config.patKey);
    if (!this.pat) {
      console.error(`[GitLab] No PAT found for key: ${this.config.patKey}`);
      this.isRunning = false;
      return;
    }

    // Initial fetch to establish a baseline of what is already resolved.
    Promise.all([this._checkPipelines(true), this._checkTodos(true)])
      .catch((err) => console.error('[GitLab] Baseline fetch failed', err))
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
      await Promise.all([this._checkPipelines(false), this._checkTodos(false)]);
      this._scheduleNext();
    }, this.pollIntervalMs);
  }

  /**
   * @param {string} pathAndQuery
   * @returns {Promise<Response|null>} null when the request failed or auth was rejected
   */
  async _get(pathAndQuery, label) {
    const response = await fetch(`${API_BASE}${pathAndQuery}`, {
      headers: { 'PRIVATE-TOKEN': this.pat },
    });

    if (this.handleAuthResponse(response, 'GitLab: access token expired or revoked')) {
      return null;
    }
    if (!response.ok) {
      console.error(`[GitLab] Error fetching ${label}: ${response.status} ${response.statusText}`);
      return null;
    }
    return response;
  }

  async _checkPipelines(isBaseline = false) {
    try {
      const projectId = encodeURIComponent(this.config.projectId);
      const response = await this._get(
        `/projects/${projectId}/pipelines?per_page=${PIPELINE_PAGE_SIZE}`,
        'pipelines',
      );
      if (!response) return;

      const pipelines = await response.json();
      if (!Array.isArray(pipelines) || pipelines.length === 0) return;

      // The API returns newest first; walk oldest first so a burst of finished
      // pipelines is reported in the order it actually happened.
      for (const pipeline of [...pipelines].reverse()) {
        if (!TERMINAL_STATUSES.has(pipeline.status)) continue;
        if (this.processedPipelineIds.has(pipeline.id)) continue;

        this.processedPipelineIds.add(pipeline.id);
        if (isBaseline) continue;

        if (pipeline.status === 'success') {
          this.triggerCue({
            cue: 'glow-pulse',
            color: 'rgba(0, 255, 100, 0.8)',
            msg: 'GitLab: Pipeline Passed!',
            icon: GITLAB_ICON,
          });
        } else if (pipeline.status === 'failed') {
          // Name the failing job when we can, for a more useful message.
          const jobMsg = await this._getFailedJobMessage(pipeline.id);
          this.triggerCue({
            cue: 'glow-bottom',
            color: 'rgba(255, 0, 50, 0.9)',
            msg: jobMsg || 'GitLab: Pipeline Failed!',
            icon: GITLAB_ICON,
          });
        }
      }

      this.processedPipelineIds = this.trimSeen(this.processedPipelineIds);
    } catch (err) {
      console.error('[GitLab] Poll error', err);
    }
  }

  async _getFailedJobMessage(pipelineId) {
    try {
      const projectId = encodeURIComponent(this.config.projectId);
      const response = await this._get(
        `/projects/${projectId}/pipelines/${pipelineId}/jobs?scope[]=failed`,
        'jobs',
      );
      if (!response) return null;

      const jobs = await response.json();
      if (Array.isArray(jobs) && jobs.length > 0) {
        return `GitLab: Step '${jobs[0].name}' failed`;
      }
    } catch (err) {
      console.error('[GitLab] Error fetching jobs', err);
    }
    return null;
  }

  async _checkTodos(isBaseline = false) {
    try {
      const response = await this._get('/todos?state=pending&per_page=50', 'todos');
      if (!response) return;

      const todos = await response.json();
      if (!Array.isArray(todos)) return;

      for (const todo of todos) {
        if (this.processedTodoIds.has(todo.id)) continue;
        this.processedTodoIds.add(todo.id);
        if (isBaseline) continue;

        const cue = this._cueForTodo(todo);
        if (cue) this.triggerCue(cue);
      }

      this.processedTodoIds = this.trimSeen(this.processedTodoIds);
    } catch (err) {
      console.error('[GitLab] Todo Poll error', err);
    }
  }

  /**
   * Maps a todo to a cue, or null for actions we deliberately stay quiet about.
   * @param {object} todo
   * @returns {object|null}
   */
  _cueForTodo(todo) {
    const ref = todo.target?.reference || 'item';
    const blue = 'rgba(0, 150, 255, 0.9)';
    const green = 'rgba(0, 255, 100, 0.9)';

    switch (todo.action_name) {
      case 'review_requested':
        return { cue: 'comet', color: blue, msg: `GitLab: Review requested on ${ref}`, icon: GITLAB_ICON };
      case 'assigned':
        return { cue: 'comet', color: blue, msg: `GitLab: ${ref} assigned to you`, icon: GITLAB_ICON };
      case 'mentioned':
      case 'directly_addressed':
        return { cue: 'comet', color: blue, msg: `GitLab: You were mentioned in ${ref}`, icon: GITLAB_ICON };
      // Someone is waiting on *your* approval — this is an ask, not good news.
      case 'approval_required':
        return { cue: 'comet', color: blue, msg: `GitLab: Your approval is needed on ${ref}`, icon: GITLAB_ICON };
      case 'approved':
        return { cue: 'comet', color: green, msg: `GitLab: ${ref} was approved!`, icon: GITLAB_ICON };
      case 'build_failed':
        return { cue: 'glow-bottom', color: 'rgba(255, 0, 50, 0.9)', msg: `GitLab: Build failed on ${ref}`, icon: GITLAB_ICON };
      default:
        return null;
    }
  }
}

module.exports = GitLabConnector;

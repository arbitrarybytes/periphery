const BaseConnector = require('./BaseConnector');
const secureStore = require('../utils/secureStore');

/**
 * GitLab Connector
 * Monitors a specific GitLab project for pipeline successes or failures.
 * 
 * Config expects:
 * - projectId: The GitLab project ID
 * - patKey: The key used to retrieve the PAT from secureStore
 * - pollIntervalMs: How often to check (default 30s)
 */
class GitLabConnector extends BaseConnector {
  constructor(config) {
    super(config);
    this.pollIntervalMs = config.pollIntervalMs || 30000;
    this.timerId = null;
    this.lastProcessedPipelineId = null;
    this.processedTodoIds = new Set();
  }

  start() {
    super.start();
    this.pat = secureStore.getSecret(this.config.patKey);
    if (!this.pat) {
      console.error(`[GitLab] No PAT found for key: ${this.config.patKey}`);
      return;
    }
    
    // Initial fetch to get baseline
    Promise.all([
      this._checkPipelines(true),
      this._checkTodos(true)
    ]).then(() => {
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
        this._checkPipelines(false),
        this._checkTodos(false)
      ]);
      this._scheduleNext();
    }, this.pollIntervalMs);
  }

  async _checkPipelines(isBaseline = false) {
    try {
      const response = await fetch(`https://gitlab.com/api/v4/projects/${this.config.projectId}/pipelines?per_page=1`, {
        headers: {
          'PRIVATE-TOKEN': this.pat
        }
      });
      
      if (!response.ok) {
        console.error(`[GitLab] Error fetching pipelines: ${response.statusText}`);
        return;
      }

      const pipelines = await response.json();
      if (pipelines.length === 0) return;

      const latestPipeline = pipelines[0];
      
      // If this is our first run, just establish the baseline
      if (isBaseline) {
        this.lastProcessedPipelineId = latestPipeline.id;
        return;
      }

      // If we've already processed this pipeline, do nothing
      if (latestPipeline.id === this.lastProcessedPipelineId) {
        return;
      }

      // We only care about terminal states
      if (latestPipeline.status === 'success' || latestPipeline.status === 'failed') {
        this.lastProcessedPipelineId = latestPipeline.id;
        
        if (latestPipeline.status === 'success') {
          this.triggerCue({
            cue: 'glow-pulse',
            color: 'rgba(0, 255, 100, 0.8)',
            msg: `GitLab: Pipeline Passed!`,
            icon: 'https://img.icons8.com/color/48/gitlab.png'
          });
        } else if (latestPipeline.status === 'failed') {
          // If it failed, let's try to find which job failed for better context
          const jobMsg = await this._getFailedJobMessage(latestPipeline.id);
          this.triggerCue({
            cue: 'glow-bottom',
            color: 'rgba(255, 0, 50, 0.9)',
            msg: jobMsg || `GitLab: Pipeline Failed!`,
            icon: 'https://img.icons8.com/color/48/gitlab.png'
          });
        }
      }

    } catch (err) {
      console.error('[GitLab] Poll error', err);
    }
  }

  async _getFailedJobMessage(pipelineId) {
    try {
      const response = await fetch(`https://gitlab.com/api/v4/projects/${this.config.projectId}/pipelines/${pipelineId}/jobs?scope[]=failed`, {
        headers: {
          'PRIVATE-TOKEN': this.pat
        }
      });
      if (!response.ok) return null;
      
      const jobs = await response.json();
      if (jobs.length > 0) {
        // Return the name of the first failed job we see
        return `GitLab: Step '${jobs[0].name}' failed`;
      }
    } catch (err) {
      console.error('[GitLab] Error fetching jobs', err);
    }
    return null;
  }

  async _checkTodos(isBaseline = false) {
    try {
      const response = await fetch(`https://gitlab.com/api/v4/todos?state=pending`, {
        headers: { 'PRIVATE-TOKEN': this.pat }
      });
      
      if (!response.ok) {
        console.error(`[GitLab] Error fetching todos: ${response.statusText}`);
        return;
      }

      const todos = await response.json();
      
      for (const todo of todos) {
        if (isBaseline) {
          this.processedTodoIds.add(todo.id);
          continue;
        }

        if (this.processedTodoIds.has(todo.id)) continue;
        
        this.processedTodoIds.add(todo.id);

        const action = todo.action_name;
        const targetType = todo.target_type;
        const ref = todo.target?.reference || 'item';

        if (action === 'review_requested' || action === 'assigned') {
          this.triggerCue({
            cue: 'comet',
            color: 'rgba(0, 150, 255, 0.9)', // Blue Comet
            msg: `GitLab: Review requested on ${ref}`,
            icon: 'https://img.icons8.com/color/48/gitlab.png'
          });
        } else if (action === 'mentioned') {
          this.triggerCue({
            cue: 'comet',
            color: 'rgba(0, 150, 255, 0.9)', // Blue Comet
            msg: `GitLab: You were mentioned in ${ref}`,
            icon: 'https://img.icons8.com/color/48/gitlab.png'
          });
        } else if (action === 'approval_required' || action === 'approved') {
          this.triggerCue({
            cue: 'comet',
            color: 'rgba(0, 255, 100, 0.9)', // Green Comet
            msg: `GitLab: MR ${ref} Approved!`,
            icon: 'https://img.icons8.com/color/48/gitlab.png'
          });
        }
      }

      // Cleanup
      if (this.processedTodoIds.size > 100) {
        const arr = Array.from(this.processedTodoIds);
        this.processedTodoIds = new Set(arr.slice(-50));
      }
    } catch (err) {
      console.error('[GitLab] Todo Poll error', err);
    }
  }
}

module.exports = GitLabConnector;

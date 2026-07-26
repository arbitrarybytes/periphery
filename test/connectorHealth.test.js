'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const BaseConnector = require('../connectors/BaseConnector');
const ConnectorManager = require('../connectors/ConnectorManager');
const GitHubConnector = require('../connectors/github');
const { stubFetch, fakeSecretStore } = require('./helpers/fakes');

test('setHealth deduplicates and emits on transitions', () => {
  const connector = new BaseConnector();
  const events = [];
  connector.on('health', (health) => events.push(health.status));

  connector.setHealth('error', 'HTTP 500');
  connector.setHealth('error', 'HTTP 500'); // same state: no event
  connector.setHealth('ok');

  assert.deepEqual(events, ['error', 'ok']);
});

test('a GitHub 403 with drained quota is a rate limit, not a dead token', async () => {
  const connector = new GitHubConnector({
    repo: 'octocat/hello-world',
    patKey: 'github-pat',
    secretStore: fakeSecretStore({ 'github-pat': 't' }),
  });
  connector.pat = 't';
  connector.isRunning = true;

  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    statusText: '403',
    headers: { get: (name) => (name === 'x-ratelimit-remaining' ? '0' : null) },
    json: async () => ({}),
  });
  try {
    await connector._checkWorkflowRuns(false);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(connector.health.status, 'rate-limited');
  assert.equal(connector.isRunning, true, 'rate limits are transient; polling must continue');
});

test('health recovers to ok on the next successful request', async () => {
  const connector = new GitHubConnector({
    repo: 'octocat/hello-world',
    patKey: 'github-pat',
    secretStore: fakeSecretStore({ 'github-pat': 't' }),
  });
  connector.pat = 't';
  connector.setHealth('rate-limited', 'GitHub: API rate limit hit');

  const fetchStub = stubFetch([{ match: '/actions/runs', body: { workflow_runs: [] } }]);
  try {
    await connector._checkWorkflowRuns(false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(connector.health.status, 'ok');
});

test('an auth failure sets auth-failed health alongside the warning cue', async () => {
  const connector = new GitHubConnector({
    repo: 'octocat/hello-world',
    patKey: 'github-pat',
    secretStore: fakeSecretStore({ 'github-pat': 't' }),
  });
  connector.pat = 't';
  connector.isRunning = true;

  const fetchStub = stubFetch([{ match: '/actions/runs', status: 401, body: {} }]);
  try {
    await connector._checkWorkflowRuns(false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(connector.health.status, 'auth-failed');
  assert.match(connector.health.detail, /token expired/i);
});

test('the manager aggregates issues and reports every transition', () => {
  const snapshots = [];
  const manager = new ConnectorManager(() => {}, (issues) => snapshots.push(issues));

  const connector = new BaseConnector();
  manager.register('github-1', connector);

  connector.setHealth('auth-failed', 'GitHub: token expired');
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], [
    { id: 'github-1', name: 'Base', status: 'auth-failed', detail: 'GitHub: token expired' },
  ]);

  connector.setHealth('ok');
  assert.deepEqual(snapshots[1], [], 'recovery must clear the issue list');

  connector.setHealth('rate-limited', 'limit');
  manager.unregister('github-1');
  assert.deepEqual(snapshots.at(-1), [], 'reconfiguring a connector clears its stale issue');
});

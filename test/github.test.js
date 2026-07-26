'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const GitHubConnector = require('../connectors/github');
const { stubFetch, fakeSecretStore, collectCues } = require('./helpers/fakes');

const PAT_KEY = 'github-pat';

function makeConnector(overrides = {}) {
  return new GitHubConnector({
    repo: 'octocat/hello-world',
    patKey: PAT_KEY,
    secretStore: fakeSecretStore({ [PAT_KEY]: 'ghp-token' }),
    ...overrides,
  });
}

/** Drives a connector's checks without starting its timer. */
async function checkRuns(connector, isBaseline) {
  connector.pat = 'ghp-token';
  await connector._checkWorkflowRuns(isBaseline);
}

async function checkNotifications(connector, isBaseline) {
  connector.pat = 'ghp-token';
  await connector._checkNotifications(isBaseline);
}

test('a passing workflow run pulses green', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{
    match: '/actions/runs',
    body: { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', name: 'CI' }] },
  }]);

  try {
    await checkRuns(connector, false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1);
  assert.equal(cues[0].cue, 'glow-pulse');
  assert.match(cues[0].msg, /CI passed/);
  assert.equal(cues[0].icon, 'github');
});

test('a failed run glows red at the bottom, cancelled runs stay quiet', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{
    match: '/actions/runs',
    body: {
      workflow_runs: [
        { id: 2, status: 'completed', conclusion: 'failure', name: 'Deploy' },
        { id: 3, status: 'completed', conclusion: 'cancelled', name: 'Lint' },
      ],
    },
  }]);

  try {
    await checkRuns(connector, false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1);
  assert.equal(cues[0].cue, 'glow-bottom');
  assert.match(cues[0].msg, /Deploy failed/);
});

test('in-progress runs are caught on a later poll', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);

  let fetchStub = stubFetch([{
    match: '/actions/runs',
    body: { workflow_runs: [{ id: 4, status: 'in_progress', conclusion: null, name: 'CI' }] },
  }]);
  try {
    await checkRuns(connector, true); // baseline sees it running
  } finally {
    fetchStub.restore();
  }

  fetchStub = stubFetch([{
    match: '/actions/runs',
    body: { workflow_runs: [{ id: 4, status: 'completed', conclusion: 'success', name: 'CI' }] },
  }]);
  try {
    await checkRuns(connector, false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1, 'a run that finished after the baseline must still notify');
});

test('the baseline records existing completed runs without notifying', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const body = { workflow_runs: [{ id: 5, status: 'completed', conclusion: 'success', name: 'CI' }] };

  let fetchStub = stubFetch([{ match: '/actions/runs', body }]);
  try {
    await checkRuns(connector, true);
    assert.equal(cues.length, 0, 'pre-existing runs must stay quiet');
  } finally {
    fetchStub.restore();
  }

  fetchStub = stubFetch([{ match: '/actions/runs', body }]);
  try {
    await checkRuns(connector, false);
    assert.equal(cues.length, 0, 'and must not fire on the next poll either');
  } finally {
    fetchStub.restore();
  }
});

test('review requests and mentions arrive as comets', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{
    match: '/notifications',
    body: [
      { id: '10', updated_at: 't1', reason: 'review_requested', subject: { title: 'Add tests' } },
      { id: '11', updated_at: 't1', reason: 'mention', subject: { title: 'Fix flake' } },
      { id: '12', updated_at: 't1', reason: 'security_alert', subject: { title: 'noise' } },
    ],
  }]);

  try {
    await checkNotifications(connector, false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 2, 'unmapped reasons must stay quiet');
  assert.match(cues[0].msg, /Review requested on Add tests/);
  assert.equal(cues[0].cue, 'comet');
  assert.match(cues[1].msg, /mentioned in Fix flake/);
});

test('new activity on a seen thread re-notifies (updated_at key)', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);

  let fetchStub = stubFetch([{
    match: '/notifications',
    body: [{ id: '20', updated_at: 't1', reason: 'mention', subject: { title: 'PR' } }],
  }]);
  try {
    await checkNotifications(connector, true); // baseline
  } finally {
    fetchStub.restore();
  }

  fetchStub = stubFetch([{
    match: '/notifications',
    body: [{ id: '20', updated_at: 't2', reason: 'mention', subject: { title: 'PR' } }],
  }]);
  try {
    await checkNotifications(connector, false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1, 'the same thread with a new updated_at is new activity');
});

test('a 401 reports the auth failure once and stops polling', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  connector.isRunning = true;
  const fetchStub = stubFetch([
    { match: '/actions/runs', status: 401, body: {} },
    { match: '/notifications', status: 401, body: {} },
  ]);

  try {
    await checkRuns(connector, false);
    await checkNotifications(connector, false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1, 'one warning cue, not one per endpoint');
  assert.match(cues[0].msg, /token expired or revoked/i);
  assert.equal(connector.isRunning, false);
});

test('start() refuses a malformed repo instead of polling garbage', () => {
  const connector = makeConnector({ repo: 'not-a-repo' });
  connector.start();
  assert.equal(connector.isRunning, false);
});

test('auth headers carry the token, API version, and a User-Agent', () => {
  const connector = makeConnector();
  connector.pat = 'ghp-token';
  const headers = connector._authHeaders();
  assert.equal(headers.Authorization, 'Bearer ghp-token');
  assert.ok(headers['User-Agent'], 'GitHub rejects requests without a User-Agent');
  assert.ok(headers['X-GitHub-Api-Version']);
});

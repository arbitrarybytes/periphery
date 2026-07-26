'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const GitLabConnector = require('../connectors/gitlab');
const { CUE_NAMES, ICON_NAMES } = require('../utils/cuePayload');
const { stubFetch, fakeSecretStore, collectCues } = require('./helpers/fakes');

const PAT_KEY = 'gitlab-pat';

function makeConnector() {
  return new GitLabConnector({
    projectId: '123',
    patKey: PAT_KEY,
    secretStore: fakeSecretStore({ [PAT_KEY]: 'glpat-token' }),
  });
}

/** Drives a connector's pipeline check without starting its timer. */
async function checkPipelines(connector, isBaseline) {
  connector.pat = 'glpat-token';
  await connector._checkPipelines(isBaseline);
}

async function checkTodos(connector, isBaseline) {
  connector.pat = 'glpat-token';
  await connector._checkTodos(isBaseline);
}

test('approval_required asks for approval rather than announcing one', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{
    match: '/todos',
    body: [{ id: 1, action_name: 'approval_required', target: { reference: '!42' } }],
  }]);

  try {
    await checkTodos(connector, false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1);
  assert.match(cues[0].msg, /approval is needed/i);
  assert.doesNotMatch(cues[0].msg, /approved/i);
});

test('approved is reported separately, and in green', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{
    match: '/todos',
    body: [{ id: 2, action_name: 'approved', target: { reference: '!7' } }],
  }]);

  try {
    await checkTodos(connector, false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1);
  assert.match(cues[0].msg, /!7 was approved/i);
  assert.equal(cues[0].color, 'rgba(0, 255, 100, 0.9)');
});

test('the baseline run records existing todos without notifying', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const todos = [{ id: 9, action_name: 'review_requested', target: { reference: '!1' } }];
  const fetchStub = stubFetch([{ match: '/todos', body: todos }]);

  try {
    await checkTodos(connector, true);
    assert.equal(cues.length, 0, 'pre-existing todos must stay quiet');
    await checkTodos(connector, false);
    assert.equal(cues.length, 0, 'and must not fire on the next poll either');
  } finally {
    fetchStub.restore();
  }
});

test('several pipelines finishing between polls are all reported, oldest first', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  // Newest first, as the API returns them.
  const fetchStub = stubFetch([
    {
      match: '/pipelines?',
      body: [
        { id: 3, status: 'failed' },
        { id: 2, status: 'success' },
      ],
    },
    { match: '/jobs', body: [{ name: 'lint' }] },
  ]);

  try {
    await checkPipelines(connector, false);
  } finally {
    fetchStub.restore();
  }

  // A single-item page previously meant only the newest pipeline was ever seen.
  assert.equal(cues.length, 2);
  assert.match(cues[0].msg, /Pipeline Passed/);
  assert.match(cues[1].msg, /Step 'lint' failed/);
});

test('a running pipeline is reported once it reaches a terminal state', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);

  let stub = stubFetch([{ match: '/pipelines?', body: [{ id: 5, status: 'running' }] }]);
  try {
    await checkPipelines(connector, false);
    assert.equal(cues.length, 0, 'a running pipeline is not news yet');
  } finally {
    stub.restore();
  }

  stub = stubFetch([{ match: '/pipelines?', body: [{ id: 5, status: 'success' }] }]);
  try {
    await checkPipelines(connector, false);
  } finally {
    stub.restore();
  }

  assert.equal(cues.length, 1);
  assert.match(cues[0].msg, /Pipeline Passed/);
});

test('a pipeline is never reported twice', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{ match: '/pipelines?', body: [{ id: 8, status: 'success' }] }]);

  try {
    await checkPipelines(connector, false);
    await checkPipelines(connector, false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, 1);
});

test('a revoked token surfaces once and stops polling', async () => {
  const connector = makeConnector();
  connector.isRunning = true;
  const cues = collectCues(connector);
  const fetchStub = stubFetch([{ match: '/pipelines?', status: 401 }]);

  try {
    await checkPipelines(connector, false);
    await checkPipelines(connector, false);
  } finally {
    fetchStub.restore();
  }

  // Without this the connector logged a 401 every 30s forever, invisibly.
  assert.equal(cues.length, 1);
  assert.match(cues[0].msg, /expired or revoked/i);
  assert.equal(cues[0].icon, 'alert');
  assert.equal(connector.isRunning, false);
});

test('start() refuses to poll when no PAT is stored', () => {
  const connector = new GitLabConnector({
    projectId: '123',
    patKey: PAT_KEY,
    secretStore: fakeSecretStore({}),
  });

  connector.start();
  assert.equal(connector.isRunning, false);
  assert.equal(connector.timerId, null);
});

test('every emitted cue uses a known cue and icon name', async () => {
  const connector = makeConnector();
  const cues = collectCues(connector);
  const actions = [
    'review_requested', 'assigned', 'mentioned', 'directly_addressed',
    'approval_required', 'approved', 'build_failed',
  ];
  const fetchStub = stubFetch([{
    match: '/todos',
    body: actions.map((action_name, i) => ({ id: i, action_name, target: { reference: '!1' } })),
  }]);

  try {
    await checkTodos(connector, false);
  } finally {
    fetchStub.restore();
  }

  assert.equal(cues.length, actions.length);
  for (const cue of cues) {
    assert.ok(CUE_NAMES.includes(cue.cue), `unknown cue: ${cue.cue}`);
    assert.ok(ICON_NAMES.includes(cue.icon), `unknown icon: ${cue.icon}`);
  }
});

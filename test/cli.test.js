'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, buildRequest } = require('../cli/periphery');
const { sanitizeCuePayload } = require('../utils/cuePayload');

function request(argv) {
  return buildRequest(parseArgs(argv));
}

test('notify builds a webhook payload from flags', () => {
  const req = request(['notify', '--msg', 'Build finished', '--cue', 'glow', '--color', '#00ff00', '--urgent']);
  assert.equal(req.path, '/notify');
  assert.deepEqual(req.payload, { cue: 'glow', msg: 'Build finished', color: '#00ff00', urgent: true });
});

test('notify defaults to glow-pulse; --agent switches to the beacon', () => {
  assert.equal(request(['notify', '--msg', 'hi']).payload.cue, 'glow-pulse');

  const agent = request(['notify', '--agent', '--msg', 'Refactor done']).payload;
  assert.equal(agent.cue, 'glow-agent');
  assert.equal(agent.icon, 'agent');
});

test('done is a ready-made agent completion', () => {
  const req = request(['done', 'Tests green']);
  assert.equal(req.payload.cue, 'glow-agent');
  assert.equal(req.payload.msg, 'Tests green');

  const fail = request(['done', '--fail']);
  assert.equal(fail.payload.msg, 'Task failed');
  assert.equal(fail.payload.color, 'rgba(255, 0, 50, 0.9)');

  assert.equal(request(['done']).payload.msg, 'Task complete');
});

test('every payload the CLI builds passes the webhook validator', () => {
  const requests = [
    request(['notify', '--msg', 'hi']),
    request(['notify', '--agent', '--msg', 'done', '--urgent']),
    request(['done', 'finished']),
    request(['done', '--fail', 'broke']),
  ];
  for (const req of requests) {
    assert.ok(sanitizeCuePayload(req.payload), `must survive validation: ${JSON.stringify(req.payload)}`);
  }
});

test('health needs no payload; unknown commands return null for usage', () => {
  assert.deepEqual(request(['health']), { path: '/health' });
  assert.equal(request(['frobnicate']), null);
  assert.equal(request([]), null);
});

'use strict';

/**
 * The state-cue primitive end to end: validation of `ref`, the /resolve
 * endpoint, and the MCP + CLI surfaces that drive them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeCuePayload, sanitizeResolvePayload, isValidRef, CUE_NAMES, STATE_CUES,
} = require('../utils/cuePayload');
const { handleMessage } = require('../mcp/server');
const { parseArgs, buildRequest } = require('../cli/periphery');

// --- validation ------------------------------------------------------------

test('glow-blocked is an accepted cue and a declared state cue', () => {
  assert.ok(CUE_NAMES.includes('glow-blocked'));
  assert.deepEqual(STATE_CUES, ['glow-blocked']);
});

test('ref accepts opaque tokens and rejects anything injectable', () => {
  assert.equal(isValidRef('agent-1'), true);
  assert.equal(isValidRef('claude:session.42_a'), true);
  assert.equal(isValidRef(''), false);
  assert.equal(isValidRef('has space'), false);
  assert.equal(isValidRef('<script>'), false);
  assert.equal(isValidRef('a'.repeat(65)), false, 'refs are Map keys, not essays');
  assert.equal(isValidRef(null), false);
});

test('a bad ref is dropped, not fatal — the cue still shows', () => {
  const payload = sanitizeCuePayload({ cue: 'glow-blocked', ref: 'no spaces allowed', msg: 'Approve?' });
  assert.ok(payload);
  assert.equal(payload.ref, undefined, 'unusable ref is dropped');
  assert.equal(payload.msg, 'Approve?', 'but the block still reaches the user');
});

test('resolve payloads accept a ref or all, and nothing else', () => {
  assert.deepEqual(sanitizeResolvePayload({ ref: 'a' }), { ref: 'a', all: false });
  assert.deepEqual(sanitizeResolvePayload({ all: true }), { all: true });
  assert.equal(sanitizeResolvePayload({}), null);
  assert.equal(sanitizeResolvePayload({ all: 'yes' }), null, 'only the literal true counts');
  assert.equal(sanitizeResolvePayload({ ref: 'bad ref' }), null);
  assert.equal(sanitizeResolvePayload(null), null);
});

// --- MCP surface -----------------------------------------------------------

function harness({ resolveResult = { ok: true, cleared: 1 } } = {}) {
  const posted = [];
  const resolved = [];
  return {
    posted,
    resolved,
    postCue: async (payload) => { posted.push(payload); return { ok: true }; },
    postResolve: async (request) => { resolved.push(request); return resolveResult; },
  };
}

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('tools/list advertises the blocked pair', async () => {
  const h = harness();
  const response = await handleMessage(rpc('tools/list'), h.postCue, h.postResolve);
  const names = response.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['notify', 'task_blocked', 'task_complete', 'task_unblocked']);

  const blocked = response.result.tools.find((t) => t.name === 'task_blocked');
  assert.match(blocked.description, /escalat/i, 'agents must be told it escalates');
  assert.match(blocked.description, /task_unblocked/, 'and told to clear it afterwards');
});

test('task_blocked posts a valid glow-blocked cue carrying the ref', async () => {
  const h = harness();
  const response = await handleMessage(
    rpc('tools/call', {
      name: 'task_blocked',
      arguments: { question: 'Approve deleting 3 migration files?', ref: 'mig-1' },
    }),
    h.postCue, h.postResolve,
  );

  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].cue, 'glow-blocked');
  assert.equal(h.posted[0].ref, 'mig-1');
  assert.equal(h.posted[0].msg, 'Approve deleting 3 migration files?');
  assert.ok(sanitizeCuePayload(h.posted[0]), 'must survive the webhook validator');
  assert.match(response.result.content[0].text, /task_unblocked/);
});

test('task_unblocked resolves by ref, or all when omitted', async () => {
  const h = harness();
  await handleMessage(
    rpc('tools/call', { name: 'task_unblocked', arguments: { ref: 'mig-1' } }),
    h.postCue, h.postResolve,
  );
  assert.deepEqual(h.resolved[0], { ref: 'mig-1' });

  await handleMessage(
    rpc('tools/call', { name: 'task_unblocked', arguments: {} }),
    h.postCue, h.postResolve,
  );
  assert.deepEqual(h.resolved[1], { all: true });
  assert.equal(h.posted.length, 0, 'clearing is a resolve, never a cue');
});

test('task_unblocked reports honestly when nothing was waiting', async () => {
  const h = harness({ resolveResult: { ok: true, cleared: 0 } });
  const response = await handleMessage(
    rpc('tools/call', { name: 'task_unblocked', arguments: {} }),
    h.postCue, h.postResolve,
  );
  assert.match(response.result.content[0].text, /Nothing was waiting/);
});

test('task_blocked without a question is an invalid-params error', async () => {
  const h = harness();
  const response = await handleMessage(
    rpc('tools/call', { name: 'task_blocked', arguments: {} }), h.postCue, h.postResolve,
  );
  assert.equal(response.error.code, -32602);
  assert.equal(h.posted.length, 0);
});

// --- CLI surface -----------------------------------------------------------

const request = (argv) => buildRequest(parseArgs(argv));

test('periphery blocked builds a valid escalating cue', () => {
  const req = request(['blocked', 'Approve the migration?', '--ref', 'mig-1']);
  assert.equal(req.path, '/notify');
  assert.equal(req.payload.cue, 'glow-blocked');
  assert.equal(req.payload.ref, 'mig-1');
  assert.equal(req.payload.msg, 'Approve the migration?');
  assert.ok(sanitizeCuePayload(req.payload));

  assert.match(request(['blocked']).payload.msg, /waiting for your approval/);
});

test('periphery unblocked resolves by ref, or all by default', () => {
  assert.deepEqual(request(['unblocked', '--ref', 'mig-1']), {
    path: '/resolve', payload: { ref: 'mig-1' },
  });
  assert.deepEqual(request(['unblocked']), { path: '/resolve', payload: { all: true } });
});

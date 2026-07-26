'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleMessage, TOOLS } = require('../mcp/server');
const { sanitizeCuePayload } = require('../utils/cuePayload');

function okPost() {
  const posted = [];
  return {
    posted,
    postCue: async (payload) => {
      posted.push(payload);
      return { ok: true };
    },
  };
}

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

test('initialize advertises the tools capability', async () => {
  const { postCue } = okPost();
  const response = await handleMessage(rpc('initialize', {}), postCue);
  assert.equal(response.id, 1);
  assert.ok(response.result.protocolVersion);
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(response.result.serverInfo.name, 'periphery');
});

test('tools/list exposes task_complete and notify', async () => {
  const { postCue } = okPost();
  const response = await handleMessage(rpc('tools/list'), postCue);
  const names = response.result.tools.map((tool) => tool.name);
  assert.deepEqual(names.sort(), ['notify', 'task_complete']);
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 20, `${tool.name} needs a description agents can act on`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('task_complete fires the persistent agent beacon', async () => {
  const { posted, postCue } = okPost();
  const response = await handleMessage(
    rpc('tools/call', { name: 'task_complete', arguments: { summary: 'Tests passed: 214/214' } }),
    postCue,
  );

  assert.equal(posted.length, 1);
  assert.equal(posted[0].cue, 'glow-agent');
  assert.equal(posted[0].icon, 'agent');
  assert.equal(posted[0].msg, 'Tests passed: 214/214');
  assert.equal(response.result.isError, undefined);
});

test('a failed task_complete turns the beacon red', async () => {
  const { posted, postCue } = okPost();
  await handleMessage(
    rpc('tools/call', { name: 'task_complete', arguments: { summary: 'Build failed', success: false } }),
    postCue,
  );
  assert.equal(posted[0].color, 'rgba(255, 0, 50, 0.9)');
});

test('notify maps message and defaults the cue', async () => {
  const { posted, postCue } = okPost();
  await handleMessage(
    rpc('tools/call', { name: 'notify', arguments: { message: 'Halfway through the migration' } }),
    postCue,
  );
  assert.equal(posted[0].cue, 'glow-pulse');
  assert.equal(posted[0].msg, 'Halfway through the migration');
});

test('every payload the tools emit passes the webhook validator', async () => {
  const { posted, postCue } = okPost();
  await handleMessage(rpc('tools/call', { name: 'task_complete', arguments: { summary: 'done' } }), postCue);
  await handleMessage(rpc('tools/call', { name: 'task_complete', arguments: { summary: 'x', success: false } }), postCue);
  await handleMessage(rpc('tools/call', {
    name: 'notify',
    arguments: { message: 'hi', cue: 'comet', color: '#ff0000', urgent: true },
  }), postCue);

  for (const payload of posted) {
    assert.ok(sanitizeCuePayload(payload), `payload must survive validation: ${JSON.stringify(payload)}`);
  }
});

test('missing required arguments are an invalid-params error, not a cue', async () => {
  const { posted, postCue } = okPost();
  const response = await handleMessage(rpc('tools/call', { name: 'task_complete', arguments: {} }), postCue);
  assert.equal(response.error.code, -32602);
  assert.equal(posted.length, 0);
});

test('unknown tools and methods return JSON-RPC errors', async () => {
  const { postCue } = okPost();
  const badTool = await handleMessage(rpc('tools/call', { name: 'launch_missiles', arguments: {} }), postCue);
  assert.equal(badTool.error.code, -32602);

  const badMethod = await handleMessage(rpc('resources/list'), postCue);
  assert.equal(badMethod.error.code, -32601);
});

test('a failed delivery is reported as a tool error result', async () => {
  const response = await handleMessage(
    rpc('tools/call', { name: 'notify', arguments: { message: 'hi' } }),
    async () => ({ ok: false, error: 'Periphery is not running on port 49123' }),
  );
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /not running/);
});

test('notifications and malformed messages get no response', async () => {
  const { postCue } = okPost();
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, postCue), null);
  assert.equal(await handleMessage({ hello: 'world' }, postCue), null);
  assert.equal(await handleMessage(null, postCue), null);
});

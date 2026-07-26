'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { startWebhookServer, HOST } = require('../server/webhookServer');

/**
 * Boots the receiver on an ephemeral port.
 * @returns {Promise<{port: number, cues: object[], close: () => Promise<void>}>}
 */
async function withServer() {
  const cues = [];
  const resolves = [];
  const server = startWebhookServer({
    onCue: (payload) => cues.push(payload),
    // Pretends one blocked agent was cleared, so the response shape is exercised.
    onResolve: (request) => { resolves.push(request); return 1; },
    port: 0,
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address();
  return {
    port,
    cues,
    resolves,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function postTo(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function post(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('binds to loopback only', async () => {
  const { port, close } = await withServer();
  try {
    // A LAN-reachable bind was the difference between the documented threat
    // model and the actual one.
    assert.equal(HOST, '127.0.0.1');
    const res = await post(port, { cue: 'comet' });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test('accepts a valid cue and forwards the sanitized payload', async () => {
  const { port, cues, close } = await withServer();
  try {
    const res = await post(port, { cue: 'glow-pulse', color: 'rgba(0,150,255,0.6)', msg: 'Hello' });
    assert.equal(res.status, 200);
    assert.deepEqual(cues, [{ cue: 'glow-pulse', color: 'rgba(0,150,255,0.6)', msg: 'Hello' }]);
  } finally {
    await close();
  }
});

test('rejects an unknown cue with 400 and forwards nothing', async () => {
  const { port, cues, close } = await withServer();
  try {
    const res = await post(port, { cue: 'wat' });
    assert.equal(res.status, 400);
    assert.equal(cues.length, 0);
  } finally {
    await close();
  }
});

test('strips a CSS-injecting color instead of passing it through', async () => {
  const { port, cues, close } = await withServer();
  try {
    await post(port, { cue: 'comet', color: 'red; background: url(https://attacker.example/leak)' });
    assert.equal(cues[0].color, undefined);
  } finally {
    await close();
  }
});

test('strips a remote icon URL', async () => {
  const { port, cues, close } = await withServer();
  try {
    await post(port, { cue: 'comet', msg: 'x', icon: 'https://attacker.example/pixel.png' });
    assert.equal(cues[0].icon, undefined);
  } finally {
    await close();
  }
});

test('rejects requests carrying a browser Origin header', async () => {
  const { port, cues, close } = await withServer();
  try {
    const res = await post(port, { cue: 'comet' }, { Origin: 'https://attacker.example' });
    assert.equal(res.status, 403);
    assert.equal(cues.length, 0);
  } finally {
    await close();
  }
});

/**
 * fetch forbids setting Host, so a DNS-rebinding request has to be made with
 * the raw http client.
 * @returns {Promise<number>} the response status code
 */
function postWithHost(port, host, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/notify',
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('rejects a rebound Host header', async () => {
  const { port, cues, close } = await withServer();
  try {
    assert.equal(await postWithHost(port, 'attacker.example', { cue: 'comet' }), 403);
    assert.equal(cues.length, 0);
  } finally {
    await close();
  }
});

test('accepts the loopback Host names a local client actually sends', async () => {
  const { port, cues, close } = await withServer();
  try {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      assert.equal(await postWithHost(port, host, { cue: 'comet' }), 200, host);
    }
    assert.equal(cues.length, 3);
  } finally {
    await close();
  }
});

test('sends no CORS headers', async () => {
  const { port, close } = await withServer();
  try {
    const res = await post(port, { cue: 'comet' });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    await close();
  }
});

test('malformed JSON is a 400, not a crash', async () => {
  const { port, close } = await withServer();
  try {
    const res = await post(port, '{ nope');
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test('an oversized body is refused', async () => {
  const { port, cues, close } = await withServer();
  try {
    const res = await post(port, { cue: 'comet', msg: 'x'.repeat(50_000) });
    assert.equal(res.status, 400);
    assert.equal(cues.length, 0);
  } finally {
    await close();
  }
});

test('a port collision is reported instead of throwing', async () => {
  const first = await withServer();
  try {
    const errors = [];
    const second = startWebhookServer({
      onCue: () => {},
      port: first.port,
      onError: (err) => errors.push(err),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'EADDRINUSE');
    second.close();
  } finally {
    await first.close();
  }
});

// --- /resolve: the clear half of the state-cue primitive --------------------

test('/resolve clears a blocked agent by ref', async () => {
  const { port, resolves, close } = await withServer();
  try {
    const res = await postTo(port, '/resolve', { ref: 'mig-1' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.cleared, 1);
    assert.deepEqual(resolves, [{ ref: 'mig-1', all: false }]);
  } finally {
    await close();
  }
});

test('/resolve accepts {all: true}', async () => {
  const { port, resolves, close } = await withServer();
  try {
    const res = await postTo(port, '/resolve', { all: true });
    assert.equal(res.status, 200);
    assert.deepEqual(resolves, [{ all: true }]);
  } finally {
    await close();
  }
});

test('/resolve rejects a request that names nothing', async () => {
  const { port, resolves, close } = await withServer();
  try {
    const res = await postTo(port, '/resolve', {});
    assert.equal(res.status, 400);
    assert.equal(resolves.length, 0);
  } finally {
    await close();
  }
});

test('/health advertises the state cues', async () => {
  const { port, close } = await withServer();
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.ok(body.cues.includes('glow-blocked'));
    assert.deepEqual(body.stateCues, ['glow-blocked']);
    assert.ok(body.icons.includes('blocked'));
  } finally {
    await close();
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TeamsPresenceMonitor, presenceHolds } = require('../utils/teamsPresence');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function makeMonitor({ responses, token = 'graph-token' }) {
  const changes = [];
  const authFailures = [];
  let call = 0;
  const monitor = new TeamsPresenceMonitor({
    getToken: () => token,
    onChange: (hold) => changes.push(hold),
    onAuthFailure: (msg) => authFailures.push(msg),
    fetchFn: async () => {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  });
  monitor.running = true; // drive poll() directly; no timers in tests
  return { monitor, changes, authFailures };
}

test('presenceHolds maps DND and call-like activities, and nothing else', () => {
  assert.equal(presenceHolds({ availability: 'DoNotDisturb', activity: 'DoNotDisturb' }), true);
  // Teams "Focusing" surfaces as DoNotDisturb availability through Graph.
  assert.equal(presenceHolds({ availability: 'DoNotDisturb', activity: 'Focusing' }), true);
  assert.equal(presenceHolds({ availability: 'Busy', activity: 'InACall' }), true);
  assert.equal(presenceHolds({ availability: 'Busy', activity: 'InAMeeting' }), true);
  assert.equal(presenceHolds({ availability: 'Busy', activity: 'Presenting' }), true);

  assert.equal(presenceHolds({ availability: 'Available', activity: 'Available' }), false);
  assert.equal(presenceHolds({ availability: 'Busy', activity: 'Busy' }), false, 'a calendar block alone is not a hold');
  assert.equal(presenceHolds({ availability: 'Away', activity: 'Away' }), false);
  assert.equal(presenceHolds(null), false);
  assert.equal(presenceHolds({}), false);
});

test('reports transitions once per change, not once per poll', async () => {
  const { monitor, changes } = makeMonitor({
    responses: [
      jsonResponse(200, { availability: 'Available', activity: 'Available' }),
      jsonResponse(200, { availability: 'Busy', activity: 'InACall' }),
      jsonResponse(200, { availability: 'Busy', activity: 'InACall' }),
      jsonResponse(200, { availability: 'Available', activity: 'Available' }),
    ],
  });

  await monitor.poll();
  await monitor.poll();
  await monitor.poll();
  await monitor.poll();

  assert.deepEqual(changes, [true, false]);
});

test('a failed poll keeps the last known state', async () => {
  const { monitor, changes } = makeMonitor({
    responses: [
      jsonResponse(200, { availability: 'Busy', activity: 'InACall' }),
      jsonResponse(500, {}),
      new Error('network down'),
    ],
  });

  await monitor.poll();
  await monitor.poll();
  await monitor.poll();

  assert.deepEqual(changes, [true], 'errors must not flap the hold state');
});

test('an expired token fails open: hold released, reported once, polling stops', async () => {
  const { monitor, changes, authFailures } = makeMonitor({
    responses: [
      jsonResponse(200, { availability: 'Busy', activity: 'InACall' }),
      jsonResponse(401, {}),
      jsonResponse(401, {}),
    ],
  });

  await monitor.poll();
  assert.deepEqual(changes, [true]);

  await monitor.poll();
  assert.deepEqual(changes, [true, false], 'auth failure must release the hold');
  assert.equal(monitor.running, false);
  assert.equal(authFailures.length, 1);

  await monitor.poll(); // stopped: no further reports
  assert.equal(authFailures.length, 1);
});

test('a missing token is an auth failure, not a crash', async () => {
  const { monitor, authFailures } = makeMonitor({ responses: [], token: null });
  await monitor.poll();
  assert.equal(authFailures.length, 1);
  assert.match(authFailures[0], /no Microsoft Graph token/i);
  assert.equal(monitor.running, false);
});

test('stop() releases an active hold', async () => {
  const { monitor, changes } = makeMonitor({
    responses: [jsonResponse(200, { availability: 'DoNotDisturb', activity: 'DoNotDisturb' })],
  });

  await monitor.poll();
  monitor.stop();

  assert.deepEqual(changes, [true, false]);
});

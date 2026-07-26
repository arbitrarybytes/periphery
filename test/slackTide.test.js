'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SlackTideQueue } = require('../utils/slackTide');

/**
 * Builds a queue with a controllable clock and idle time. staggerMs: 0 makes
 * flushes synchronous; the huge check interval keeps the real timer inert so
 * tests drive _check() directly, as the focusAssist tests do.
 */
function makeQueue(overrides = {}) {
  const state = { idleSeconds: 0, nowMs: 100_000 };
  const delivered = [];
  const queue = new SlackTideQueue({
    deliver: (payload) => delivered.push(payload),
    getIdleSeconds: () => state.idleSeconds,
    now: () => state.nowMs,
    checkIntervalMs: 60 * 60 * 1000,
    staggerMs: 0,
    ...overrides,
  });
  return { queue, delivered, state };
}

test('delivers immediately when the user is already pausing', () => {
  const { queue, delivered, state } = makeQueue();
  state.idleSeconds = 10;

  const held = queue.push({ cue: 'glow', msg: 'a' });
  assert.equal(held, false);
  assert.equal(delivered.length, 1);
  assert.equal(queue.size(), 0);
  queue.stop();
});

test('holds cues while the user is actively typing', () => {
  const { queue, delivered, state } = makeQueue();
  state.idleSeconds = 1;

  assert.equal(queue.push({ cue: 'glow', msg: 'a' }), true);
  assert.equal(delivered.length, 0);
  assert.equal(queue.size(), 1);
  queue.stop();
});

test('releases held cues, oldest first, once a pause arrives', () => {
  const { queue, delivered, state } = makeQueue();
  state.idleSeconds = 1;
  queue.push({ cue: 'glow', msg: 'first' });
  queue.push({ cue: 'glow', msg: 'second' });

  queue._check();
  assert.equal(delivered.length, 0, 'still typing: nothing released');

  state.idleSeconds = 7;
  queue._check();
  assert.deepEqual(delivered.map((p) => p.msg), ['first', 'second']);
  assert.equal(queue.size(), 0);
  queue.stop();
});

test('a cue is never held past maxHoldMs even without a pause', () => {
  const { queue, delivered, state } = makeQueue({ maxHoldMs: 90_000 });
  state.idleSeconds = 1;
  queue.push({ cue: 'glow', msg: 'stuck' });

  state.nowMs += 89_000;
  queue._check();
  assert.equal(delivered.length, 0, 'not overdue yet');

  state.nowMs += 2_000;
  queue._check();
  assert.equal(delivered.length, 1);
  queue.stop();
});

test('overflow beyond maxQueue collapses into one "+N more" cue', () => {
  const { queue, delivered, state } = makeQueue({ maxQueue: 2 });
  state.idleSeconds = 1;
  queue.push({ cue: 'glow', msg: 'a' });
  queue.push({ cue: 'glow', msg: 'b' });
  queue.push({ cue: 'glow', msg: 'c' });
  queue.push({ cue: 'glow', msg: 'd' });

  state.idleSeconds = 10;
  queue._check();
  assert.equal(delivered.length, 3);
  assert.equal(delivered[2].msg, '+2 more updates');
  assert.equal(delivered[2].cue, 'glow-bottom');
  queue.stop();
});

test('stop() drops the queue without delivering', () => {
  const { queue, delivered, state } = makeQueue();
  state.idleSeconds = 1;
  queue.push({ cue: 'glow', msg: 'a' });

  queue.stop();
  assert.equal(delivered.length, 0);
  assert.equal(queue.size(), 0);
});

test('flush with real stagger spaces deliveries out', async () => {
  const { queue, delivered, state } = makeQueue({ staggerMs: 10 });
  state.idleSeconds = 1;
  queue.push({ cue: 'glow', msg: 'a' });
  queue.push({ cue: 'glow', msg: 'b' });

  queue.flush();
  assert.deepEqual(delivered.map((p) => p.msg), ['a'], 'first cue is immediate');

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(delivered.map((p) => p.msg), ['a', 'b']);
  queue.stop();
});

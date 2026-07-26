'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BlockedAgentTracker } = require('../utils/blockedAgents');

function makeTracker({ level1Ms = 1000, level2Ms = 4000, maxAgeMs = 60000 } = {}) {
  let time = 0;
  const states = [];
  const tracker = new BlockedAgentTracker({
    onChange: (state) => states.push(state),
    now: () => time,
    tickMs: 60 * 60 * 1000, // effectively off; tick() is driven by hand
    level1Ms,
    level2Ms,
    maxAgeMs,
  });
  return { tracker, states, setTime: (t) => { time = t; } };
}

test('escalates through the three levels with age, and stops there', () => {
  const { tracker, setTime } = makeTracker();
  tracker.block({ msg: 'Approve deleting 3 files?', ref: 'a' });

  assert.equal(tracker.level(), 0, 'a fresh block is as quiet as a completion beacon');
  setTime(999);
  assert.equal(tracker.level(), 0);
  setTime(1000);
  assert.equal(tracker.level(), 1);
  setTime(4000);
  assert.equal(tracker.level(), 2);
  setTime(60 * 60 * 1000);
  assert.equal(tracker.level(), 2, 'escalation is bounded — it never becomes an alarm');
  tracker.stop();
});

test('a re-ping of the same block does not reset the escalation clock', () => {
  const { tracker, setTime } = makeTracker();
  tracker.block({ ref: 'a', msg: 'first' });
  setTime(3000);
  tracker.block({ ref: 'a', msg: 'still waiting' });

  assert.equal(tracker.count(), 1, 'the same ref is the same stall');
  setTime(4000);
  assert.equal(tracker.level(), 2, 'a chatty agent must not be able to stay quiet forever');
  assert.equal(tracker.state().entries[0].msg, 'still waiting', 'but the wording refreshes');
  tracker.stop();
});

test('escalation follows the oldest block, not the newest', () => {
  const { tracker, setTime } = makeTracker();
  tracker.block({ ref: 'old' });
  setTime(4000);
  tracker.block({ ref: 'new' });

  assert.equal(tracker.count(), 2);
  assert.equal(tracker.level(), 2, 'the oldest stall is the one costing time');

  tracker.resolve('old');
  assert.equal(tracker.level(), 0, 'clearing it de-escalates to the remaining fresh block');
  tracker.stop();
});

test('resolve clears exactly one block and reports whether it did', () => {
  const { tracker, states } = makeTracker();
  tracker.block({ ref: 'a' });
  tracker.block({ ref: 'b' });

  assert.equal(tracker.resolve('a'), true);
  assert.equal(tracker.count(), 1);
  assert.equal(tracker.resolve('a'), false, 'clearing twice is harmless and honest');
  assert.equal(tracker.resolve('nonexistent'), false);
  assert.equal(states.at(-1).count, 1);
  tracker.stop();
});

test('resolveAll clears everything and reports the count', () => {
  const { tracker, states } = makeTracker();
  tracker.block({ ref: 'a' });
  tracker.block({ ref: 'b' });

  assert.equal(tracker.resolveAll(), 2);
  assert.equal(tracker.count(), 0);
  assert.equal(states.at(-1).count, 0, 'the overlay is told to fade the beacon');
  assert.equal(tracker.resolveAll(), 0, 'and it is idempotent');
  tracker.stop();
});

test('blocks without a ref still register and can be cleared en masse', () => {
  const { tracker } = makeTracker();
  tracker.block({ msg: 'one' });
  tracker.block({ msg: 'two' });
  assert.equal(tracker.count(), 2, 'auto refs must not collide');
  assert.equal(tracker.resolveAll(), 2);
  tracker.stop();
});

test('an abandoned block eventually expires on its own', () => {
  const { tracker, setTime, states } = makeTracker({ maxAgeMs: 10000 });
  tracker.block({ ref: 'a' });

  setTime(9999);
  tracker.tick();
  assert.equal(tracker.count(), 1, 'still plausibly waiting');

  setTime(10000);
  tracker.tick();
  assert.equal(tracker.count(), 0, 'an agent this stale is dead, not waiting');
  assert.equal(states.at(-1).count, 0);
  tracker.stop();
});

test('a level change announces itself so the overlay can escalate', () => {
  const { tracker, setTime, states } = makeTracker();
  tracker.block({ ref: 'a' });
  assert.equal(states.length, 1);
  assert.equal(states[0].level, 0);

  tracker.tick();
  assert.equal(states.length, 1, 'no change, no announcement');

  setTime(1000);
  tracker.tick();
  assert.equal(states.length, 2);
  assert.equal(states[1].level, 1);
  tracker.stop();
});

test('state carries what the overlay and tray need', () => {
  const { tracker } = makeTracker();
  tracker.block({ ref: 'a', msg: 'Approve?', color: 'rgba(255, 122, 89, 0.9)' });

  const state = tracker.state();
  assert.equal(state.count, 1);
  assert.equal(state.level, 0);
  assert.deepEqual(state.entries[0], {
    ref: 'a', msg: 'Approve?', color: 'rgba(255, 122, 89, 0.9)', at: 0,
  });
  tracker.stop();
});

test('stop() drops everything without announcing', () => {
  const { tracker, states } = makeTracker();
  tracker.block({ ref: 'a' });
  const before = states.length;
  tracker.stop();
  assert.equal(states.length, before, 'shutdown must not fire cues into dying windows');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentAckWatcher } = require('../utils/agentBeacon');

function makeWatcher({ idle, minVisibleMs = 1000, maxLingerMs = 100000 }) {
  let time = 0;
  let acks = 0;
  const watcher = new AgentAckWatcher({
    getIdleSeconds: () => idle.value,
    onAcknowledge: () => { acks += 1; },
    now: () => time,
    minVisibleMs,
    maxLingerMs,
    activeIdleSeconds: 5,
    checkIntervalMs: 60 * 60 * 1000, // effectively off; check() is driven by hand
  });
  return {
    watcher,
    setTime: (t) => { time = t; },
    ackCount: () => acks,
  };
}

test('an active user still gets the minimum visible time', () => {
  const idle = { value: 0 }; // typing the whole while
  const { watcher, setTime, ackCount } = makeWatcher({ idle, minVisibleMs: 1000 });

  watcher.notifyDelivered();
  watcher.check();
  assert.equal(ackCount(), 0, 'no ack before minVisibleMs');

  setTime(1000);
  watcher.check();
  assert.equal(ackCount(), 1, 'active user + minimum time elapsed = acknowledged');
  watcher.stop();
});

test('an absent user keeps the beacon until they return, however long', () => {
  const idle = { value: 3600 }; // away
  const { watcher, setTime, ackCount } = makeWatcher({ idle, minVisibleMs: 1000, maxLingerMs: 50000 });

  watcher.notifyDelivered();
  setTime(40000);
  watcher.check();
  assert.equal(ackCount(), 0, 'no keyboard, no ack');

  idle.value = 1; // they are back
  watcher.check();
  assert.equal(ackCount(), 1);
  watcher.stop();
});

test('the linger cap acknowledges even without input (burn-in guard)', () => {
  const idle = { value: 3600 };
  const { watcher, setTime, ackCount } = makeWatcher({ idle, maxLingerMs: 50000 });

  watcher.notifyDelivered();
  setTime(50000);
  watcher.check();
  assert.equal(ackCount(), 1);
  watcher.stop();
});

test('a batch of beacons is acknowledged once, timed from the oldest', () => {
  const idle = { value: 0 };
  const { watcher, setTime, ackCount } = makeWatcher({ idle, minVisibleMs: 1000 });

  watcher.notifyDelivered();
  setTime(900);
  watcher.notifyDelivered(); // a second agent finishes just before the ack
  setTime(1000);
  watcher.check();

  assert.equal(ackCount(), 1, 'one ack fades every pending beacon');
  watcher.check();
  assert.equal(ackCount(), 1, 'nothing pending, nothing acknowledged');

  // The next delivery starts a fresh clock.
  watcher.notifyDelivered();
  watcher.check();
  assert.equal(ackCount(), 1, 'the new beacon gets its own minimum visible time');
  setTime(2000);
  watcher.check();
  assert.equal(ackCount(), 2);
  watcher.stop();
});

test('stop() drops pending beacons without acknowledging', () => {
  const idle = { value: 0 };
  const { watcher, setTime, ackCount } = makeWatcher({ idle, minVisibleMs: 1000 });

  watcher.notifyDelivered();
  watcher.stop();
  setTime(5000);
  watcher.check();
  assert.equal(ackCount(), 0);
});

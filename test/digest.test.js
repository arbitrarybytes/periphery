'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DigestLog, AwayTracker } = require('../utils/digest');

test('records message, icon, colour, and time; drain resets', () => {
  let time = 1000;
  const log = new DigestLog({ now: () => time });

  log.add({ msg: 'Pipeline passed', icon: 'gitlab', color: 'red', cue: 'glow' });
  time = 2000;
  log.add({ cue: 'glow' }); // a cue with no message still counts

  const { entries, total } = log.drain();
  assert.equal(total, 2);
  assert.deepEqual(entries[0], { msg: 'Pipeline passed', icon: 'gitlab', color: 'red', at: 1000 });
  assert.deepEqual(entries[1], { msg: null, icon: null, color: null, at: 2000 });

  assert.equal(log.size(), 0, 'drain must reset the log');
  assert.equal(log.drain().total, 0);
});

test('caps entries but keeps counting what was dropped', () => {
  const log = new DigestLog({ maxEntries: 3, now: () => 0 });
  for (let i = 0; i < 5; i++) log.add({ msg: `update ${i}` });

  assert.equal(log.size(), 5);
  const { entries, total } = log.drain();
  assert.equal(total, 5, 'the total must include dropped entries');
  assert.equal(entries.length, 3);
  assert.equal(entries[0].msg, 'update 2', 'the oldest entries are the ones dropped');
});

test('a short lock is not an absence', () => {
  let time = 0;
  const tracker = new AwayTracker({ thresholdMs: 1000, now: () => time });

  tracker.lock();
  time = 999;
  assert.deepEqual(tracker.unlock(), { away: false, awayMs: 999 });
});

test('a long lock is an absence, and unlock resets the tracker', () => {
  let time = 0;
  const tracker = new AwayTracker({ thresholdMs: 1000, now: () => time });

  tracker.lock();
  assert.equal(tracker.isLocked(), true);
  time = 5000;
  assert.deepEqual(tracker.unlock(), { away: true, awayMs: 5000 });
  assert.equal(tracker.isLocked(), false);
  assert.deepEqual(tracker.unlock(), { away: false, awayMs: 0 }, 'a stray unlock event is harmless');
});

test('a duplicate lock event keeps the original timestamp', () => {
  let time = 0;
  const tracker = new AwayTracker({ thresholdMs: 1000, now: () => time });

  tracker.lock();
  time = 900;
  tracker.lock(); // e.g. a second lock-screen event without an unlock
  time = 1100;
  assert.equal(tracker.unlock().away, true, 'the absence is measured from the first lock');
});

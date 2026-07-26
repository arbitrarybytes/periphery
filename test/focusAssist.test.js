'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FocusAssistMonitor } = require('../utils/focusAssist');

/**
 * Injectable stand-in for child_process.execFile that replies synchronously
 * with a scripted sequence of probe results.
 * @param {Array<{err?: Error, stdout?: string}>} replies - last entry repeats
 */
function fakeExec(replies) {
  let call = 0;
  const exec = (file, args, options, callback) => {
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    callback(reply.err || null, reply.stdout ?? '');
  };
  exec.calls = () => call;
  return exec;
}

/** Builds a started monitor and a log of its transitions. */
function startMonitor(replies) {
  const changes = [];
  const monitor = new FocusAssistMonitor({
    onChange: (dnd) => changes.push(dnd),
    intervalMs: 60 * 60 * 1000, // interval never fires during a test
    exec: fakeExec(replies),
  });
  monitor.start();
  return { monitor, changes };
}

test('reports do-not-disturb when Windows is not accepting notifications', () => {
  const { monitor, changes } = startMonitor([{ stdout: '4\r\n' }]);
  assert.deepEqual(changes, [true]);
  monitor.stop();
});

test('stays silent when the state is ACCEPTS_NOTIFICATIONS', () => {
  const { monitor, changes } = startMonitor([{ stdout: '5\n' }]);
  assert.deepEqual(changes, []);
  monitor.stop();
});

test('fires only on transitions, not on every probe', () => {
  const { monitor, changes } = startMonitor([{ stdout: '6' }]);
  monitor._probe();
  monitor._probe();
  assert.deepEqual(changes, [true]);
  monitor.stop();
});

test('a failed or garbled probe keeps the last known state', () => {
  const { monitor, changes } = startMonitor([
    { stdout: '6' },
    { err: new Error('spawn failed') },
    { stdout: 'not a number' },
  ]);
  monitor._probe();
  monitor._probe();
  assert.deepEqual(changes, [true]);
  monitor.stop();
});

test('stop() reports not-disturbed so held cues can be flushed', () => {
  const { monitor, changes } = startMonitor([{ stdout: '7' }]);
  assert.deepEqual(changes, [true]);
  monitor.stop();
  assert.deepEqual(changes, [true, false]);
});

test('start() is idempotent', () => {
  const { monitor, changes } = startMonitor([{ stdout: '4' }]);
  monitor.start();
  monitor.start();
  assert.deepEqual(changes, [true]);
  monitor.stop();
});

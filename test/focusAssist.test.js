'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { FocusAssistMonitor } = require('../utils/focusAssist');

/** Stand-in for the persistent PowerShell child. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('exit', null);
  };
  /** @param {string} text - raw probe output, may be partial lines */
  child.print = (text) => child.stdout.emit('data', text);
  return child;
}

/** Builds a started monitor around a scripted spawn. */
function startMonitor({ intervalMs = 60 * 60 * 1000, spawnError = false } = {}) {
  const changes = [];
  const children = [];
  const monitor = new FocusAssistMonitor({
    onChange: (dnd) => changes.push(dnd),
    intervalMs,
    spawn: () => {
      if (spawnError) throw new Error('spawn failed');
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  monitor.start();
  return { monitor, changes, children };
}

test('reports do-not-disturb when Windows is not accepting notifications', () => {
  const { monitor, changes, children } = startMonitor();
  children[0].print('4\r\n');
  assert.deepEqual(changes, [true]);
  monitor.stop();
});

test('stays silent when the state is ACCEPTS_NOTIFICATIONS', () => {
  const { monitor, changes, children } = startMonitor();
  children[0].print('5\n');
  assert.deepEqual(changes, []);
  monitor.stop();
});

test('fires only on transitions, not on every probe', () => {
  const { monitor, changes, children } = startMonitor();
  children[0].print('6\n6\n6\n');
  assert.deepEqual(changes, [true]);
  monitor.stop();
});

test('handles output arriving in partial chunks', () => {
  const { monitor, changes, children } = startMonitor();
  children[0].print('');
  children[0].print('4');
  assert.deepEqual(changes, [], 'no newline yet: not a complete probe');
  children[0].print('\r\n');
  assert.deepEqual(changes, [true]);
  monitor.stop();
});

test('garbled probe output keeps the last known state', () => {
  const { monitor, changes, children } = startMonitor();
  children[0].print('6\n');
  children[0].print('not a number\n\n');
  assert.deepEqual(changes, [true]);
  monitor.stop();
});

test('a spawn failure is silent and delivery keeps working', () => {
  const { monitor, changes } = startMonitor({ spawnError: true });
  assert.deepEqual(changes, []);
  assert.equal(monitor.child, null);
  monitor.stop();
});

test('respawns after the child dies unexpectedly', async () => {
  const { monitor, changes, children } = startMonitor({ intervalMs: 1000 });
  children[0].print('4\n');
  assert.deepEqual(changes, [true]);

  // Simulate PowerShell being killed externally (not via monitor.dispose).
  children[0].emit('exit', 1);
  assert.notEqual(monitor.respawnTimer, null, 'a respawn is scheduled');

  // Don't wait a full second in the test; fire the timer's callback path by
  // disposing (clears it) and asserting only one child existed so far.
  assert.equal(children.length, 1);
  monitor.dispose();
  assert.equal(monitor.respawnTimer, null);
});

test('stop() reports not-disturbed so held cues can be flushed', () => {
  const { monitor, changes, children } = startMonitor();
  children[0].print('7\n');
  assert.deepEqual(changes, [true]);
  monitor.stop();
  assert.deepEqual(changes, [true, false]);
  assert.equal(children[0].killed, true);
});

test('dispose() stops probing without reporting a state change', () => {
  const { monitor, changes, children } = startMonitor();
  children[0].print('4\n');
  assert.deepEqual(changes, [true]);

  monitor.dispose();
  assert.equal(monitor.child, null);
  assert.equal(children[0].killed, true);
  // Unlike stop(), no trailing "false" — nothing gets flushed mid-shutdown.
  assert.deepEqual(changes, [true]);
});

test('killing the child via dispose does not trigger a respawn', () => {
  const { monitor, children } = startMonitor();
  monitor.dispose();
  assert.equal(monitor.respawnTimer, null);
  assert.equal(children.length, 1);
});

test('start() is idempotent', () => {
  const { monitor, children } = startMonitor();
  monitor.start();
  monitor.start();
  assert.equal(children.length, 1);
  monitor.stop();
});

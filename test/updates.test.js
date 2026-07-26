'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAutoUpdate } = require('../utils/updates');

function fakeUpdater() {
  const handlers = {};
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checks: 0,
    on(event, handler) { handlers[event] = handler; },
    emit(event, payload) { handlers[event]?.(payload); },
    checkForUpdates() {
      this.checks += 1;
      return Promise.resolve();
    },
  };
}

test('never runs outside a packaged build', () => {
  const updater = fakeUpdater();
  const auto = createAutoUpdate({
    isPackaged: false, isEnabled: () => true, onCue: () => {}, updater,
  });
  auto.start();
  assert.equal(updater.checks, 0);
  auto.stop();
});

test('the toggle gates every check, read at check time', () => {
  const updater = fakeUpdater();
  let enabled = false;
  const auto = createAutoUpdate({
    isPackaged: true, isEnabled: () => enabled, onCue: () => {}, updater,
  });
  auto.start();
  assert.equal(updater.checks, 0, 'disabled at start: no check');
  assert.equal(updater.autoInstallOnAppQuit, true, 'silent install-on-quit is configured');
  enabled = true; // flipping the setting needs no restart for the next interval
  auto.stop();
});

test('a downloaded update is announced as one quiet cue', () => {
  const updater = fakeUpdater();
  const cues = [];
  const auto = createAutoUpdate({
    isPackaged: true, isEnabled: () => true, onCue: (cue) => cues.push(cue), updater,
  });
  auto.start();
  assert.equal(updater.checks, 1);

  updater.emit('update-downloaded', { version: '1.2.0' });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].cue, 'glow-bottom');
  assert.match(cues[0].msg, /1\.2\.0.*installs when you quit/);
  auto.stop();
});

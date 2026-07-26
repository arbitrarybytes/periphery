'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeCuePayload,
  isValidColor,
  sanitizeMessage,
  clampRepeats,
  glowSpeedFactor,
  MSG_MAX_LENGTH,
  REPEATS_DEFAULT,
} = require('../utils/cuePayload');

test('accepts a well-formed payload', () => {
  assert.deepEqual(
    sanitizeCuePayload({ cue: 'comet', color: 'rgba(0, 150, 255, 0.9)', msg: 'Hi', icon: 'gitlab' }),
    { cue: 'comet', color: 'rgba(0, 150, 255, 0.9)', msg: 'Hi', icon: 'gitlab' },
  );
});

test('rejects payloads without a known cue', () => {
  assert.equal(sanitizeCuePayload({ cue: 'nope' }), null);
  assert.equal(sanitizeCuePayload({ cue: 'cue-glow' }), null, 'the cue- prefix is added by the renderer');
  assert.equal(sanitizeCuePayload({}), null);
  assert.equal(sanitizeCuePayload(null), null);
  assert.equal(sanitizeCuePayload('comet'), null);
});

test('rejects a cue name that would break classList.add', () => {
  assert.equal(sanitizeCuePayload({ cue: 'glow pulse' }), null);
  assert.equal(sanitizeCuePayload({ cue: '' }), null);
});

test('drops colors that could smuggle extra CSS declarations', () => {
  const injected = 'red; background: url(https://attacker.example/leak)';
  assert.equal(isValidColor(injected), false);
  assert.equal(sanitizeCuePayload({ cue: 'comet', color: injected }).color, undefined);
});

test('accepts hex, rgb, rgba and named colors', () => {
  for (const color of ['#fff', '#ffffff', '#ffffffcc', 'rgb(1,2,3)', 'rgba(1, 2, 3, .5)', 'Red']) {
    assert.equal(isValidColor(color), true, color);
  }
});

test('rejects out-of-range color components', () => {
  assert.equal(isValidColor('rgb(256, 0, 0)'), false);
  assert.equal(isValidColor('rgba(0, 0, 0, 2)'), false);
  assert.equal(isValidColor('rgb(0, 0)'), false);
});

test('only bundled icon names survive, never URLs', () => {
  assert.equal(sanitizeCuePayload({ cue: 'comet', icon: 'outlook' }).icon, 'outlook');
  assert.equal(sanitizeCuePayload({ cue: 'comet', icon: 'https://img.example/x.png' }).icon, undefined);
  assert.equal(sanitizeCuePayload({ cue: 'comet', icon: '../../etc/passwd' }).icon, undefined);
});

test('messages are stripped of control characters and length-capped', () => {
  assert.equal(sanitizeMessage('ab\nc'), 'a b c');
  assert.equal(sanitizeMessage('   '), undefined);
  assert.equal(sanitizeMessage(42), undefined);
  assert.equal(sanitizeMessage('x'.repeat(500)).length, MSG_MAX_LENGTH);
});

test('urgent survives only as the literal true', () => {
  assert.equal(sanitizeCuePayload({ cue: 'glow-pulse', urgent: true }).urgent, true);
  assert.equal(sanitizeCuePayload({ cue: 'glow-pulse', urgent: 'yes' }).urgent, undefined);
  assert.equal(sanitizeCuePayload({ cue: 'glow-pulse', urgent: 1 }).urgent, undefined);
  assert.equal(sanitizeCuePayload({ cue: 'glow-pulse' }).urgent, undefined);
});

test('glowSpeedFactor maps tortoise to slower and hare to faster', () => {
  assert.equal(glowSpeedFactor(1), 2, 'super slow doubles the duration');
  assert.equal(glowSpeedFactor(3), 1, 'medium is the unchanged baseline');
  assert.ok(glowSpeedFactor(5) < glowSpeedFactor(4), 'monotonic toward the hare');
  assert.ok(glowSpeedFactor(5) <= 0.5, 'super fast at least halves the duration');
});

test('glowSpeedFactor clamps garbage to the medium baseline or range edges', () => {
  assert.equal(glowSpeedFactor(undefined), 1);
  assert.equal(glowSpeedFactor(null), 1);
  assert.equal(glowSpeedFactor('nope'), 1);
  assert.equal(glowSpeedFactor(0), glowSpeedFactor(1), 'below range pins to tortoise');
  assert.equal(glowSpeedFactor(99), glowSpeedFactor(5), 'above range pins to hare');
  assert.equal(glowSpeedFactor('4'), glowSpeedFactor(4), 'numeric strings accepted');
});

test('clampRepeats never yields NaN', () => {
  // A blank number field in Settings used to persist NaN, which made
  // setTimeout(fn, NaN) fire immediately and hide the glow.
  assert.equal(clampRepeats(NaN), REPEATS_DEFAULT);
  assert.equal(clampRepeats(undefined), REPEATS_DEFAULT);
  assert.equal(clampRepeats(null), REPEATS_DEFAULT);
  assert.equal(clampRepeats(''), REPEATS_DEFAULT);
  assert.equal(clampRepeats('7'), 7);
  assert.equal(clampRepeats(0), 1);
  assert.equal(clampRepeats(1000), 10);
  assert.equal(clampRepeats(3.4), 3);
});

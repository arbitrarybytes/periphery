'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FALLBACK_ACCENT,
  parseAccentColor,
  accentCss,
  cueTier,
  shouldDefer,
  isDoNotDisturb,
  countHeldIcons,
  deferredSummaryCue,
} = require('../utils/win11');
const { sanitizeCuePayload, isValidColor } = require('../utils/cuePayload');

test('parseAccentColor handles the RRGGBBAA form systemPreferences returns', () => {
  assert.deepEqual(parseAccentColor('0067c0ff'), { r: 0, g: 103, b: 192 });
  assert.deepEqual(parseAccentColor('#0067C0'), { r: 0, g: 103, b: 192 });
});

test('parseAccentColor rejects garbage instead of guessing', () => {
  assert.equal(parseAccentColor(undefined), null);
  assert.equal(parseAccentColor(''), null);
  assert.equal(parseAccentColor('red'), null);
  assert.equal(parseAccentColor('0067c'), null);
});

test('accentCss produces a colour the cue validator accepts', () => {
  assert.equal(isValidColor(accentCss(FALLBACK_ACCENT, 0.85)), true);
  assert.equal(isValidColor(accentCss({ r: 255, g: 0, b: 128 })), true);
});

test('cue tiers follow the attention hierarchy', () => {
  assert.equal(cueTier({ cue: 'comet' }), 1);
  assert.equal(cueTier({ cue: 'glow-pulse' }), 2);
  assert.equal(cueTier({ cue: 'glow-bottom' }), 3);
});

test('the urgent flag forces tier 1 regardless of cue', () => {
  assert.equal(cueTier({ cue: 'glow-pulse', urgent: true }), 1);
  assert.equal(shouldDefer({ cue: 'glow-pulse', urgent: true }, true), false);
  // The icon is purely decorative; it must never affect routing.
  assert.equal(cueTier({ cue: 'glow-pulse', icon: 'calendar' }), 2);
});

test('shouldDefer holds ambient cues only while focused', () => {
  assert.equal(shouldDefer({ cue: 'glow-bottom' }, true), true);
  assert.equal(shouldDefer({ cue: 'glow-bottom' }, false), false);
  // Tier 1 breaks through focus.
  assert.equal(shouldDefer({ cue: 'comet' }, true), false);
});

test('isDoNotDisturb: only ACCEPTS_NOTIFICATIONS (5) means deliver', () => {
  assert.equal(isDoNotDisturb(5), false);
  for (const state of [1, 2, 3, 4, 6, 7]) {
    assert.equal(isDoNotDisturb(state), true, `state ${state}`);
  }
});

test('isDoNotDisturb treats out-of-range or non-integer input as deliverable', () => {
  assert.equal(isDoNotDisturb(0), false);
  assert.equal(isDoNotDisturb(8), false);
  assert.equal(isDoNotDisturb(NaN), false);
  assert.equal(isDoNotDisturb('6'), false);
});

test('countHeldIcons tallies by source, bucketing icon-less cues as other', () => {
  assert.deepEqual(
    countHeldIcons([
      { icon: 'gitlab' }, { icon: 'gitlab' }, { icon: 'outlook' }, { icon: null }, {},
    ]),
    { gitlab: 2, outlook: 1, other: 2 },
  );
  assert.deepEqual(countHeldIcons([]), {});
});

test('the summary includes a per-source breakdown and stays within the cap', () => {
  const cue = deferredSummaryCue(4, accentCss(FALLBACK_ACCENT, 0.7), { gitlab: 3, outlook: 1 });
  assert.equal(cue.msg, '4 updates arrived while you were focused — gitlab 3, outlook 1');
  assert.ok(cue.msg.length <= 160);
  assert.notEqual(sanitizeCuePayload(cue), null);
});

test('the deferred summary is a valid payload with correct pluralisation', () => {
  const one = deferredSummaryCue(1, accentCss(FALLBACK_ACCENT, 0.7));
  const many = deferredSummaryCue(4, accentCss(FALLBACK_ACCENT, 0.7));

  assert.match(one.msg, /^1 update arrived/);
  assert.match(many.msg, /^4 updates arrived/);
  // The summary must survive the same validation as any untrusted cue.
  assert.notEqual(sanitizeCuePayload(one), null);
  assert.notEqual(sanitizeCuePayload(many), null);
});

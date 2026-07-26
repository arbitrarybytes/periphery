'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { drawBadgeDot } = require('../utils/trayBadge');

const WIDTH = 16;
const HEIGHT = 16;
const ACCENT = { r: 10, g: 20, b: 30 };

/** @returns {Buffer} a fully transparent BGRA bitmap */
function blankBitmap() {
  return Buffer.alloc(WIDTH * HEIGHT * 4);
}

/** @returns {number[]} [b, g, r, a] at the given pixel */
function pixelAt(buf, x, y) {
  const i = (y * WIDTH + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

test('draws an opaque accent dot in BGRA order at the bottom-right', () => {
  const out = drawBadgeDot(blankBitmap(), WIDTH, HEIGHT, ACCENT);
  // Dot centre: radius 4, centred at (12, 12) for a 16px icon.
  assert.deepEqual(pixelAt(out, 12, 12), [ACCENT.b, ACCENT.g, ACCENT.r, 255]);
});

test('leaves pixels outside the dot untouched', () => {
  const out = drawBadgeDot(blankBitmap(), WIDTH, HEIGHT, ACCENT);
  assert.deepEqual(pixelAt(out, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(out, 15, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(out, 0, 15), [0, 0, 0, 0]);
});

test('never mutates the caller\'s base icon bitmap', () => {
  const input = blankBitmap();
  const out = drawBadgeDot(input, WIDTH, HEIGHT, ACCENT);
  assert.notEqual(out, input);
  assert.deepEqual(input, blankBitmap());
});

test('rejects a bitmap whose length does not match its dimensions', () => {
  assert.throws(() => drawBadgeDot(Buffer.alloc(10), WIDTH, HEIGHT, ACCENT));
  assert.throws(() => drawBadgeDot('not a buffer', WIDTH, HEIGHT, ACCENT));
});

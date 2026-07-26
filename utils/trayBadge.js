'use strict';

/**
 * Composites a status dot onto a tray-icon bitmap. Pure Buffer math — no
 * Electron — the caller supplies `nativeImage.toBitmap()` output and feeds
 * the result back to `nativeImage.createFromBitmap()`.
 *
 * The pixel layout is the 32-bit BGRA Electron produces on Windows. On other
 * platforms the dot's red/blue channels may swap, which is acceptable for a
 * Windows-first affordance drawn in the user's own accent colour.
 */

/** Dot diameter as a fraction of the icon's smaller side. */
const DOT_SCALE = 0.5;

/**
 * @param {Buffer} bitmap - BGRA pixels; never modified
 * @param {number} width
 * @param {number} height
 * @param {{r: number, g: number, b: number}} color
 * @returns {Buffer} a copy with an opaque dot drawn in the bottom-right corner
 */
function drawBadgeDot(bitmap, width, height, color) {
  if (!Buffer.isBuffer(bitmap) || bitmap.length !== width * height * 4) {
    throw new Error('bitmap length does not match the given dimensions');
  }

  const out = Buffer.from(bitmap);
  const radius = (Math.min(width, height) * DOT_SCALE) / 2;
  const cx = width - radius;
  const cy = height - radius;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (dist >= radius) continue;

      // Feather the outer pixel so the dot is not jagged at 16px tray sizes.
      const cover = Math.min(1, radius - dist);
      const keep = 1 - cover;
      const i = (y * width + x) * 4;
      out[i] = Math.round(color.b * cover + out[i] * keep);
      out[i + 1] = Math.round(color.g * cover + out[i + 1] * keep);
      out[i + 2] = Math.round(color.r * cover + out[i + 2] * keep);
      out[i + 3] = Math.round(255 * cover + out[i + 3] * keep);
    }
  }
  return out;
}

module.exports = { drawBadgeDot, DOT_SCALE };

'use strict';

/**
 * Validation for cue payloads arriving from untrusted sources (the local
 * webhook receiver). Nothing here touches Electron, so it is unit-testable
 * and portable to the eventual Tauri backend (see docs/ADR.md).
 *
 * The renderer builds CSS values and image sources out of these fields, so
 * every one of them is checked against an allowlist rather than sanitised.
 */

/** Cue names accepted by the renderer. `cue-<name>` must exist in styles.css. */
const CUE_NAMES = Object.freeze(['glow', 'glow-bottom', 'glow-pulse', 'comet']);

/**
 * Bundled icons, resolved by the renderer to `assets/icons/<name>.svg`.
 * Keeping this an allowlist of local files means a payload can never point
 * the overlay at a remote URL. Keep in sync with the copy in renderer.js.
 */
const ICON_NAMES = Object.freeze(['gitlab', 'outlook', 'calendar', 'pomodoro', 'alert']);

const MSG_MAX_LENGTH = 160;
const REPEATS_MIN = 1;
const REPEATS_MAX = 10;
const REPEATS_DEFAULT = 3;

const CUES = new Set(CUE_NAMES);
const ICONS = new Set(ICON_NAMES);

const NAMED_COLORS = new Set([
  'red', 'green', 'blue', 'orange', 'yellow', 'purple', 'cyan', 'magenta',
  'white', 'black', 'gray', 'grey', 'teal', 'pink', 'lime', 'gold', 'silver',
]);

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d+(?:\.\d+)?|\.\d+)\s*)?\)$/i;

const SPACE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/**
 * A colour is only accepted if it parses as an exact hex / rgb() / rgba()
 * literal or a known keyword. Anything else could smuggle extra declarations
 * into the inline style the renderer builds (e.g. a `url()` that phones home).
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidColor(value) {
  if (typeof value !== 'string') return false;
  const color = value.trim();
  if (color.length === 0 || color.length > 32) return false;
  if (HEX_COLOR.test(color)) return true;
  if (NAMED_COLORS.has(color.toLowerCase())) return true;

  const match = RGB_COLOR.exec(color);
  if (!match) return false;
  if (Number(match[1]) > 255 || Number(match[2]) > 255 || Number(match[3]) > 255) return false;
  return match[4] === undefined || Number(match[4]) <= 1;
}

/**
 * Replaces control characters with spaces so a message cannot break the
 * single-line layout of the kinetic-typography pill.
 * @param {string} value
 * @returns {string}
 */
function stripControlChars(value) {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    out += code < SPACE_CODE || code === DELETE_CODE ? ' ' : char;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string|undefined} the trimmed, length-capped message
 */
function sanitizeMessage(value) {
  if (typeof value !== 'string') return undefined;
  const msg = stripControlChars(value).trim().slice(0, MSG_MAX_LENGTH);
  return msg.length > 0 ? msg : undefined;
}

/**
 * Coerces a pulse-repeat count into a usable integer. Guards the renderer
 * against `NaN` (which would make setTimeout fire immediately) and against
 * absurd values that would pin an animation on screen.
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function clampRepeats(value, fallback = REPEATS_DEFAULT) {
  // A blank field means "use the default", not zero.
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return fallback;
  return Math.min(REPEATS_MAX, Math.max(REPEATS_MIN, Math.round(num)));
}

/**
 * Validates an inbound cue payload.
 * @param {unknown} raw
 * @returns {{cue: string, color?: string, msg?: string, icon?: string}|null}
 *   null when the payload is unusable and the request should be rejected.
 */
function sanitizeCuePayload(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  if (typeof raw.cue !== 'string' || !CUES.has(raw.cue)) return null;

  const payload = { cue: raw.cue };
  if (isValidColor(raw.color)) payload.color = raw.color.trim();

  const msg = sanitizeMessage(raw.msg);
  if (msg) payload.msg = msg;

  if (typeof raw.icon === 'string' && ICONS.has(raw.icon)) payload.icon = raw.icon;

  return payload;
}

module.exports = {
  CUE_NAMES,
  ICON_NAMES,
  MSG_MAX_LENGTH,
  REPEATS_MIN,
  REPEATS_MAX,
  REPEATS_DEFAULT,
  isValidColor,
  sanitizeMessage,
  sanitizeCuePayload,
  clampRepeats,
};

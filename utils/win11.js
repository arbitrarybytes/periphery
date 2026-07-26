'use strict';

/**
 * Windows 11 integration helpers: accent-colour parsing, the attention-tier
 * rules used by focus deferral, and the SHQueryUserNotificationState mapping.
 * Pure functions only — nothing here imports Electron — so the logic stays
 * unit-testable and portable to the eventual Tauri backend (see docs/ADR.md).
 */

/** Windows 11 default accent ("blue"), used when the OS accent is unavailable. */
const FALLBACK_ACCENT = Object.freeze({ r: 0, g: 103, b: 192 });

/**
 * Parses the `RRGGBB[AA]` string returned by
 * `systemPreferences.getAccentColor()` (a leading `#` is tolerated).
 * @param {unknown} value
 * @returns {{r: number, g: number, b: number}|null}
 */
function parseAccentColor(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/**
 * @param {{r: number, g: number, b: number}} rgb
 * @param {number} [alpha]
 * @returns {string} an rgba() literal that passes utils/cuePayload.js validation
 */
function accentCss(rgb, alpha = 1) {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/**
 * Attention tier per cue, mirroring the README's Attention Hierarchy.
 * Tier 1 breaks through focus mode; tiers 2–3 are deferred while focused.
 */
const CUE_TIERS = Object.freeze({
  comet: 1,
  'glow-pulse': 2,
  glow: 2,
  'glow-bottom': 3,
});

/**
 * @param {{cue?: string, icon?: string}} payload
 * @returns {number}
 */
function cueTier(payload) {
  // Meeting reminders are time-critical; holding one until focus ends would
  // defeat its purpose, so the calendar icon always rides at tier 1.
  if (payload.icon === 'calendar') return 1;
  return CUE_TIERS[payload.cue] ?? 2;
}

/**
 * @param {{cue?: string, icon?: string}} payload
 * @param {boolean} focused
 * @returns {boolean} whether the cue should be held until focus ends
 */
function shouldDefer(payload, focused) {
  return focused && cueTier(payload) >= 2;
}

/**
 * SHQueryUserNotificationState value meaning "Windows would show a toast".
 * Every other documented state (busy, D3D full screen, presentation mode,
 * quiet time, Focus Assist / Do Not Disturb) means the OS itself would
 * suppress or queue a notification, so FlowState should hold its cues too.
 */
const QUNS_ACCEPTS_NOTIFICATIONS = 5;
const QUNS_MIN = 1;
const QUNS_MAX = 7;

/**
 * @param {unknown} state - integer from SHQueryUserNotificationState
 * @returns {boolean}
 */
function isDoNotDisturb(state) {
  return Number.isInteger(state)
    && state >= QUNS_MIN
    && state <= QUNS_MAX
    && state !== QUNS_ACCEPTS_NOTIFICATIONS;
}

const { MSG_MAX_LENGTH: SUMMARY_MSG_MAX } = require('./cuePayload');

/**
 * Tallies held cues by their source icon for the flush summary.
 * @param {Array<{icon?: string|null}>} heldCues
 * @returns {Record<string, number>} e.g. { gitlab: 3, outlook: 1, other: 2 }
 */
function countHeldIcons(heldCues) {
  const counts = {};
  for (const held of heldCues) {
    const key = typeof held.icon === 'string' && held.icon.length > 0 ? held.icon : 'other';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * The single ambient cue flushed when focus ends and cues were held.
 * @param {number} count
 * @param {string} color - an rgba() literal, normally the accent colour
 * @param {Record<string, number>|null} [iconCounts] - from countHeldIcons
 * @returns {{cue: string, color: string, msg: string, icon: string}}
 */
function deferredSummaryCue(count, color, iconCounts = null) {
  let msg = count === 1
    ? '1 update arrived while you were focused'
    : `${count} updates arrived while you were focused`;

  if (iconCounts) {
    const parts = Object.entries(iconCounts)
      .filter(([, n]) => n > 0)
      .map(([icon, n]) => `${icon} ${n}`);
    if (parts.length > 0) msg += ` — ${parts.join(', ')}`;
  }

  return {
    cue: 'glow-bottom',
    color,
    msg: msg.slice(0, SUMMARY_MSG_MAX),
    icon: 'alert',
  };
}

module.exports = {
  FALLBACK_ACCENT,
  parseAccentColor,
  accentCss,
  cueTier,
  shouldDefer,
  isDoNotDisturb,
  countHeldIcons,
  deferredSummaryCue,
};

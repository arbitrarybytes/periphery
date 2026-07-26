'use strict';

/**
 * Overlay renderer. Runs sandboxed with context isolation, so it cannot
 * require shared modules; the allowlists below mirror utils/cuePayload.js,
 * which remains the source of truth and the authoritative validator.
 */

const CUE_CLASSES = {
  glow: 'cue-glow',
  'glow-bottom': 'cue-glow-bottom',
  'glow-pulse': 'cue-glow-pulse',
};
const ICON_NAMES = ['gitlab', 'outlook', 'calendar', 'pomodoro', 'alert'];

const PULSE_DURATION_MS = 1500;
const BREATHE_DURATION_MS = 4000;
const COMET_DURATION_MS = 8000;
const TEXT_DURATION_MS = 6000;
const ANIMATION_PADDING_MS = 100;
const REPEATS_MIN = 1;
const REPEATS_MAX = 10;
const REPEATS_DEFAULT = 3;

const container = document.getElementById('cue-container');

/**
 * @param {unknown} value
 * @returns {number}
 */
function clampRepeats(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return REPEATS_DEFAULT;
  return Math.min(REPEATS_MAX, Math.max(REPEATS_MIN, Math.round(num)));
}

/**
 * Resolves a bundled icon name to a local path. Unknown names yield null, so
 * a payload can never point an <img> at a remote URL.
 * @param {unknown} name
 * @returns {string|null}
 */
function iconPath(name) {
  return typeof name === 'string' && ICON_NAMES.includes(name)
    ? `assets/icons/${name}.svg`
    : null;
}

/**
 * @param {HTMLElement} element
 * @param {number} lifetimeMs
 */
function mount(element, lifetimeMs) {
  container.appendChild(element);
  setTimeout(() => element.remove(), lifetimeMs);
}

function triggerGlow(color, className, repeats) {
  const glowEl = document.createElement('div');
  glowEl.classList.add(className);

  if (color) {
    glowEl.style.setProperty('--glow-color', color);
  }

  const isPulse = className === CUE_CLASSES['glow-pulse'];
  if (isPulse) {
    glowEl.style.animationIterationCount = String(repeats);
  }

  mount(glowEl, isPulse
    ? PULSE_DURATION_MS * repeats + ANIMATION_PADDING_MS
    : BREATHE_DURATION_MS + ANIMATION_PADDING_MS);
}

function triggerComet(color) {
  const cometEl = document.createElement('div');
  cometEl.classList.add('cue-comet');

  if (color) {
    cometEl.style.boxShadow = `-20px 0 30px 10px ${color}`;
  }

  // Randomize vertical position slightly so they aren't all on the same line
  cometEl.style.top = `${Math.floor(Math.random() * 200) + 50}px`;

  mount(cometEl, COMET_DURATION_MS + ANIMATION_PADDING_MS);
}

function triggerText(msg, color, icon) {
  const textEl = document.createElement('div');
  textEl.classList.add('cue-text');

  const src = iconPath(icon);
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.classList.add('cue-text-icon');
    textEl.appendChild(img);
  } else if (color) {
    textEl.classList.add('has-dot');
    textEl.style.setProperty('--text-color', color);
  }

  const span = document.createElement('span');
  span.textContent = msg;
  textEl.appendChild(span);

  mount(textEl, TEXT_DURATION_MS + ANIMATION_PADDING_MS);
}

window.flowstate.onCue((payload) => {
  if (payload === null || typeof payload !== 'object') return;

  const { cue, color, msg, icon, repeats, verbose } = payload;

  if (cue === 'comet') {
    triggerComet(color);
  } else {
    const className = CUE_CLASSES[cue];
    // An unknown cue means the main-process allowlist and this one drifted;
    // say so rather than silently rendering nothing.
    if (!className) {
      console.warn(`[FlowState] Unknown cue: ${cue}`);
      return;
    }
    triggerGlow(color, className, clampRepeats(repeats));
  }

  if (msg && verbose !== false) {
    triggerText(msg, color, icon);
  }
});

'use strict';

/**
 * Overlay renderer. Runs sandboxed with context isolation, so it cannot
 * require shared modules; the allowlists below mirror utils/cuePayload.js,
 * which remains the source of truth and the authoritative validator.
 */

/** Cues rendered as a `cue-<name>` glow element; comet is handled apart. */
const GLOW_CUES = ['glow', 'glow-bottom', 'glow-pulse'];
const ICON_NAMES = ['gitlab', 'outlook', 'calendar', 'pomodoro', 'alert'];

const PULSE_DURATION_MS = 1500;
const BREATHE_DURATION_MS = 4000;
/** Shorter bases while on battery (previously body.eco CSS overrides). */
const ECO_PULSE_DURATION_MS = 1000;
const ECO_BREATHE_DURATION_MS = 2500;
const COMET_DURATION_MS = 8000;
const TEXT_DURATION_MS = 6000;
const ANIMATION_PADDING_MS = 100;
const REPEATS_MIN = 1;
const REPEATS_MAX = 10;
const REPEATS_DEFAULT = 3;
const SPEED_FACTOR_MIN = 0.25;
const SPEED_FACTOR_MAX = 4;

const container = document.getElementById('cue-container');

/** Mirrors body.eco; kept as a flag so glow durations can be computed in JS. */
let ecoMode = false;

/**
 * @param {unknown} value - speedFactor from the enriched payload
 * @returns {number} a safe duration multiplier
 */
function clampSpeedFactor(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(SPEED_FACTOR_MAX, Math.max(SPEED_FACTOR_MIN, value));
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function clampRepeats(value) {
  // Blank means "default", not zero — same rule as utils/cuePayload.js.
  if (typeof value === 'string' && value.trim() === '') return REPEATS_DEFAULT;
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

function triggerGlow(color, cue, repeats, speedFactor) {
  const glowEl = document.createElement('div');
  glowEl.classList.add(`cue-${cue}`);

  if (color) {
    glowEl.style.setProperty('--glow-color', color);
  }

  const isPulse = cue === 'glow-pulse';
  if (isPulse) {
    glowEl.style.animationIterationCount = String(repeats);
  }

  // Duration is set inline (user speed setting x eco base) so the removal
  // timer below can never drift from what the animation actually does.
  const base = isPulse
    ? (ecoMode ? ECO_PULSE_DURATION_MS : PULSE_DURATION_MS)
    : (ecoMode ? ECO_BREATHE_DURATION_MS : BREATHE_DURATION_MS);
  const duration = Math.round(base * speedFactor);
  glowEl.style.animationDuration = `${duration}ms`;

  mount(glowEl, (isPulse ? duration * repeats : duration) + ANIMATION_PADDING_MS);
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

window.periphery.onCue((payload) => {
  if (payload === null || typeof payload !== 'object') return;

  const { cue, color, msg, icon, repeats, verbose, speedFactor } = payload;

  if (cue === 'comet') {
    triggerComet(color);
  } else if (GLOW_CUES.includes(cue)) {
    triggerGlow(color, cue, clampRepeats(repeats), clampSpeedFactor(speedFactor));
  } else {
    // An unknown cue means the main-process allowlist and this one drifted;
    // say so rather than silently rendering nothing.
    console.warn(`[Periphery] Unknown cue: ${cue}`);
    return;
  }

  if (msg && verbose !== false) {
    triggerText(msg, color, icon);
  }
});

// ---------------------------------------------------------------------------
// Constellation: cues held during focus leave dim stars in the top-right
// corner, so a glance shows how much accumulated without saying what.
// ---------------------------------------------------------------------------

const CONSTELLATION_STAR_MAX = 24;
/** Matches the #constellation opacity transition in styles.css. */
const CONSTELLATION_FADE_MS = 1200;
/** Golden angle in radians; gives an even, organic sunflower scatter. */
const GOLDEN_ANGLE = 2.39996;

let constellationClearTimer = null;

function constellationLayer() {
  let layer = document.getElementById('constellation');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'constellation';
    container.appendChild(layer);
  }
  return layer;
}

/**
 * @param {Array<{color?: string|null}>} stars
 */
function renderConstellation(stars) {
  const layer = constellationLayer();

  if (stars.length === 0) {
    layer.classList.add('constellation-clearing');
    constellationClearTimer = setTimeout(() => {
      constellationClearTimer = null;
      layer.replaceChildren();
    }, CONSTELLATION_FADE_MS);
    return;
  }

  if (constellationClearTimer) {
    clearTimeout(constellationClearTimer);
    constellationClearTimer = null;
  }
  layer.classList.remove('constellation-clearing');
  layer.replaceChildren();

  stars.slice(0, CONSTELLATION_STAR_MAX).forEach((star, i) => {
    const el = document.createElement('div');
    el.classList.add('constellation-star');

    // Deterministic positions, so existing stars keep their place as new
    // ones arrive instead of the whole sky reshuffling.
    const radius = 12 * Math.sqrt(i + 0.5);
    el.style.right = `${70 + radius * Math.cos(i * GOLDEN_ANGLE)}px`;
    el.style.top = `${80 + radius * Math.sin(i * GOLDEN_ANGLE)}px`;
    el.style.animationDelay = `${(i % 7) * 0.6}s`;

    if (star && typeof star.color === 'string') {
      el.style.setProperty('--star-color', star.color);
    }
    layer.appendChild(el);
  });
}

window.periphery.onConstellation((data) => {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.stars)) return;
  renderConstellation(data.stars);
});

window.periphery.onTheme((theme) => {
  if (theme === null || typeof theme !== 'object') return;

  const root = document.documentElement;
  if (typeof theme.accent === 'string') {
    root.style.setProperty('--accent-color', theme.accent);
  }
  if (typeof theme.accentSoft === 'string') {
    root.style.setProperty('--accent-soft', theme.accentSoft);
  }
  // On battery the stylesheet swaps to shorter, cheaper animations; the
  // glow durations are computed here in JS (see triggerGlow).
  ecoMode = theme.onBattery === true;
  document.body.classList.toggle('eco', ecoMode);
});

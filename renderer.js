'use strict';

/**
 * Overlay renderer. Runs sandboxed with context isolation, so it cannot
 * require shared modules; the allowlists below mirror utils/cuePayload.js,
 * which remains the source of truth and the authoritative validator.
 */

/** Cues rendered as a `cue-<name>` glow element; comet and the persistent
 * agent beacon are handled apart. */
const GLOW_CUES = ['glow', 'glow-bottom', 'glow-pulse'];
const ICON_NAMES = [
  'gitlab', 'github', 'outlook', 'calendar', 'pomodoro', 'alert', 'agent', 'blocked',
];

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

// ---------------------------------------------------------------------------
// Agent beacon: a persistent corner glow for coding-agent completions. Unlike
// every other cue it does not expire — it breathes until the main process
// says the user is demonstrably back at the keyboard ('agent-ack'), at which
// point the message pill replays once and the beacon fades out.
// ---------------------------------------------------------------------------

const AGENT_FADE_MS = 1400;
/** Gap between replayed pills when several beacons are acknowledged at once. */
const AGENT_REPLAY_STAGGER_MS = 1800;

/** @type {Array<{el: HTMLElement, msg?: string, color?: string, icon?: string, verbose: boolean}>} */
const agentBeacons = [];

function triggerAgentBeacon(color, msg, icon, verbose) {
  const beaconEl = document.createElement('div');
  beaconEl.classList.add('cue-glow-agent');
  if (color) {
    beaconEl.style.setProperty('--agent-color', color);
  }
  // Stacked beacons offset slightly so two agents finishing reads as two.
  beaconEl.style.setProperty('--agent-offset', `${(agentBeacons.length % 4) * 14}px`);
  container.appendChild(beaconEl);
  agentBeacons.push({ el: beaconEl, msg, color, icon, verbose });
}

window.periphery.onAgentAck(() => {
  agentBeacons.splice(0).forEach((beacon, i) => {
    if (beacon.msg && beacon.verbose) {
      setTimeout(() => triggerText(beacon.msg, beacon.color, beacon.icon), i * AGENT_REPLAY_STAGGER_MS);
    }
    beacon.el.classList.add('agent-fading');
    setTimeout(() => beacon.el.remove(), AGENT_FADE_MS);
  });
});

// ---------------------------------------------------------------------------
// Blocked-agent beacon: a *state* cue, not an event. It stays until the agent
// is unblocked or the user dismisses it, and it escalates with age — level 0
// is as quiet as the completion beacon, level 2 is insistent. The main process
// owns the escalation clock (utils/blockedAgents.js) and pushes state here.
// ---------------------------------------------------------------------------

let blockedEl = null;

/**
 * @param {{count: number, level: number, entries: Array<object>}} state
 */
function renderBlocked(state) {
  if (state.count === 0) {
    if (blockedEl) {
      const el = blockedEl;
      blockedEl = null;
      el.classList.add('blocked-clearing');
      setTimeout(() => el.remove(), 900);
    }
    return;
  }

  if (!blockedEl) {
    blockedEl = document.createElement('div');
    blockedEl.classList.add('cue-glow-blocked');
    container.appendChild(blockedEl);
  }

  // Level drives intensity, size, and rhythm entirely through CSS.
  blockedEl.classList.remove('blocked-level-1', 'blocked-level-2');
  if (state.level >= 1) blockedEl.classList.add(`blocked-level-${Math.min(2, state.level)}`);

  const first = state.entries[0];
  if (first && typeof first.color === 'string') {
    blockedEl.style.setProperty('--blocked-color', first.color);
  }
  blockedEl.dataset.count = String(state.count);
}

window.periphery.onBlocked((state) => {
  if (state === null || typeof state !== 'object' || typeof state.count !== 'number') return;
  renderBlocked(state);
});

window.periphery.onCue((payload) => {
  if (payload === null || typeof payload !== 'object') return;

  const { cue, color, msg, icon, repeats, verbose, speedFactor } = payload;

  // The blocked beacon itself is driven by onBlocked state, not by the cue
  // stream; the cue only carries the message pill announcing it.
  if (cue === 'glow-blocked') {
    if (msg && verbose !== false) triggerText(msg, color, icon);
    return;
  }

  if (cue === 'comet') {
    triggerComet(color);
  } else if (cue === 'glow-agent') {
    triggerAgentBeacon(color, msg, icon, verbose !== false);
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

// ---------------------------------------------------------------------------
// Digest panel: an expandable card listing what was held during focus or what
// arrived during a long lock. The overlay window is click-through, so while
// the pointer is over the panel the renderer asks the main process for real
// mouse events (setDigestInteractive), and releases them on leave/close.
// ---------------------------------------------------------------------------

/** The panel dismisses itself when ignored; hovering restarts the clock. */
const DIGEST_AUTO_HIDE_MS = 60 * 1000;
const DIGEST_FADE_MS = 400;

let digestPanel = null;
let digestHideTimer = null;

function digestTimeLabel(at) {
  if (typeof at !== 'number') return '';
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function hideDigest() {
  if (!digestPanel) return;
  const panel = digestPanel;
  digestPanel = null;
  clearTimeout(digestHideTimer);
  digestHideTimer = null;
  document.removeEventListener('mousemove', digestPointerTracker);
  window.periphery.setDigestInteractive(false);
  panel.classList.add('digest-hiding');
  setTimeout(() => panel.remove(), DIGEST_FADE_MS);
}

function armDigestAutoHide() {
  clearTimeout(digestHideTimer);
  digestHideTimer = setTimeout(hideDigest, DIGEST_AUTO_HIDE_MS);
}

/**
 * The overlay ignores mouse events (with forwarding), so mousemove still
 * arrives here. Hit-test the panel and request real events only while the
 * pointer is over it — anywhere else the overlay must stay click-through.
 * @param {MouseEvent} event
 */
function digestPointerTracker(event) {
  if (!digestPanel) return;
  const rect = digestPanel.getBoundingClientRect();
  const inside = event.clientX >= rect.left - 8 && event.clientX <= rect.right + 8
    && event.clientY >= rect.top - 8 && event.clientY <= rect.bottom + 8;
  window.periphery.setDigestInteractive(inside);
  digestPanel.classList.toggle('digest-expanded', inside);
  if (inside) armDigestAutoHide();
}

/**
 * @param {{title?: string, entries?: Array<object>, total?: number}} data
 */
function renderDigest(data) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.entries)) return;
  hideDigest(); // one panel at a time; a new digest replaces the old

  const panel = document.createElement('div');
  panel.id = 'digest-panel';

  const header = document.createElement('div');
  header.classList.add('digest-header');

  const title = document.createElement('span');
  title.classList.add('digest-title');
  title.textContent = typeof data.title === 'string' ? data.title : 'While you were out';
  header.appendChild(title);

  const count = document.createElement('span');
  count.classList.add('digest-count');
  const total = typeof data.total === 'number' ? data.total : data.entries.length;
  count.textContent = String(total);
  header.appendChild(count);

  const close = document.createElement('button');
  close.classList.add('digest-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss digest');
  close.textContent = '×';
  close.addEventListener('click', hideDigest);
  header.appendChild(close);

  panel.appendChild(header);

  const list = document.createElement('ul');
  list.classList.add('digest-list');
  for (const entry of data.entries) {
    const item = document.createElement('li');

    const src = iconPath(entry.icon);
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      item.appendChild(img);
    } else {
      const dot = document.createElement('span');
      dot.classList.add('digest-dot');
      if (typeof entry.color === 'string') dot.style.setProperty('--dot-color', entry.color);
      item.appendChild(dot);
    }

    const msg = document.createElement('span');
    msg.classList.add('digest-msg');
    msg.textContent = typeof entry.msg === 'string' && entry.msg.length > 0
      ? entry.msg
      : 'An update arrived';
    item.appendChild(msg);

    const time = document.createElement('span');
    time.classList.add('digest-time');
    time.textContent = digestTimeLabel(entry.at);
    item.appendChild(time);

    list.appendChild(item);
  }
  panel.appendChild(list);

  if (total > data.entries.length) {
    const more = document.createElement('div');
    more.classList.add('digest-more');
    more.textContent = `+${total - data.entries.length} earlier`;
    panel.appendChild(more);
  }

  const hint = document.createElement('div');
  hint.classList.add('digest-hint');
  hint.textContent = 'hover to expand';
  panel.appendChild(hint);

  container.appendChild(panel);
  digestPanel = panel;
  document.addEventListener('mousemove', digestPointerTracker);
  armDigestAutoHide();
}

window.periphery.onDigest(renderDigest);

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

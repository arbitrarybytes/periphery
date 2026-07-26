'use strict';

const {
  app, BrowserWindow, dialog, ipcMain, Tray, Menu, nativeImage, nativeTheme,
  powerMonitor, screen, systemPreferences,
} = require('electron');
const path = require('path');

const secureStore = require('./utils/secureStore');
const configStore = require('./utils/configStore');
const {
  clampRepeats, clampNumber, sanitizeCuePayload, glowSpeedFactor,
  GLOW_SPEED_MIN, GLOW_SPEED_MAX, GLOW_SPEED_DEFAULT,
} = require('./utils/cuePayload');
const {
  FALLBACK_ACCENT, parseAccentColor, accentCss, cueTier, shouldDefer,
  countHeldIcons, deferredSummaryCue,
} = require('./utils/win11');
const { drawBadgeDot } = require('./utils/trayBadge');
const { FocusAssistMonitor } = require('./utils/focusAssist');
const { SlackTideQueue } = require('./utils/slackTide');
const { AgentAckWatcher } = require('./utils/agentBeacon');
const { DigestLog, AwayTracker } = require('./utils/digest');
const { TeamsPresenceMonitor } = require('./utils/teamsPresence');
const { createAutoUpdate } = require('./utils/updates');
const onboarding = require('./utils/onboarding');
const { WARN } = require('./utils/palette');
const ConnectorManager = require('./connectors/ConnectorManager');
const TimeoutConnector = require('./connectors/timeout');
const GitLabConnector = require('./connectors/gitlab');
const GitHubConnector = require('./connectors/github');
const OutlookConnector = require('./connectors/outlook');
const { startWebhookServer, DEFAULT_PORT } = require('./server/webhookServer');

/** Settings-form field -> secure-store key for each stored credential. */
const SECRET_KEYS = {
  gitlabPat: 'gitlab-pat',
  githubPat: 'github-pat',
  outlookToken: 'outlook-token',
};
/** Config keys the connectors are built from; changes here require a restart. */
const CONNECTOR_CONFIG_KEYS = [
  'pomodoroEnabled', 'pomodoroMinutes',
  'gitlabEnabled', 'gitlabProjectId',
  'githubEnabled', 'githubRepo',
  'outlookEnabled', 'outlookEmail',
];
/** How long to wait for a burst of display changes to settle before rebuilding. */
const DISPLAY_SETTLE_MS = 500;

const IS_WINDOWS = process.platform === 'win32';

/** @type {BrowserWindow[]} One click-through overlay per display. */
let overlayWindows = [];
let settingsWindow = null;
let onboardingWindow = null;
let tray = null;
/** @type {{stop: () => void}|null} */
let autoUpdate = null;
/** Current connector issues, mirrored into the tray badge and settings. */
let connectorHealth = [];
/** Unbadged tray icon, kept so the badge can be re-composited or removed. */
let trayBaseIcon = null;
let connectorManager = null;
let webhookServer = null;
/** @type {FocusAssistMonitor|null} */
let focusMonitor = null;
/** @type {SlackTideQueue|null} */
let slackTide = null;
/** @type {TeamsPresenceMonitor|null} */
let teamsPresence = null;
/** @type {AgentAckWatcher|null} Fades agent beacons once the user is back. */
let agentAck = null;
/** What was held during focus, for the end-of-focus digest panel. */
const focusDigest = new DigestLog();
/** What arrived while the screen was locked, for the away summary. */
const awayLog = new DigestLog();
const awayTracker = new AwayTracker();
let isQuitting = false;

/** Most stars the constellation keeps individually; the total keeps counting. */
const CONSTELLATION_MAX = 24;

/** Windows integration state: accent colour, power source, focus deferral. */
const uiState = {
  accent: FALLBACK_ACCENT,
  onBattery: false,
  /** Focus mode toggled by hand from the tray menu. */
  manualFocus: false,
  /** Focus Assist / DND / presentation mode reported by Windows. */
  detectedDnd: false,
  /** In a call / presenting / DND reported by Teams presence sync. */
  teamsDnd: false,
  /**
   * Tier 2-3 cues held while focused. Each entry becomes a constellation
   * star; everything is flushed as one summary when focus ends.
   * @type {Array<{color: string|null, icon: string|null}>}
   */
  heldCues: [],
  /** Total held this focus session (heldCues is capped, this is not). */
  heldTotal: 0,
};

// ---------------------------------------------------------------------------
// Windows theming (accent colour, battery state)
// ---------------------------------------------------------------------------

function refreshAccent() {
  if (!IS_WINDOWS) return;
  const parsed = parseAccentColor(systemPreferences.getAccentColor());
  if (parsed) uiState.accent = parsed;
}

function themePayload() {
  return {
    accent: accentCss(uiState.accent, 0.85),
    accentSoft: accentCss(uiState.accent, 0.55),
    onBattery: uiState.onBattery,
  };
}

/** @param {BrowserWindow} window */
function send(window, channel, payload) {
  if (!window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

/** Sends to every live overlay. */
function broadcast(channel, payload) {
  for (const window of overlayWindows) send(window, channel, payload);
}

// ---------------------------------------------------------------------------
// Overlay windows
// ---------------------------------------------------------------------------

/**
 * @param {Electron.Display} display
 * @returns {BrowserWindow}
 */
function createOverlayWindow(display) {
  const { x, y, width, height } = display.bounds;

  const window = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Float above full-screen apps too, otherwise cues are invisible during the
  // deep work they exist to protect.
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // The overlay is decorative: never let it swallow a click.
  window.setIgnoreMouseEvents(true, { forward: true });

  // Standing state (theme, constellation) must arrive after the page has
  // listeners, and again on every rebuild, so it rides on did-finish-load.
  window.webContents.on('did-finish-load', () => {
    send(window, 'set-theme', themePayload());
    send(window, 'constellation', constellationPayload());
  });

  window.loadFile('index.html');
  return window;
}

/** Rebuilds one overlay per connected display. */
function rebuildOverlays() {
  for (const window of overlayWindows) {
    if (!window.isDestroyed()) window.destroy();
  }
  overlayWindows = screen.getAllDisplays().map(createOverlayWindow);
}

/**
 * Brings the overlays in line with the current display set. A pure metrics
 * change (scale factor, work area) only moves existing windows — a full
 * teardown would respawn every renderer process for what is just a resize.
 */
function syncOverlays() {
  const displays = screen.getAllDisplays();
  const alive = overlayWindows.filter((window) => !window.isDestroyed());
  if (alive.length !== displays.length || alive.length !== overlayWindows.length) {
    rebuildOverlays();
    return;
  }
  displays.forEach((display, i) => alive[i].setBounds(display.bounds));
}

let displaySettleTimer = null;

/**
 * Display events arrive in bursts while a resolution or DPI change settles,
 * so coalesce them instead of reacting to every event.
 */
function scheduleOverlaySync() {
  if (displaySettleTimer) clearTimeout(displaySettleTimer);
  displaySettleTimer = setTimeout(() => {
    displaySettleTimer = null;
    syncOverlays();
  }, DISPLAY_SETTLE_MS);
}

/**
 * Sends a cue to the overlay on the primary display only — used for the
 * digest panel, which is interactive and should not appear N times.
 */
function sendToPrimary(channel, payload) {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  // Overlays are created from getAllDisplays() in order, so indexes line up.
  const index = displays.findIndex((display) => display.id === primaryId);
  const window = overlayWindows[index] || overlayWindows[0];
  if (window) send(window, channel, payload);
}

/**
 * Sends a cue, enriched with the user's display preferences, to every overlay.
 * @param {object} payload - already validated
 */
function broadcastCue(payload) {
  let out = payload;
  if (payload.cue === 'glow-agent') {
    if (configStore.get('agentCuesEnabled') === false) {
      // Feature toggle off: agent cues downgrade to a plain edge glow rather
      // than disappearing — the notification still happens, just unstickied.
      out = { ...payload, cue: 'glow' };
    } else if (agentAck) {
      agentAck.notifyDelivered();
    }
  }
  broadcast('trigger-cue', {
    ...out,
    repeats: clampRepeats(configStore.get('glowRepeats')),
    speedFactor: glowSpeedFactor(configStore.get('glowSpeed')),
    verbose: configStore.get('verboseMode') !== false,
  });
}

// ---------------------------------------------------------------------------
// Focus deferral (Focus Assist / manual focus mode) & the Constellation
// ---------------------------------------------------------------------------

function isFocused() {
  return uiState.manualFocus
    || (configStore.get('respectFocusAssist') !== false && uiState.detectedDnd)
    || (configStore.get('teamsPresenceEnabled') === true && uiState.teamsDnd);
}

function constellationPayload() {
  return { stars: uiState.heldCues, total: uiState.heldTotal };
}

/**
 * Holds a cue during focus. Instead of vanishing into a counter it leaves a
 * dim star in the overlay's corner, so a glance shows how much accumulated.
 * @param {object} payload
 */
function holdForConstellation(payload) {
  uiState.heldTotal += 1;
  uiState.heldCues.push({
    color: typeof payload.color === 'string' ? payload.color : null,
    icon: typeof payload.icon === 'string' ? payload.icon : null,
  });
  if (uiState.heldCues.length > CONSTELLATION_MAX) uiState.heldCues.shift();
  focusDigest.add(payload); // remembered for the end-of-focus digest panel
  broadcast('constellation', constellationPayload());
  updateTray();
}

/**
 * The final delivery step: hold for the constellation while focused,
 * broadcast otherwise. Also the slack tide's release path, so focus is
 * re-checked when a cue queued before focus mode began is let out.
 * @param {object} payload
 */
function deliverFinal(payload) {
  // While the screen is locked, remember what went by for the away summary.
  // The cue still broadcasts — a locked screen just doesn't show it.
  if (awayTracker.isLocked() && configStore.get('awaySummaryEnabled') !== false) {
    awayLog.add(payload);
  }
  if (shouldDefer(payload, isFocused())) {
    holdForConstellation(payload);
  } else {
    broadcastCue(payload);
  }
}

/**
 * Routes a cue from any source (connector, webhook).
 * Priority: focus hold (constellation) → slack tide (wait for a typing
 * pause) → immediate broadcast. Tier 1 cues always go straight through.
 * Validation happens here, once, so the router is safe for every source.
 * @param {unknown} rawPayload
 */
function deliverCue(rawPayload) {
  const payload = sanitizeCuePayload(rawPayload);
  if (!payload) return;

  const heldByFocus = shouldDefer(payload, isFocused());
  // Agent beacons skip the slack tide: they persist until acknowledged, so
  // waiting for a typing pause would add delay without reducing interruption.
  if (!heldByFocus && slackTide && cueTier(payload) >= 2
      && payload.cue !== 'glow-agent'
      && configStore.get('slackTideEnabled') !== false) {
    slackTide.push(payload); // delivers immediately if the user is already pausing
    return;
  }
  deliverFinal(payload);
}

/** Called on every manual or detected focus transition. */
function onFocusChanged() {
  if (!isFocused() && uiState.heldTotal > 0) {
    broadcastCue(deferredSummaryCue(
      uiState.heldTotal,
      accentCss(uiState.accent, 0.7),
      countHeldIcons(uiState.heldCues),
    ));
    const digest = focusDigest.drain();
    if (configStore.get('digestEnabled') !== false && digest.entries.length > 0) {
      sendToPrimary('digest', { title: 'While you were focused', ...digest });
    }
    uiState.heldTotal = 0;
    uiState.heldCues = [];
    broadcast('constellation', constellationPayload()); // empty list fades the stars out
  }
  updateTray();
}

/**
 * Screen unlock after a long absence: greet the user with what went by.
 * Short locks (a coffee refill) drain the log silently.
 */
function onUnlock() {
  const { away } = awayTracker.unlock();
  const digest = awayLog.drain();
  if (!away || configStore.get('awaySummaryEnabled') === false || digest.entries.length === 0) {
    return;
  }
  broadcastCue({
    cue: 'glow-bottom',
    color: accentCss(uiState.accent, 0.7),
    msg: `${digest.total} update${digest.total === 1 ? '' : 's'} arrived while you were away`,
    icon: 'alert',
  });
  sendToPrimary('digest', { title: 'While you were away', ...digest });
}

/**
 * Starts or stops the Teams presence poll to match the feature toggle.
 * Stopping releases any hold, so cues can never stay muted by a stale state.
 */
function syncTeamsPresence() {
  const wanted = configStore.get('teamsPresenceEnabled') === true;
  if (wanted && !teamsPresence) {
    teamsPresence = new TeamsPresenceMonitor({
      getToken: () => secureStore.getSecret(SECRET_KEYS.outlookToken),
      onChange: (hold) => {
        uiState.teamsDnd = hold;
        onFocusChanged();
      },
      onAuthFailure: (message) => deliverCue({
        cue: 'glow-bottom', color: WARN, msg: message, icon: 'alert',
      }),
    });
    teamsPresence.start();
  } else if (!wanted && teamsPresence) {
    teamsPresence.dispose();
    teamsPresence = null;
    uiState.teamsDnd = false;
    onFocusChanged();
  }
}

/**
 * Starts or stops the Focus Assist probe to match platform and settings.
 * Stopping reports "not disturbed", which flushes anything held.
 */
function syncFocusMonitor() {
  const wanted = IS_WINDOWS && configStore.get('respectFocusAssist') !== false;
  if (wanted && !focusMonitor) {
    focusMonitor = new FocusAssistMonitor({
      onChange: (dnd) => {
        uiState.detectedDnd = dnd;
        onFocusChanged();
      },
    });
    focusMonitor.start();
  } else if (!wanted && focusMonitor) {
    focusMonitor.stop();
    focusMonitor = null;
  }
}

// ---------------------------------------------------------------------------
// Settings window & tray
// ---------------------------------------------------------------------------

/** Window Controls Overlay colours that follow the OS light/dark theme. */
function titleBarOverlayOptions() {
  return {
    // Transparent so the Mica backdrop runs through the caption area.
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1a1a1a',
    height: 40,
  };
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 560,
    height: 800,
    minWidth: 480,
    minHeight: 560,
    title: 'Periphery Settings',
    autoHideMenuBar: true,
    show: false, // Shown on ready-to-show so Mica never flashes white.
    ...(IS_WINDOWS ? {
      backgroundMaterial: 'mica',
      titleBarStyle: 'hidden',
      titleBarOverlay: titleBarOverlayOptions(),
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

/** First-run wizard: detect a project, write the webhook recipes, first cue. */
function createOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  onboardingWindow = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 520,
    minHeight: 560,
    title: 'Welcome to Periphery',
    autoHideMenuBar: true,
    show: false,
    ...(IS_WINDOWS ? {
      backgroundMaterial: 'mica',
      titleBarStyle: 'hidden',
      titleBarOverlay: titleBarOverlayOptions(),
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload-onboarding.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  onboardingWindow.once('ready-to-show', () => onboardingWindow.show());
  onboardingWindow.loadFile('onboarding.html');
  onboardingWindow.on('closed', () => {
    onboardingWindow = null;
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Settings', click: createSettingsWindow },
    { label: 'Setup wizard', click: createOnboardingWindow },
    {
      label: 'Focus mode',
      type: 'checkbox',
      checked: uiState.manualFocus,
      click: (item) => {
        uiState.manualFocus = item.checked;
        onFocusChanged();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Periphery',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

/** Amber, matching the WARN cue colour: something needs the user's attention. */
const HEALTH_BADGE_COLOR = Object.freeze({ r: 255, g: 176, b: 32 });

/** Badged tray icon cache: one composite per badge kind, reset on accent change. */
let trayBadgedIcon = null;
let trayBadgedKind = null;
/** Which badge the tray currently shows ('held' | 'health' | null). */
let trayBadgeKind = null;

/** @param {'held'|'health'} kind */
function badgedTrayIcon(kind) {
  if (!trayBadgedIcon || trayBadgedKind !== kind) {
    trayBadgedKind = kind;
    const { width, height } = trayBaseIcon.getSize();
    trayBadgedIcon = nativeImage.createFromBitmap(
      drawBadgeDot(trayBaseIcon.toBitmap(), width, height,
        kind === 'health' ? HEALTH_BADGE_COLOR : uiState.accent),
      { width, height },
    );
  }
  return trayBadgedIcon;
}

/** Re-composites the badge (if shown) after the OS accent colour changes. */
function refreshTrayBadge() {
  trayBadgedIcon = null;
  if (tray && trayBadgeKind) {
    try {
      tray.setImage(badgedTrayIcon(trayBadgeKind));
    } catch (err) {
      console.error('[Tray] Could not composite badge dot', err);
    }
  }
}

function healthBadgeWanted() {
  return connectorHealth.length > 0 && configStore.get('healthBadgeEnabled') !== false;
}

/**
 * Keeps the tray truthful: a tooltip that says what Periphery is doing, an
 * accent badge dot while cues are held, and an amber one while a connector
 * needs attention (health outranks held — a broken poller means cues are
 * being missed, not merely deferred). The context menu is static after
 * createTray — the checkbox manages its own checked state.
 */
function updateTray() {
  if (!tray) return;

  const held = uiState.heldTotal;
  let tooltip = isFocused()
    ? `Periphery — focus mode${held > 0 ? `, ${held} update${held === 1 ? '' : 's'} held` : ''}`
    : 'Periphery — watching';
  if (healthBadgeWanted()) {
    const first = connectorHealth[0];
    tooltip += `\n${connectorHealth.length === 1
      ? first.detail || `${first.name} needs attention`
      : `${connectorHealth.length} connectors need attention`}`;
  }
  tray.setToolTip(tooltip);

  if (!trayBaseIcon || trayBaseIcon.isEmpty()) return;
  const wantKind = healthBadgeWanted() ? 'health' : (held > 0 ? 'held' : null);
  if (wantKind === trayBadgeKind) return;
  trayBadgeKind = wantKind;
  try {
    tray.setImage(wantKind ? badgedTrayIcon(wantKind) : trayBaseIcon);
  } catch (err) {
    // The badge is decoration; never let it take the tray icon down with it.
    console.error('[Tray] Could not composite badge dot', err);
    tray.setImage(trayBaseIcon);
    trayBadgeKind = null;
  }
}

function createTray() {
  trayBaseIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  if (trayBaseIcon.isEmpty()) {
    // A blank tray icon would leave the user with no way to reach Settings or
    // Quit, so make the cause obvious rather than shipping an invisible tray.
    console.error('[Tray] assets/tray.png could not be loaded; the tray icon will be blank.');
  }

  tray = new Tray(trayBaseIcon);
  tray.on('click', createSettingsWindow);
  tray.setContextMenu(buildTrayMenu());
  updateTray();
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

function initConnectors() {
  connectorManager.stopAll(); // Stop existing before reloading

  if (configStore.get('pomodoroEnabled')) {
    connectorManager.register('pomodoro', new TimeoutConnector({
      // Same clamp as the save path, so a bad value on disk can't bypass it.
      durationMs: clampNumber(configStore.get('pomodoroMinutes'), 1, 240, 25) * 60 * 1000,
      cueName: 'glow-pulse',
      color: 'rgba(0, 200, 255, 0.6)',
      message: 'Time for a quick stretch!',
    }));
  }

  if (configStore.get('gitlabEnabled') && configStore.get('gitlabProjectId')) {
    connectorManager.register('gitlab-1', new GitLabConnector({
      projectId: configStore.get('gitlabProjectId'),
      patKey: SECRET_KEYS.gitlabPat,
      secretStore: secureStore,
      pollIntervalMs: 30 * 1000,
    }));
  }

  if (configStore.get('githubEnabled') && configStore.get('githubRepo')) {
    connectorManager.register('github-1', new GitHubConnector({
      repo: configStore.get('githubRepo'),
      patKey: SECRET_KEYS.githubPat,
      secretStore: secureStore,
      pollIntervalMs: 45 * 1000,
    }));
  }

  if (configStore.get('outlookEnabled') && configStore.get('outlookEmail')) {
    connectorManager.register('outlook-1', new OutlookConnector({
      tokenKey: SECRET_KEYS.outlookToken,
      userEmail: configStore.get('outlookEmail'),
      secretStore: secureStore,
      pollIntervalMs: 60 * 1000,
    }));
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpcHandlers() {
  ipcMain.handle('get-config', () => ({
    ...configStore.getAll(),
    // Never return secrets to the renderer; only whether one is stored.
    hasGitlabPat: secureStore.hasSecret(SECRET_KEYS.gitlabPat),
    hasGithubPat: secureStore.hasSecret(SECRET_KEYS.githubPat),
    hasOutlookToken: secureStore.hasSecret(SECRET_KEYS.outlookToken),
    // Presentation-only extras so the settings UI can match the OS.
    accentColor: accentCss(uiState.accent, 1),
    isWindows: IS_WINDOWS,
    isPackaged: app.isPackaged,
    connectorHealth,
  }));

  ipcMain.handle('save-config', (event, config) => {
    if (config === null || typeof config !== 'object') {
      return { success: false, error: 'Invalid settings payload' };
    }

    const connectorConfigBefore = CONNECTOR_CONFIG_KEYS.map((key) => configStore.get(key));

    configStore.setMany({
      verboseMode: Boolean(config.verboseMode),
      glowRepeats: clampRepeats(config.glowRepeats),
      glowSpeed: clampNumber(config.glowSpeed, GLOW_SPEED_MIN, GLOW_SPEED_MAX, GLOW_SPEED_DEFAULT),
      respectFocusAssist: Boolean(config.respectFocusAssist),
      slackTideEnabled: Boolean(config.slackTideEnabled),
      startAtLogin: Boolean(config.startAtLogin),
      autoUpdateEnabled: Boolean(config.autoUpdateEnabled),
      healthBadgeEnabled: Boolean(config.healthBadgeEnabled),
      agentCuesEnabled: Boolean(config.agentCuesEnabled),
      digestEnabled: Boolean(config.digestEnabled),
      awaySummaryEnabled: Boolean(config.awaySummaryEnabled),
      teamsPresenceEnabled: Boolean(config.teamsPresenceEnabled),
      pomodoroEnabled: Boolean(config.pomodoroEnabled),
      pomodoroMinutes: clampNumber(config.pomodoroMinutes, 1, 240, 25),
      gitlabEnabled: Boolean(config.gitlabEnabled),
      gitlabProjectId: String(config.gitlabProjectId ?? '').trim(),
      githubEnabled: Boolean(config.githubEnabled),
      githubRepo: String(config.githubRepo ?? '').trim(),
      outlookEnabled: Boolean(config.outlookEnabled),
      outlookEmail: String(config.outlookEmail ?? '').trim(),
    });

    // Secrets are only written when the user actually typed one, so leaving
    // the field blank keeps the existing credential.
    let secretsChanged = false;
    for (const [field, key] of Object.entries(SECRET_KEYS)) {
      const value = config[field];
      if (typeof value === 'string' && value.length > 0) {
        secureStore.setSecret(key, value);
        secretsChanged = true;
      }
    }

    // Restarting connectors refires their baseline API fetches, so skip it
    // when the save only touched cosmetic settings.
    if (secretsChanged
        || CONNECTOR_CONFIG_KEYS.some((key, i) => configStore.get(key) !== connectorConfigBefore[i])) {
      initConnectors();
    }
    // A replaced Graph token must revive a presence monitor that stopped
    // itself after an auth failure.
    if (secretsChanged && teamsPresence) {
      teamsPresence.dispose();
      teamsPresence = null;
    }
    syncTeamsPresence();
    syncFocusMonitor();
    applyLoginItemSetting();
    onFocusChanged(); // Turning "respect Focus Assist" off must release held cues.
    updateTray(); // The health-badge toggle may have changed.
    if (slackTide && configStore.get('slackTideEnabled') === false) {
      slackTide.flush(); // Turning slack tide off must release its queue too.
    }
    return { success: true };
  });

  ipcMain.handle('clear-secret', (event, field) => {
    const key = SECRET_KEYS[field];
    if (!key) return { success: false, error: 'Unknown secret' };

    secureStore.deleteSecret(key);
    initConnectors();
    return { success: true };
  });

  // --- Onboarding wizard ---

  ipcMain.handle('onboarding-pick-project', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a project folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const dir = result.filePaths[0];
    try {
      return {
        ...onboarding.detectProject(dir),
        dockerRecipe: onboarding.dockerRecipe(DEFAULT_PORT),
      };
    } catch (err) {
      console.error('[Onboarding] Detection failed', err);
      return null;
    }
  });

  ipcMain.handle('onboarding-apply', (event, options) => {
    if (options === null || typeof options !== 'object' || typeof options.dir !== 'string') {
      return {};
    }
    const results = {};
    try {
      if (options.gitHook === true) {
        results.gitHook = onboarding.applyGitHook(options.dir, DEFAULT_PORT);
      }
      if (options.npmScripts === true) {
        results.npmScripts = onboarding.addNotifyScripts(options.dir, DEFAULT_PORT);
      }
    } catch (err) {
      console.error('[Onboarding] Apply failed', err);
    }
    return results;
  });

  ipcMain.handle('onboarding-finish', () => {
    configStore.setMany({ onboardingDone: true });
    if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close();
    return { success: true };
  });

  // The overlay is click-through by default. While the pointer is over the
  // digest panel the renderer asks for real mouse events, so the panel can be
  // hovered, scrolled, and closed; leaving the panel restores click-through.
  ipcMain.on('digest-interactive', (event, interactive) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && overlayWindows.includes(window)) {
      window.setIgnoreMouseEvents(interactive !== true, { forward: true });
    }
  });

  ipcMain.handle('send-test-cue', (event, cue) => {
    // Deliberately skips focus deferral: the user just clicked the button.
    broadcastCue({
      cue: typeof cue === 'string' ? cue : 'glow-pulse',
      color: accentCss(uiState.accent, 0.7),
      msg: 'Periphery test cue',
      icon: 'alert',
    });
    return { success: true };
  });
}

/**
 * Start-at-login, from the feature toggle. Only meaningful in a packaged
 * build — registering a dev electron.exe at login would be a trap.
 */
function applyLoginItemSetting() {
  if (!app.isPackaged) return;
  const openAtLogin = configStore.get('startAtLogin') === true;
  try {
    app.setLoginItemSettings({ openAtLogin });
  } catch (err) {
    console.error('[Startup] Could not update login item', err);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function main() {
  // A stable AppUserModelID keeps the tray identity and any future toasts
  // grouped under one app on Windows instead of under "electron.app".
  if (IS_WINDOWS) app.setAppUserModelId('com.periphery.poc');

  app.whenReady().then(() => {
    refreshAccent();
    uiState.onBattery = powerMonitor.isOnBatteryPower();

    rebuildOverlays();
    createTray();
    registerIpcHandlers();
    syncFocusMonitor();

    slackTide = new SlackTideQueue({
      deliver: deliverFinal,
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    });

    agentAck = new AgentAckWatcher({
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      // The renderer fades every beacon and replays its message pill once.
      onAcknowledge: () => broadcast('agent-ack', {}),
    });

    syncTeamsPresence();

    // Long locks feed the "while you were away" digest.
    powerMonitor.on('lock-screen', () => awayTracker.lock());
    powerMonitor.on('unlock-screen', onUnlock);

    connectorManager = new ConnectorManager(deliverCue, (issues) => {
      connectorHealth = issues;
      updateTray();
      // Keep an open settings window's banner live.
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        send(settingsWindow, 'connector-health', issues);
      }
    });
    initConnectors();

    // Displays come and go (docking, projectors); keep one overlay on each.
    screen.on('display-added', scheduleOverlaySync);
    screen.on('display-removed', scheduleOverlaySync);
    screen.on('display-metrics-changed', scheduleOverlaySync);

    // Follow the OS: accent repaints cues and the tray badge, battery state
    // switches the overlay into its low-power animation profile.
    if (IS_WINDOWS) {
      systemPreferences.on('accent-color-changed', () => {
        refreshAccent();
        broadcast('set-theme', themePayload());
        refreshTrayBadge();
      });
      nativeTheme.on('updated', () => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.setTitleBarOverlay(titleBarOverlayOptions());
        }
      });
    }
    powerMonitor.on('on-battery', () => {
      uiState.onBattery = true;
      broadcast('set-theme', themePayload());
    });
    powerMonitor.on('on-ac', () => {
      uiState.onBattery = false;
      broadcast('set-theme', themePayload());
    });

    webhookServer = startWebhookServer({
      onCue: deliverCue,
      onError: (err) => {
        const detail = err.code === 'EADDRINUSE'
          ? `port ${DEFAULT_PORT} is already in use`
          : err.message;
        console.error(`[Webhook] Could not start local hook: ${detail}. Cues from local scripts are disabled.`);
      },
    });

    applyLoginItemSetting();
    autoUpdate = createAutoUpdate({
      isPackaged: app.isPackaged,
      isEnabled: () => configStore.get('autoUpdateEnabled') !== false,
      onCue: (payload) => deliverCue(payload),
    });
    autoUpdate.start();

    // First run: open the wizard so the first cue is a minute away, not a
    // documentation dive.
    if (configStore.get('onboardingDone') !== true) {
      createOnboardingWindow();
    }

    app.on('activate', () => {
      if (overlayWindows.every((window) => window.isDestroyed())) {
        rebuildOverlays();
      }
    });
  });

  app.on('second-instance', () => {
    // Another launch means the user is looking for the app; show Settings.
    // The event can arrive while this instance is still starting up, so gate
    // window creation on readiness.
    app.whenReady().then(createSettingsWindow);
  });

  // Periphery lives in the tray, so closing a window must not end the session.
  // Quitting happens through the tray menu, which sets isQuitting first.
  app.on('window-all-closed', () => {
    if (isQuitting) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (connectorManager) connectorManager.stopAll();
    if (webhookServer) webhookServer.close();
    // dispose(), not stop(): stop() would fire a flush cue mid-quit.
    if (focusMonitor) focusMonitor.dispose();
    if (teamsPresence) teamsPresence.dispose();
    if (slackTide) slackTide.stop();
    if (agentAck) agentAck.stop();
    if (autoUpdate) autoUpdate.stop();
  });
}

// A second instance cannot bind the webhook port and would fight over the same
// config file, so hand off to the running one instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme,
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
const ConnectorManager = require('./connectors/ConnectorManager');
const TimeoutConnector = require('./connectors/timeout');
const GitLabConnector = require('./connectors/gitlab');
const OutlookConnector = require('./connectors/outlook');
const { startWebhookServer, DEFAULT_PORT } = require('./server/webhookServer');

/** Settings-form field -> secure-store key for each stored credential. */
const SECRET_KEYS = { gitlabPat: 'gitlab-pat', outlookToken: 'outlook-token' };
/** Config keys the connectors are built from; changes here require a restart. */
const CONNECTOR_CONFIG_KEYS = [
  'pomodoroEnabled', 'pomodoroMinutes',
  'gitlabEnabled', 'gitlabProjectId',
  'outlookEnabled', 'outlookEmail',
];
/** How long to wait for a burst of display changes to settle before rebuilding. */
const DISPLAY_SETTLE_MS = 500;

const IS_WINDOWS = process.platform === 'win32';

/** @type {BrowserWindow[]} One click-through overlay per display. */
let overlayWindows = [];
let settingsWindow = null;
let tray = null;
/** Unbadged tray icon, kept so the badge can be re-composited or removed. */
let trayBaseIcon = null;
let connectorManager = null;
let webhookServer = null;
/** @type {FocusAssistMonitor|null} */
let focusMonitor = null;
/** @type {SlackTideQueue|null} */
let slackTide = null;
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
 * Sends a cue, enriched with the user's display preferences, to every overlay.
 * @param {object} payload - already validated
 */
function broadcastCue(payload) {
  broadcast('trigger-cue', {
    ...payload,
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
    || (configStore.get('respectFocusAssist') !== false && uiState.detectedDnd);
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
  if (!heldByFocus && slackTide && cueTier(payload) >= 2
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
    uiState.heldTotal = 0;
    uiState.heldCues = [];
    broadcast('constellation', constellationPayload()); // empty list fades the stars out
  }
  updateTray();
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

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Settings', click: createSettingsWindow },
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

/** Badged variant of the tray icon, composited lazily; reset on accent change. */
let trayBadgedIcon = null;
/** Whether the tray currently shows the badge, so setImage runs on transitions only. */
let trayShowsBadge = false;

function badgedTrayIcon() {
  if (!trayBadgedIcon) {
    const { width, height } = trayBaseIcon.getSize();
    trayBadgedIcon = nativeImage.createFromBitmap(
      drawBadgeDot(trayBaseIcon.toBitmap(), width, height, uiState.accent),
      { width, height },
    );
  }
  return trayBadgedIcon;
}

/** Re-composites the badge (if shown) after the OS accent colour changes. */
function refreshTrayBadge() {
  trayBadgedIcon = null;
  if (tray && trayShowsBadge) {
    try {
      tray.setImage(badgedTrayIcon());
    } catch (err) {
      console.error('[Tray] Could not composite badge dot', err);
    }
  }
}

/**
 * Keeps the tray truthful: a tooltip that says what Periphery is doing, and
 * an accent-coloured badge dot while cues are being held. The context menu is
 * static after createTray — the checkbox manages its own checked state.
 */
function updateTray() {
  if (!tray) return;

  const held = uiState.heldTotal;
  tray.setToolTip(isFocused()
    ? `Periphery — focus mode${held > 0 ? `, ${held} update${held === 1 ? '' : 's'} held` : ''}`
    : 'Periphery — watching');

  if (!trayBaseIcon || trayBaseIcon.isEmpty()) return;
  const wantBadge = held > 0;
  if (wantBadge === trayShowsBadge) return;
  trayShowsBadge = wantBadge;
  try {
    tray.setImage(wantBadge ? badgedTrayIcon() : trayBaseIcon);
  } catch (err) {
    // The badge is decoration; never let it take the tray icon down with it.
    console.error('[Tray] Could not composite badge dot', err);
    tray.setImage(trayBaseIcon);
    trayShowsBadge = false;
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
    hasOutlookToken: secureStore.hasSecret(SECRET_KEYS.outlookToken),
    // Presentation-only extras so the settings UI can match the OS.
    accentColor: accentCss(uiState.accent, 1),
    isWindows: IS_WINDOWS,
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
      pomodoroEnabled: Boolean(config.pomodoroEnabled),
      pomodoroMinutes: clampNumber(config.pomodoroMinutes, 1, 240, 25),
      gitlabEnabled: Boolean(config.gitlabEnabled),
      gitlabProjectId: String(config.gitlabProjectId ?? '').trim(),
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
    syncFocusMonitor();
    onFocusChanged(); // Turning "respect Focus Assist" off must release held cues.
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

    connectorManager = new ConnectorManager(deliverCue);
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
    if (slackTide) slackTide.stop();
  });
}

// A second instance cannot bind the webhook port and would fight over the same
// config file, so hand off to the running one instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

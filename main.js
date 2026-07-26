'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme,
  powerMonitor, screen, systemPreferences,
} = require('electron');
const path = require('path');

const secureStore = require('./utils/secureStore');
const configStore = require('./utils/configStore');
const { clampRepeats } = require('./utils/cuePayload');
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

const GITLAB_PAT_KEY = 'gitlab-pat';
const OUTLOOK_TOKEN_KEY = 'outlook-token';
const SECRET_KEYS = { gitlabPat: GITLAB_PAT_KEY, outlookToken: OUTLOOK_TOKEN_KEY };
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
function sendTheme(window) {
  if (!window.isDestroyed()) {
    window.webContents.send('set-theme', themePayload());
  }
}

function broadcastTheme() {
  for (const window of overlayWindows) sendTheme(window);
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
    sendTheme(window);
    sendConstellation(window);
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

let rebuildTimer = null;

/**
 * Display events arrive in bursts while a resolution or DPI change settles,
 * so coalesce them instead of tearing down every window each time.
 */
function scheduleOverlayRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuildOverlays();
  }, DISPLAY_SETTLE_MS);
}

/**
 * Applies the user's display preferences to an outgoing cue.
 * @param {object} payload
 * @returns {object}
 */
function enrichCuePayload(payload) {
  return {
    ...payload,
    repeats: clampRepeats(configStore.get('glowRepeats')),
    verbose: configStore.get('verboseMode') !== false,
  };
}

/**
 * Sends a cue to every live overlay.
 * @param {object} payload - already validated by the caller
 */
function broadcastCue(payload) {
  const enriched = enrichCuePayload(payload);
  for (const window of overlayWindows) {
    if (!window.isDestroyed()) {
      window.webContents.send('trigger-cue', enriched);
    }
  }
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

/** @param {BrowserWindow} window */
function sendConstellation(window) {
  if (!window.isDestroyed()) {
    window.webContents.send('constellation', constellationPayload());
  }
}

function broadcastConstellation() {
  for (const window of overlayWindows) sendConstellation(window);
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
  broadcastConstellation();
  updateTray();
}

/**
 * Routes a cue from any source (connector, webhook).
 * Priority: focus hold (constellation) → slack tide (wait for a typing
 * pause) → immediate broadcast. Tier 1 cues always go straight through.
 * @param {object} payload - already validated by the caller
 */
function deliverCue(payload) {
  if (shouldDefer(payload, isFocused())) {
    holdForConstellation(payload);
    return;
  }
  if (slackTide && cueTier(payload) >= 2 && configStore.get('slackTideEnabled') !== false) {
    slackTide.push(payload); // delivers immediately if the user is already pausing
    return;
  }
  broadcastCue(payload);
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
    broadcastConstellation(); // empty payload fades the stars out
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
    title: 'FlowState Settings',
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
      label: 'Quit FlowState',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

/**
 * Keeps the tray truthful: menu checkbox, a tooltip that says what FlowState
 * is doing, and an accent-coloured badge dot while cues are being held.
 */
function updateTray() {
  if (!tray) return;

  tray.setContextMenu(buildTrayMenu());

  const held = uiState.heldTotal;
  tray.setToolTip(isFocused()
    ? `FlowState — focus mode${held > 0 ? `, ${held} update${held === 1 ? '' : 's'} held` : ''}`
    : 'FlowState — watching');

  if (!trayBaseIcon || trayBaseIcon.isEmpty()) return;
  try {
    if (held > 0) {
      const { width, height } = trayBaseIcon.getSize();
      const badged = drawBadgeDot(trayBaseIcon.toBitmap(), width, height, uiState.accent);
      tray.setImage(nativeImage.createFromBitmap(badged, { width, height }));
    } else {
      tray.setImage(trayBaseIcon);
    }
  } catch (err) {
    // The badge is decoration; never let it take the tray icon down with it.
    console.error('[Tray] Could not composite badge dot', err);
    tray.setImage(trayBaseIcon);
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
  updateTray();
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

function initConnectors() {
  connectorManager.stopAll(); // Stop existing before reloading

  if (configStore.get('pomodoroEnabled')) {
    const minutes = Number(configStore.get('pomodoroMinutes'));
    connectorManager.register('pomodoro', new TimeoutConnector({
      durationMs: (Number.isFinite(minutes) ? minutes : 25) * 60 * 1000,
      cueName: 'glow-pulse',
      color: 'rgba(0, 200, 255, 0.6)',
      message: 'Time for a quick stretch!',
    }));
  }

  if (configStore.get('gitlabEnabled') && configStore.get('gitlabProjectId')) {
    connectorManager.register('gitlab-1', new GitLabConnector({
      projectId: configStore.get('gitlabProjectId'),
      patKey: GITLAB_PAT_KEY,
      secretStore: secureStore,
      pollIntervalMs: 30 * 1000,
    }));
  }

  if (configStore.get('outlookEnabled') && configStore.get('outlookEmail')) {
    connectorManager.register('outlook-1', new OutlookConnector({
      tokenKey: OUTLOOK_TOKEN_KEY,
      userEmail: configStore.get('outlookEmail'),
      secretStore: secureStore,
      pollIntervalMs: 60 * 1000,
    }));
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function registerIpcHandlers() {
  ipcMain.handle('get-config', () => ({
    ...configStore.getAll(),
    // Never return secrets to the renderer; only whether one is stored.
    hasGitlabPat: secureStore.hasSecret(GITLAB_PAT_KEY),
    hasOutlookToken: secureStore.hasSecret(OUTLOOK_TOKEN_KEY),
    // Presentation-only extras so the settings UI can match the OS.
    accentColor: accentCss(uiState.accent, 1),
    isWindows: IS_WINDOWS,
  }));

  ipcMain.handle('save-config', (event, config) => {
    if (config === null || typeof config !== 'object') {
      return { success: false, error: 'Invalid settings payload' };
    }

    configStore.setMany({
      verboseMode: Boolean(config.verboseMode),
      glowRepeats: clampRepeats(config.glowRepeats),
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
    for (const [field, key] of Object.entries(SECRET_KEYS)) {
      const value = config[field];
      if (typeof value === 'string' && value.length > 0) {
        secureStore.setSecret(key, value);
      }
    }

    initConnectors();
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
      msg: 'FlowState test cue',
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
  if (IS_WINDOWS) app.setAppUserModelId('com.flowstate.poc');

  app.whenReady().then(() => {
    refreshAccent();
    uiState.onBattery = powerMonitor.isOnBatteryPower();

    rebuildOverlays();
    createTray();
    registerIpcHandlers();
    syncFocusMonitor();

    slackTide = new SlackTideQueue({
      // Focus is re-checked at release time: a cue queued in the tide before
      // focus mode began must join the constellation, not break through when
      // the tide flushes mid-focus.
      deliver: (payload) => {
        if (shouldDefer(payload, isFocused())) {
          holdForConstellation(payload);
        } else {
          broadcastCue(payload);
        }
      },
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    });

    connectorManager = new ConnectorManager(deliverCue);
    initConnectors();

    // Displays come and go (docking, projectors); keep one overlay on each.
    screen.on('display-added', scheduleOverlayRebuild);
    screen.on('display-removed', scheduleOverlayRebuild);
    screen.on('display-metrics-changed', scheduleOverlayRebuild);

    // Follow the OS: accent repaints cues and the tray badge, battery state
    // switches the overlay into its low-power animation profile.
    if (IS_WINDOWS) {
      systemPreferences.on('accent-color-changed', () => {
        refreshAccent();
        broadcastTheme();
        updateTray();
      });
      nativeTheme.on('updated', () => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.setTitleBarOverlay(titleBarOverlayOptions());
        }
      });
    }
    powerMonitor.on('on-battery', () => {
      uiState.onBattery = true;
      broadcastTheme();
    });
    powerMonitor.on('on-ac', () => {
      uiState.onBattery = false;
      broadcastTheme();
    });

    webhookServer = startWebhookServer({
      onCue: deliverCue,
      port: DEFAULT_PORT,
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

  // FlowState lives in the tray, so closing a window must not end the session.
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

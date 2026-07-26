'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');

const secureStore = require('./utils/secureStore');
const configStore = require('./utils/configStore');
const { clampRepeats } = require('./utils/cuePayload');
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

/** @type {BrowserWindow[]} One click-through overlay per display. */
let overlayWindows = [];
let settingsWindow = null;
let tray = null;
let connectorManager = null;
let webhookServer = null;
let isQuitting = false;

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
// Settings window & tray
// ---------------------------------------------------------------------------

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 780,
    title: 'FlowState Settings',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  if (icon.isEmpty()) {
    // A blank tray icon would leave the user with no way to reach Settings or
    // Quit, so make the cause obvious rather than shipping an invisible tray.
    console.error('[Tray] assets/tray.png could not be loaded; the tray icon will be blank.');
  }

  tray = new Tray(icon);
  tray.setToolTip('FlowState');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Settings', click: createSettingsWindow },
    { type: 'separator' },
    {
      label: 'Quit FlowState',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', createSettingsWindow);
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
  }));

  ipcMain.handle('save-config', (event, config) => {
    if (config === null || typeof config !== 'object') {
      return { success: false, error: 'Invalid settings payload' };
    }

    configStore.setMany({
      verboseMode: Boolean(config.verboseMode),
      glowRepeats: clampRepeats(config.glowRepeats),
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
    broadcastCue({
      cue: typeof cue === 'string' ? cue : 'glow-pulse',
      color: 'rgba(0, 150, 255, 0.7)',
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
  app.whenReady().then(() => {
    rebuildOverlays();
    createTray();
    registerIpcHandlers();

    connectorManager = new ConnectorManager(broadcastCue);
    initConnectors();

    // Displays come and go (docking, projectors); keep one overlay on each.
    screen.on('display-added', scheduleOverlayRebuild);
    screen.on('display-removed', scheduleOverlayRebuild);
    screen.on('display-metrics-changed', scheduleOverlayRebuild);

    webhookServer = startWebhookServer({
      onCue: broadcastCue,
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
    createSettingsWindow();
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
  });
}

// A second instance cannot bind the webhook port and would fight over the same
// config file, so hand off to the running one instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

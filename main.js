const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const express = require('express');
const cors = require('cors');
const path = require('path');

const secureStore = require('./utils/secureStore');
const configStore = require('./utils/configStore');
const ConnectorManager = require('./connectors/ConnectorManager');
const TimeoutConnector = require('./connectors/timeout');
const GitLabConnector = require('./connectors/gitlab');
const OutlookConnector = require('./connectors/outlook');

let mainWindow;
let connectorManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Make the window full screen
  mainWindow.maximize();
  
  // Make the window click-through so it doesn't interfere with the user's work
  mainWindow.setIgnoreMouseEvents(true);

  mainWindow.loadFile('index.html');
}

let settingsWindow = null;
let tray = null;

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 700,
    title: 'FlowState Settings',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  settingsWindow.loadFile('settings.html');
  
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function initConnectors() {
  connectorManager.stopAll(); // Stop existing before reloading

  // 1. Timeout Connector (Testing)
  const breakReminder = new TimeoutConnector({
    durationMs: 10 * 1000, 
    cueName: 'glow-pulse',
    color: 'rgba(0, 200, 255, 0.6)',
    message: 'Time for a quick stretch!'
  });
  connectorManager.register('timeout-1', breakReminder);

  // 2. GitLab Connector
  if (configStore.get('gitlabEnabled', true) && configStore.get('gitlabProjectId')) {
    const gitlabMonitor = new GitLabConnector({
      projectId: configStore.get('gitlabProjectId'),
      patKey: 'gitlab-pat',
      pollIntervalMs: 30 * 1000
    });
    connectorManager.register('gitlab-1', gitlabMonitor);
  }

  // 3. Outlook Connector
  if (configStore.get('outlookEnabled', true) && configStore.get('outlookEmail')) {
    const outlookMonitor = new OutlookConnector({
      tokenKey: 'outlook-token',
      userEmail: configStore.get('outlookEmail'),
      pollIntervalMs: 60 * 1000
    });
    connectorManager.register('outlook-1', outlookMonitor);
  }
}

app.whenReady().then(() => {
  createWindow();

  // Create Tray Icon using an empty native image to avoid missing image crashes
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Settings', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit FlowState', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  
  tray.setToolTip('FlowState');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => createSettingsWindow());

  // Initialize Connector Engine
  connectorManager = new ConnectorManager(mainWindow);
  initConnectors();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Intercept window close to keep app running in tray
app.on('window-all-closed', (e) => {
  if (process.platform !== 'darwin') {
    // Only quit if we explicitly clicked Quit in tray (handled by app.isQuitting)
    if (app.isQuitting) {
      app.quit();
    }
  }
});

// --- IPC Handlers for Settings ---
ipcMain.handle('get-config', () => {
  return configStore.getAll();
});

ipcMain.on('save-config', (event, config) => {
  // Save non-secret config
  configStore.set('verboseMode', config.verboseMode);
  configStore.set('glowRepeats', config.glowRepeats);
  configStore.set('gitlabEnabled', config.gitlabEnabled);
  configStore.set('gitlabProjectId', config.gitlabProjectId);
  configStore.set('outlookEnabled', config.outlookEnabled);
  configStore.set('outlookEmail', config.outlookEmail);

  // Save secrets only if provided
  if (config.gitlabPat) {
    secureStore.setSecret('gitlab-pat', config.gitlabPat);
  }
  if (config.outlookToken) {
    secureStore.setSecret('outlook-token', config.outlookToken);
  }

  // Reload connectors with new settings
  initConnectors();
});

// Setup Express Server
const server = express();
server.use(cors());
server.use(express.json());

server.post('/notify', (req, res) => {
  const { cue, color, msg, icon } = req.body;
  
  if (mainWindow) {
    // Append user preferences to payload before sending to renderer
    mainWindow.webContents.send('trigger-cue', { 
      cue, 
      color, 
      msg,
      icon,
      repeats: configStore.get('glowRepeats', 3),
      verbose: configStore.get('verboseMode', true)
    });
  }

  res.status(200).json({ success: true, message: `Triggered ${cue}` });
});

const PORT = 49123;
server.listen(PORT, () => {
  console.log(`FlowState Local Hook listening on port ${PORT}`);
});

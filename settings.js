'use strict';

/**
 * Settings UI. Talks to the main process only through the `peripherySettings`
 * bridge exposed by preload-settings.js — it has no Node access.
 */

const REPEATS_MIN = 1;
const REPEATS_MAX = 10;
const REPEATS_DEFAULT = 3;
/** Mirrors utils/cuePayload.js glow-speed levels (sandboxed: no require). */
const SPEED_MIN = 1;
const SPEED_MAX = 5;
const SPEED_DEFAULT = 3;
const SPEED_LABELS = ['Super slow', 'Slow', 'Medium', 'Fast', 'Super fast'];
const POMODORO_MIN = 1;
const POMODORO_MAX = 240;
const POMODORO_DEFAULT = 25;
const STATUS_RESET_MS = 2000;

const $ = (id) => document.getElementById(id);

/**
 * @param {HTMLInputElement} input
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number} a usable integer even when the field is blank or garbage
 */
function readNumber(input, min, max, fallback) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * @param {string} statusId
 * @param {string} buttonId
 * @param {boolean} stored
 */
function renderSecretState(statusId, buttonId, stored) {
  $(statusId).textContent = stored ? 'A token is stored.' : 'No token stored.';
  $(buttonId).disabled = !stored;
}

/**
 * @param {string} message
 */
function flashStatus(message) {
  const status = $('saveStatus');
  status.textContent = message;
  setTimeout(() => {
    if (status.textContent === message) status.textContent = '';
  }, STATUS_RESET_MS);
}

/**
 * Renders the connector-health banner (amber, above the sections).
 * @param {Array<{name: string, status: string, detail: string|null}>} issues
 */
function renderHealthBanner(issues) {
  const banner = $('healthBanner');
  const list = $('healthList');
  if (!Array.isArray(issues) || issues.length === 0) {
    banner.hidden = true;
    list.replaceChildren();
    return;
  }
  list.replaceChildren(...issues.map((issue) => {
    const line = document.createElement('p');
    line.textContent = issue.detail || `${issue.name}: ${issue.status}`;
    return line;
  }));
  banner.hidden = false;
}

async function loadConfig() {
  const config = await window.peripherySettings.getConfig();

  // Match the OS accent (buttons, toggles, focus rings) and hide the
  // Windows-only section elsewhere.
  if (typeof config.accentColor === 'string') {
    document.documentElement.style.setProperty('--accent', config.accentColor);
  }
  $('windowsSection').hidden = config.isWindows === false;

  $('verboseMode').checked = config.verboseMode !== false;
  $('respectFocusAssist').checked = config.respectFocusAssist !== false;
  $('slackTideEnabled').checked = config.slackTideEnabled !== false;
  $('digestEnabled').checked = config.digestEnabled !== false;
  $('awaySummaryEnabled').checked = config.awaySummaryEnabled !== false;
  $('agentCuesEnabled').checked = config.agentCuesEnabled !== false;
  $('blockedCuesEnabled').checked = config.blockedCuesEnabled !== false;
  $('blockedPiercesFocus').checked = config.blockedPiercesFocus !== false;
  $('glowRepeats').value = config.glowRepeats ?? REPEATS_DEFAULT;
  $('glowSpeed').value = config.glowSpeed ?? SPEED_DEFAULT;
  renderSpeedLabel();

  $('pomodoroEnabled').checked = config.pomodoroEnabled !== false;
  $('pomodoroMinutes').value = config.pomodoroMinutes ?? POMODORO_DEFAULT;

  $('gitlabEnabled').checked = config.gitlabEnabled !== false;
  $('gitlabProjectId').value = config.gitlabProjectId || '';

  $('githubEnabled').checked = config.githubEnabled !== false;
  $('githubRepo').value = config.githubRepo || '';

  $('outlookEnabled').checked = config.outlookEnabled !== false;
  $('outlookEmail').value = config.outlookEmail || '';
  // Opt-in (needs an extra Graph scope), unlike the default-on toggles above.
  $('teamsPresenceEnabled').checked = config.teamsPresenceEnabled === true;

  // Opt-in: registering yourself at login is the user's call to make.
  $('startAtLogin').checked = config.startAtLogin === true;
  $('autoUpdateEnabled').checked = config.autoUpdateEnabled !== false;
  $('healthBadgeEnabled').checked = config.healthBadgeEnabled !== false;
  $('packagedNote').hidden = config.isPackaged !== false;

  renderHealthBanner(config.connectorHealth);

  renderSecretState('gitlabPatStatus', 'clearGitlabPat', config.hasGitlabPat);
  renderSecretState('githubPatStatus', 'clearGithubPat', config.hasGithubPat);
  renderSecretState('outlookTokenStatus', 'clearOutlookToken', config.hasOutlookToken);
}

/** Shows the current trackbar position as a word ("Medium", "Super fast"). */
function renderSpeedLabel() {
  const level = readNumber($('glowSpeed'), SPEED_MIN, SPEED_MAX, SPEED_DEFAULT);
  $('glowSpeedLabel').textContent = SPEED_LABELS[level - 1];
}

async function save() {
  const repeats = readNumber($('glowRepeats'), REPEATS_MIN, REPEATS_MAX, REPEATS_DEFAULT);
  const glowSpeed = readNumber($('glowSpeed'), SPEED_MIN, SPEED_MAX, SPEED_DEFAULT);
  const pomodoroMinutes = readNumber($('pomodoroMinutes'), POMODORO_MIN, POMODORO_MAX, POMODORO_DEFAULT);

  // Write the clamped values back so the user sees what was actually stored.
  $('glowRepeats').value = repeats;
  $('pomodoroMinutes').value = pomodoroMinutes;

  const result = await window.peripherySettings.saveConfig({
    verboseMode: $('verboseMode').checked,
    glowRepeats: repeats,
    glowSpeed,
    respectFocusAssist: $('respectFocusAssist').checked,
    slackTideEnabled: $('slackTideEnabled').checked,
    digestEnabled: $('digestEnabled').checked,
    awaySummaryEnabled: $('awaySummaryEnabled').checked,
    agentCuesEnabled: $('agentCuesEnabled').checked,
    blockedCuesEnabled: $('blockedCuesEnabled').checked,
    blockedPiercesFocus: $('blockedPiercesFocus').checked,

    pomodoroEnabled: $('pomodoroEnabled').checked,
    pomodoroMinutes,

    gitlabEnabled: $('gitlabEnabled').checked,
    gitlabProjectId: $('gitlabProjectId').value,
    gitlabPat: $('gitlabPat').value, // Secret; blank keeps the existing one

    githubEnabled: $('githubEnabled').checked,
    githubRepo: $('githubRepo').value,
    githubPat: $('githubPat').value, // Secret; blank keeps the existing one

    outlookEnabled: $('outlookEnabled').checked,
    outlookEmail: $('outlookEmail').value,
    outlookToken: $('outlookToken').value, // Secret; blank keeps the existing one
    teamsPresenceEnabled: $('teamsPresenceEnabled').checked,

    startAtLogin: $('startAtLogin').checked,
    autoUpdateEnabled: $('autoUpdateEnabled').checked,
    healthBadgeEnabled: $('healthBadgeEnabled').checked,
  });

  if (!result.success) {
    flashStatus(result.error || 'Could not save settings.');
    return;
  }

  // Clear the secret inputs so credentials do not linger in the DOM.
  $('gitlabPat').value = '';
  $('githubPat').value = '';
  $('outlookToken').value = '';

  await loadConfig();
  flashStatus('Saved.');
}

/**
 * @param {'gitlabPat'|'githubPat'|'outlookToken'} field
 */
async function clearSecret(field) {
  const result = await window.peripherySettings.clearSecret(field);
  if (!result.success) {
    flashStatus(result.error || 'Could not remove the token.');
    return;
  }
  await loadConfig();
  flashStatus('Token removed.');
}

$('saveBtn').addEventListener('click', save);
$('glowSpeed').addEventListener('input', renderSpeedLabel);
$('clearGitlabPat').addEventListener('click', () => clearSecret('gitlabPat'));
$('clearGithubPat').addEventListener('click', () => clearSecret('githubPat'));
$('clearOutlookToken').addEventListener('click', () => clearSecret('outlookToken'));
$('testCueBtn').addEventListener('click', () => window.peripherySettings.sendTestCue('glow-pulse'));

window.peripherySettings.onConnectorHealth(renderHealthBanner);

loadConfig().catch((err) => {
  console.error('Failed to load settings', err);
  flashStatus('Could not load settings.');
});

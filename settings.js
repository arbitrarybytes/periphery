'use strict';

/**
 * Settings UI. Talks to the main process only through the `flowstateSettings`
 * bridge exposed by preload-settings.js — it has no Node access.
 */

const REPEATS_MIN = 1;
const REPEATS_MAX = 10;
const REPEATS_DEFAULT = 3;
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

async function loadConfig() {
  const config = await window.flowstateSettings.getConfig();

  $('verboseMode').checked = config.verboseMode !== false;
  $('glowRepeats').value = config.glowRepeats ?? REPEATS_DEFAULT;

  $('pomodoroEnabled').checked = config.pomodoroEnabled !== false;
  $('pomodoroMinutes').value = config.pomodoroMinutes ?? POMODORO_DEFAULT;

  $('gitlabEnabled').checked = config.gitlabEnabled !== false;
  $('gitlabProjectId').value = config.gitlabProjectId || '';

  $('outlookEnabled').checked = config.outlookEnabled !== false;
  $('outlookEmail').value = config.outlookEmail || '';

  renderSecretState('gitlabPatStatus', 'clearGitlabPat', config.hasGitlabPat);
  renderSecretState('outlookTokenStatus', 'clearOutlookToken', config.hasOutlookToken);
}

async function save() {
  const repeats = readNumber($('glowRepeats'), REPEATS_MIN, REPEATS_MAX, REPEATS_DEFAULT);
  const pomodoroMinutes = readNumber($('pomodoroMinutes'), POMODORO_MIN, POMODORO_MAX, POMODORO_DEFAULT);

  // Write the clamped values back so the user sees what was actually stored.
  $('glowRepeats').value = repeats;
  $('pomodoroMinutes').value = pomodoroMinutes;

  const result = await window.flowstateSettings.saveConfig({
    verboseMode: $('verboseMode').checked,
    glowRepeats: repeats,

    pomodoroEnabled: $('pomodoroEnabled').checked,
    pomodoroMinutes,

    gitlabEnabled: $('gitlabEnabled').checked,
    gitlabProjectId: $('gitlabProjectId').value,
    gitlabPat: $('gitlabPat').value, // Secret; blank keeps the existing one

    outlookEnabled: $('outlookEnabled').checked,
    outlookEmail: $('outlookEmail').value,
    outlookToken: $('outlookToken').value, // Secret; blank keeps the existing one
  });

  if (!result.success) {
    flashStatus(result.error || 'Could not save settings.');
    return;
  }

  // Clear the secret inputs so credentials do not linger in the DOM.
  $('gitlabPat').value = '';
  $('outlookToken').value = '';

  await loadConfig();
  flashStatus('Saved.');
}

/**
 * @param {'gitlabPat'|'outlookToken'} field
 */
async function clearSecret(field) {
  const result = await window.flowstateSettings.clearSecret(field);
  if (!result.success) {
    flashStatus(result.error || 'Could not remove the token.');
    return;
  }
  await loadConfig();
  flashStatus('Token removed.');
}

$('saveBtn').addEventListener('click', save);
$('clearGitlabPat').addEventListener('click', () => clearSecret('gitlabPat'));
$('clearOutlookToken').addEventListener('click', () => clearSecret('outlookToken'));
$('testCueBtn').addEventListener('click', () => window.flowstateSettings.sendTestCue('glow-pulse'));

loadConfig().catch((err) => {
  console.error('Failed to load settings', err);
  flashStatus('Could not load settings.');
});

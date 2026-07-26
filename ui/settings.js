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

// ---------------------------------------------------------------------------
// Projects & local hooks — same registry and detection as the setup wizard.
// Status is re-read from disk on every render; there is no cached state that
// could drift out of sync with what the wizard shows.
// ---------------------------------------------------------------------------

/** Docker recipe text from the last projects-list response. */
let dockerRecipeText = '';

/**
 * @param {string} label
 * @param {{wired?: boolean, note?: string, action?: {label: string, run: () => void}}} state
 * @returns {HTMLElement}
 */
function hookChip(label, state) {
  const chip = document.createElement('span');
  chip.className = state.wired ? 'hook-chip wired' : 'hook-chip';

  const name = document.createElement('span');
  name.textContent = label;
  chip.appendChild(name);

  if (state.wired) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = '✓';
    chip.appendChild(tick);
  } else if (state.action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = state.action.label;
    button.addEventListener('click', state.action.run);
    chip.appendChild(button);
  } else if (state.note) {
    const note = document.createElement('span');
    note.textContent = state.note;
    chip.appendChild(note);
  }
  return chip;
}

/**
 * @param {string} message
 */
function flashProjectStatus(message) {
  const status = $('projectStatus');
  status.textContent = message;
  setTimeout(() => {
    if (status.textContent === message) status.textContent = '';
  }, STATUS_RESET_MS);
}

/**
 * @param {string} dir
 * @param {{gitHook?: boolean, npmScripts?: boolean}} which
 */
async function wireHooks(dir, which) {
  const results = await window.peripherySettings.wireProject({ dir, ...which });
  const outcome = results.gitHook || results.npmScripts;
  if (outcome && !outcome.written) {
    flashProjectStatus(`Skipped: ${outcome.reason}.`);
  } else if (outcome) {
    flashProjectStatus('Wired. Status re-read from the folder.');
  }
  await loadProjects();
}

/**
 * @param {object} project - one detectRegistered() entry
 * @returns {HTMLElement}
 */
function projectRow(project) {
  const row = document.createElement('div');
  row.className = 'project-row';

  const head = document.createElement('div');
  head.className = 'project-head';

  const name = document.createElement('span');
  name.className = 'project-name';
  name.textContent = project.dir.split(/[\\/]/).filter(Boolean).pop() || project.dir;
  head.appendChild(name);

  const path = document.createElement('span');
  path.className = 'project-path';
  path.textContent = project.dir;
  path.title = project.dir;
  head.appendChild(path);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link';
  remove.textContent = 'Remove';
  remove.title = 'Forget this folder. Hooks already written stay in place.';
  remove.addEventListener('click', async () => {
    const result = await window.peripherySettings.removeProject(project.dir);
    renderProjects(result);
    flashProjectStatus('Removed from the list — written hooks were left untouched.');
  });
  head.appendChild(remove);

  row.appendChild(head);

  if (project.missing) {
    const missing = document.createElement('p');
    missing.className = 'project-missing';
    missing.textContent = 'Folder not found — moved or deleted?';
    row.appendChild(missing);
    return row;
  }

  const hooks = document.createElement('div');
  hooks.className = 'project-hooks';

  if (project.hasGit) {
    if (project.hookIsOurs) {
      hooks.appendChild(hookChip('git hook', { wired: true }));
    } else if (project.hookExists) {
      hooks.appendChild(hookChip('git hook', {
        note: 'exists — not Periphery’s, left alone',
      }));
    } else {
      hooks.appendChild(hookChip('git hook', {
        action: { label: 'wire', run: () => wireHooks(project.dir, { gitHook: true }) },
      }));
    }
  }

  if (project.hasPackageJson) {
    hooks.appendChild(project.notifyScriptsPresent
      ? hookChip('npm scripts', { wired: true })
      : hookChip('npm scripts', {
        action: { label: 'add', run: () => wireHooks(project.dir, { npmScripts: true }) },
      }));
  }

  if (project.hasDocker) {
    hooks.appendChild(hookChip('docker', {
      action: {
        label: 'copy recipe',
        run: async () => {
          await navigator.clipboard.writeText(dockerRecipeText);
          flashProjectStatus('Docker recipe copied.');
        },
      },
    }));
  }

  if (hooks.childElementCount === 0) {
    hooks.appendChild(hookChip('nothing to wire', {
      note: 'no git, package.json, or Dockerfile found',
    }));
  }

  row.appendChild(hooks);
  return row;
}

/**
 * @param {{projects: object[], dockerRecipe: string}} data
 */
function renderProjects(data) {
  dockerRecipeText = data.dockerRecipe || '';
  const projects = Array.isArray(data.projects) ? data.projects : [];
  $('projectList').replaceChildren(...projects.map(projectRow));
  $('projectsEmpty').hidden = projects.length > 0;
}

async function loadProjects() {
  renderProjects(await window.peripherySettings.listProjects());
}

$('addProjectBtn').addEventListener('click', async () => {
  const picked = await window.peripherySettings.addProject();
  if (!picked) return; // dialog cancelled
  await loadProjects();
  flashProjectStatus('Folder registered.');
});

// The wizard may wire hooks while this window is open; re-detect whenever the
// window comes back to the foreground so the two can never disagree.
window.addEventListener('focus', () => {
  loadProjects().catch(() => { /* transient; next focus retries */ });
});

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

loadProjects().catch((err) => {
  console.error('Failed to load projects', err);
  flashProjectStatus('Could not read the project list.');
});

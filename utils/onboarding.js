'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Onboarding: "first cue in 60 seconds". Detects what a project folder can
 * be wired to (git hooks, package.json scripts, Docker) and writes the
 * webhooks.md recipes for the user. Pure Node — no Electron — so every
 * decision here is unit-tested against real temp directories.
 *
 * Writing rules are deliberately timid: nothing is ever overwritten. An
 * existing git hook or an existing notify script means we report "already
 * wired / write it yourself" and hand back the snippet instead.
 */

const MARKER = '# periphery-hook';

/**
 * @param {string} dir - project folder chosen by the user
 * @returns {{
 *   dir: string,
 *   hasGit: boolean, hookExists: boolean, hookIsOurs: boolean,
 *   hasPackageJson: boolean, notifyScriptsPresent: boolean,
 *   hasDocker: boolean,
 * }}
 */
function detectProject(dir) {
  const result = {
    dir,
    hasGit: false,
    hookExists: false,
    hookIsOurs: false,
    hasPackageJson: false,
    notifyScriptsPresent: false,
    hasDocker: false,
  };

  result.hasGit = fs.existsSync(path.join(dir, '.git'));
  if (result.hasGit) {
    const hookPath = path.join(dir, '.git', 'hooks', 'post-commit');
    result.hookExists = fs.existsSync(hookPath);
    if (result.hookExists) {
      try {
        result.hookIsOurs = fs.readFileSync(hookPath, 'utf8').includes(MARKER);
      } catch { /* unreadable hook = not ours */ }
    }
  }

  const pkgPath = path.join(dir, 'package.json');
  result.hasPackageJson = fs.existsSync(pkgPath);
  if (result.hasPackageJson) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      result.notifyScriptsPresent = Boolean(pkg.scripts
        && (pkg.scripts['notify:success'] || pkg.scripts['notify:fail']));
    } catch { /* malformed package.json reads as "no scripts" */ }
  }

  result.hasDocker = fs.existsSync(path.join(dir, 'Dockerfile'))
    || fs.existsSync(path.join(dir, 'docker-compose.yml'))
    || fs.existsSync(path.join(dir, 'compose.yaml'));

  return result;
}

/**
 * The post-commit recipe from ai-native/webhooks.md. Git for Windows runs hooks
 * under its bundled sh, where curl is available.
 * @param {number} port
 * @returns {string}
 */
function postCommitHookScript(port) {
  return [
    '#!/bin/sh',
    MARKER,
    '# Ambient cue on every commit. Safe to delete; Periphery never overwrites',
    '# an existing hook. See ai-native/webhooks.md in the Periphery repo.',
    `curl -s -X POST http://127.0.0.1:${port}/notify \\`,
    '     -H "Content-Type: application/json" \\',
    '     -d \'{"cue":"glow-bottom", "color":"rgba(0, 255, 100, 0.6)", "msg":"Git commit successful"}\' \\',
    '     > /dev/null 2>&1 || true',
    '',
  ].join('\n');
}

/**
 * Writes the post-commit hook, refusing to touch an existing one.
 * @param {string} dir
 * @param {number} port
 * @returns {{written: boolean, path: string, reason?: string}}
 */
function applyGitHook(dir, port) {
  const hookPath = path.join(dir, '.git', 'hooks', 'post-commit');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return { written: false, path: hookPath, reason: 'not a git repository' };
  }
  if (fs.existsSync(hookPath)) {
    return { written: false, path: hookPath, reason: 'a post-commit hook already exists' };
  }
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, postCommitHookScript(port));
  try {
    fs.chmodSync(hookPath, 0o755); // required on macOS/Linux, harmless on Windows
  } catch { /* chmod is best-effort */ }
  return { written: true, path: hookPath };
}

/**
 * @param {number} port
 * @returns {{success: string, fail: string}} the notify script commands
 */
function notifyScriptCommands(port) {
  const post = (body) => `curl -s -X POST http://127.0.0.1:${port}/notify -H "Content-Type: application/json" -d "${body}"`;
  return {
    success: post('{\\"cue\\":\\"glow-pulse\\", \\"color\\":\\"rgba(0, 255, 100, 0.8)\\", \\"msg\\":\\"Build succeeded\\"}'),
    fail: post('{\\"cue\\":\\"glow-bottom\\", \\"color\\":\\"rgba(255, 0, 50, 0.8)\\", \\"msg\\":\\"Build failed\\", \\"icon\\":\\"alert\\"}'),
  };
}

/**
 * Adds `notify:success` / `notify:fail` to package.json scripts. Only adds —
 * existing scripts of the same name are never replaced. Note: rewrites the
 * file with 2-space JSON formatting (the wizard says so before applying).
 * @param {string} dir
 * @param {number} port
 * @returns {{written: boolean, path: string, reason?: string}}
 */
function addNotifyScripts(dir, port) {
  const pkgPath = path.join(dir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return { written: false, path: pkgPath, reason: 'package.json is missing or malformed' };
  }
  pkg.scripts = pkg.scripts || {};
  if (pkg.scripts['notify:success'] || pkg.scripts['notify:fail']) {
    return { written: false, path: pkgPath, reason: 'notify scripts already exist' };
  }
  const commands = notifyScriptCommands(port);
  pkg.scripts['notify:success'] = commands.success;
  pkg.scripts['notify:fail'] = commands.fail;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return { written: true, path: pkgPath };
}

/**
 * Docker has no local hook file to write, so the wizard shows this recipe
 * with a copy button instead.
 * @param {number} port
 * @returns {string}
 */
function dockerRecipe(port) {
  return [
    '# Cue when a container build or long run finishes:',
    `docker build -t myapp . && curl -X POST http://127.0.0.1:${port}/notify -H "Content-Type: application/json" -d '{"cue":"glow-pulse","msg":"Image built"}'`,
    '',
    '# Or watch a long-running container from PowerShell:',
    `docker wait my-container; Invoke-RestMethod -Uri http://127.0.0.1:${port}/notify -Method POST -ContentType 'application/json' -Body '{"cue":"glow-agent","icon":"agent","msg":"Container finished"}'`,
  ].join('\n');
}

/**
 * Registered project folders — the single source of truth shared by the
 * onboarding wizard and the Settings window. "Registered" means Periphery
 * remembers the folder and reports its hook status; the hooks themselves live
 * in the folder and are re-detected from disk every time, never cached, so
 * the two windows can never disagree about what is wired.
 */

/**
 * Adds a folder to the registered list. Pure: returns a new list.
 * @param {unknown} list - current `projectFolders` config value
 * @param {string} dir
 * @returns {string[]} deduplicated, with the new folder appended
 */
function registerFolder(list, dir) {
  const folders = Array.isArray(list) ? list.filter((f) => typeof f === 'string') : [];
  const normalized = path.resolve(dir);
  // Windows paths are case-insensitive; registering C:\Repo and c:\repo as
  // two projects would show the same folder twice with the same status.
  const exists = folders.some(
    (f) => path.resolve(f).toLowerCase() === normalized.toLowerCase(),
  );
  return exists ? folders : [...folders, normalized];
}

/**
 * Removes a folder from the registered list. Pure: returns a new list.
 * Removal only forgets the folder — hooks already written stay in place, and
 * the UI says so.
 * @param {unknown} list
 * @param {string} dir
 * @returns {string[]}
 */
function unregisterFolder(list, dir) {
  const folders = Array.isArray(list) ? list.filter((f) => typeof f === 'string') : [];
  const normalized = path.resolve(dir).toLowerCase();
  return folders.filter((f) => path.resolve(f).toLowerCase() !== normalized);
}

/**
 * Fresh detection for every registered folder — what both the Settings
 * Projects section and the wizard render from.
 * @param {unknown} list
 * @returns {Array<ReturnType<typeof detectProject> & {missing: boolean}>}
 */
function detectRegistered(list) {
  const folders = Array.isArray(list) ? list.filter((f) => typeof f === 'string') : [];
  return folders.map((dir) => {
    if (!fs.existsSync(dir)) {
      // A moved or deleted folder is reported, not silently dropped: the user
      // decides whether to remove it.
      return { ...detectProject(dir), missing: true };
    }
    return { ...detectProject(dir), missing: false };
  });
}

module.exports = {
  MARKER,
  detectProject,
  postCommitHookScript,
  applyGitHook,
  notifyScriptCommands,
  addNotifyScripts,
  dockerRecipe,
  registerFolder,
  unregisterFolder,
  detectRegistered,
};

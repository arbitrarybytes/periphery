'use strict';

/**
 * Onboarding wizard UI. Talks to the main process only through the
 * `peripheryOnboarding` bridge (preload-onboarding.js) — no Node access.
 */

const $ = (id) => document.getElementById(id);

/** Last detection result; apply targets this folder. */
let detected = null;

$('firstCueBtn').addEventListener('click', () => {
  window.peripheryOnboarding.sendTestCue('comet');
});

$('pickBtn').addEventListener('click', async () => {
  const result = await window.peripheryOnboarding.pickProject();
  if (!result) return; // dialog cancelled
  detected = result;

  $('pickedPath').textContent = result.dir;
  $('pickedPath').hidden = false;
  $('detections').hidden = false;
  $('applyStatus').textContent = '';

  $('gitRow').hidden = !result.hasGit;
  if (result.hasGit) {
    const wired = result.hookExists;
    $('gitHookOpt').checked = !wired;
    $('gitHookOpt').disabled = wired;
    $('gitHint').textContent = wired
      ? (result.hookIsOurs
        ? 'Already wired by Periphery.'
        : 'A post-commit hook already exists — Periphery never overwrites it. Add the snippet from ai-native/webhooks.md by hand.')
      : 'A quiet green glow on every successful commit.';
  }

  $('npmRow').hidden = !result.hasPackageJson;
  if (result.hasPackageJson) {
    const wired = result.notifyScriptsPresent;
    $('npmOpt').checked = !wired;
    $('npmOpt').disabled = wired;
    if (wired) $('npmHint').textContent = 'notify scripts already exist — nothing to do.';
  }

  $('dockerRow').hidden = !result.hasDocker;
  if (result.hasDocker) {
    $('dockerRecipe').textContent = result.dockerRecipe;
  }
});

$('copyDockerBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('dockerRecipe').textContent);
  $('copyDockerBtn').textContent = 'Copied';
  setTimeout(() => { $('copyDockerBtn').textContent = 'Copy recipe'; }, 1500);
});

$('applyBtn').addEventListener('click', async () => {
  if (!detected) return;
  const wantGit = !$('gitRow').hidden && $('gitHookOpt').checked && !$('gitHookOpt').disabled;
  const wantNpm = !$('npmRow').hidden && $('npmOpt').checked && !$('npmOpt').disabled;
  if (!wantGit && !wantNpm) {
    $('applyStatus').textContent = 'Nothing selected to write.';
    return;
  }

  const results = await window.peripheryOnboarding.apply({
    dir: detected.dir,
    gitHook: wantGit,
    npmScripts: wantNpm,
  });

  const parts = [];
  if (results.gitHook) {
    parts.push(results.gitHook.written ? 'git hook written' : `git hook skipped (${results.gitHook.reason})`);
    if (results.gitHook.written) $('gitHookOpt').disabled = true;
  }
  if (results.npmScripts) {
    parts.push(results.npmScripts.written ? 'notify scripts added' : `scripts skipped (${results.npmScripts.reason})`);
    if (results.npmScripts.written) $('npmOpt').disabled = true;
  }
  $('applyStatus').textContent = `${parts.join(' · ')} — commit something and watch the bottom edge.`;
});

$('finishBtn').addEventListener('click', () => window.peripheryOnboarding.finish());

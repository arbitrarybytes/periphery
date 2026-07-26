'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectProject, applyGitHook, addNotifyScripts, postCommitHookScript, dockerRecipe, MARKER,
} = require('../utils/onboarding');

/** Fresh temp project folder per test; cleaned up by the OS eventually. */
function tmpProject(setup = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'periphery-onboard-'));
  if (setup.git) fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  if (setup.hook) fs.writeFileSync(path.join(dir, '.git', 'hooks', 'post-commit'), setup.hook);
  if (setup.pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(setup.pkg, null, 2));
  if (setup.docker) fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
  return dir;
}

test('detects git, package.json, and Docker independently', () => {
  const all = detectProject(tmpProject({ git: true, pkg: { name: 'x' }, docker: true }));
  assert.equal(all.hasGit, true);
  assert.equal(all.hookExists, false);
  assert.equal(all.hasPackageJson, true);
  assert.equal(all.notifyScriptsPresent, false);
  assert.equal(all.hasDocker, true);

  const none = detectProject(tmpProject());
  assert.deepEqual(
    [none.hasGit, none.hasPackageJson, none.hasDocker],
    [false, false, false],
  );
});

test('recognises its own hook vs a foreign one', () => {
  const ours = detectProject(tmpProject({ git: true, hook: postCommitHookScript(49123) }));
  assert.equal(ours.hookExists, true);
  assert.equal(ours.hookIsOurs, true);

  const foreign = detectProject(tmpProject({ git: true, hook: '#!/bin/sh\necho hi\n' }));
  assert.equal(foreign.hookExists, true);
  assert.equal(foreign.hookIsOurs, false);
});

test('writes the post-commit hook once and never overwrites', () => {
  const dir = tmpProject({ git: true });

  const first = applyGitHook(dir, 49123);
  assert.equal(first.written, true);
  const content = fs.readFileSync(first.path, 'utf8');
  assert.ok(content.includes(MARKER));
  assert.ok(content.includes('127.0.0.1:49123/notify'));
  assert.ok(content.endsWith('|| true\n'), 'the hook must never fail a commit');

  const second = applyGitHook(dir, 49123);
  assert.equal(second.written, false, 'even our own hook is never rewritten');

  const noGit = applyGitHook(tmpProject(), 49123);
  assert.equal(noGit.written, false);
  assert.match(noGit.reason, /not a git repository/);
});

test('adds notify scripts without touching existing ones', () => {
  const dir = tmpProject({ pkg: { name: 'x', scripts: { build: 'webpack' } } });

  const result = addNotifyScripts(dir, 49123);
  assert.equal(result.written, true);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'webpack', 'existing scripts stay untouched');
  assert.match(pkg.scripts['notify:success'], /49123\/notify/);
  assert.match(pkg.scripts['notify:fail'], /alert/);

  const again = addNotifyScripts(dir, 49123);
  assert.equal(again.written, false);
  assert.match(again.reason, /already exist/);
});

test('a user-defined notify script is sacred', () => {
  const dir = tmpProject({ pkg: { name: 'x', scripts: { 'notify:success': 'my-own-thing' } } });
  const result = addNotifyScripts(dir, 49123);
  assert.equal(result.written, false);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['notify:success'], 'my-own-thing');
});

test('malformed package.json is reported, not thrown', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
  assert.equal(detectProject(dir).notifyScriptsPresent, false);
  const result = addNotifyScripts(dir, 49123);
  assert.equal(result.written, false);
  assert.match(result.reason, /malformed/);
});

test('the docker recipe targets the configured port', () => {
  assert.match(dockerRecipe(50000), /127\.0\.0\.1:50000\/notify/);
});

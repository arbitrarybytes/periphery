'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

/**
 * One product, two shells (see ai-native/versioning.md). The strategy is only
 * real if something enforces it — otherwise the two numbers drift and
 * /health starts lying about what the user is running.
 */
test('the Node and Rust editions carry the same product version', () => {
  const cargo = fs.readFileSync(path.join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf8');
  // The first `version =` in the file belongs to [package]; dependency
  // versions all appear later and are inline in their own tables.
  const match = cargo.match(/^version = "([^"]+)"/m);

  assert.ok(match, 'src-tauri/Cargo.toml must declare a package version');
  assert.equal(
    match[1],
    pkg.version,
    'bump both package.json and src-tauri/Cargo.toml, or neither',
  );
});

test('the product version is valid semver with an explicit prerelease during beta', () => {
  assert.match(
    pkg.version,
    /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
    'installers and the updater both parse this',
  );
});

test('the Tauri bundle inherits its version rather than declaring a second one', () => {
  const conf = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  assert.equal(
    conf.version,
    undefined,
    'a version here would be a third place to forget to bump; Tauri falls back to Cargo.toml',
  );
});

test('the two editions install side by side rather than overwriting each other', () => {
  const conf = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  assert.notEqual(
    conf.identifier,
    pkg.build.appId,
    'sharing an app id would make one installer replace the other',
  );
});

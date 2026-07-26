'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ConfigStore = require('../utils/stores/ConfigStore');
const JsonFileStore = require('../utils/stores/JsonFileStore');
const SecureStore = require('../utils/stores/SecureStore');

/** @returns {string} path to a fresh JSON store inside a temp dir */
function tempStorePath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'periphery-test-'));
  return path.join(dir, name);
}

/**
 * Reversible stand-in for Electron's safeStorage.
 * @param {boolean} available
 */
function fakeCrypto(available) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf) => {
      const text = buf.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not encrypted');
      return text.slice(4);
    },
  };
}

test('config defaults apply to keys missing from an existing file', () => {
  const storePath = tempStorePath('config.json');
  fs.writeFileSync(storePath, JSON.stringify({ gitlabProjectId: '42' }));

  const store = new ConfigStore(storePath);
  assert.equal(store.get('gitlabProjectId'), '42');
  // Previously defaults were only used when no file existed at all, so
  // verboseMode came back undefined and the Settings toggle rendered off.
  assert.equal(store.get('verboseMode'), true);
  assert.equal(store.getAll().verboseMode, true);
});

test('config values round-trip through disk', () => {
  const storePath = tempStorePath('config.json');
  new ConfigStore(storePath).setMany({ glowRepeats: 7, verboseMode: false });

  const reloaded = new ConfigStore(storePath);
  assert.equal(reloaded.get('glowRepeats'), 7);
  assert.equal(reloaded.get('verboseMode'), false);
});

test('a corrupt config file falls back to defaults instead of throwing', () => {
  const storePath = tempStorePath('config.json');
  fs.writeFileSync(storePath, '{ not json');

  const store = new ConfigStore(storePath);
  assert.equal(store.get('glowRepeats'), 3);
});

test('secrets round-trip when encryption is available', () => {
  const storePath = tempStorePath('secrets.json');
  const store = new SecureStore(storePath, fakeCrypto(true));

  assert.equal(store.setSecret('gitlab-pat', 'glpat-secret'), true);
  assert.equal(store.getSecret('gitlab-pat'), 'glpat-secret');
  // The plaintext must not be recoverable from the file itself.
  assert.equal(fs.readFileSync(storePath, 'utf8').includes('glpat-secret'), false);
});

test('a secret written without encryption is still readable once it is available', () => {
  const storePath = tempStorePath('secrets.json');

  const withoutCrypto = new SecureStore(storePath, fakeCrypto(false));
  assert.equal(withoutCrypto.setSecret('gitlab-pat', 'glpat-secret'), false);

  // Same file, encryption now available. This used to feed the plaintext to
  // decryptString, which threw and silently reported "no token found".
  const withCrypto = new SecureStore(storePath, fakeCrypto(true));
  assert.equal(withCrypto.getSecret('gitlab-pat'), 'glpat-secret');
});

test('undecryptable secrets return null rather than garbage', () => {
  const storePath = tempStorePath('secrets.json');
  new SecureStore(storePath, fakeCrypto(true)).setSecret('gitlab-pat', 'glpat-secret');

  const brokenCrypto = {
    ...fakeCrypto(true),
    decryptString: () => { throw new Error('wrong key'); },
  };
  assert.equal(new SecureStore(storePath, brokenCrypto).getSecret('gitlab-pat'), null);
});

test('a legacy FlowState store file is adopted under the new name', () => {
  const storePath = tempStorePath('periphery-config.json');
  const legacyPath = path.join(path.dirname(storePath), 'flowstate-config.json');
  fs.writeFileSync(legacyPath, JSON.stringify({ glowRepeats: 9 }));

  JsonFileStore.adoptLegacyFile(legacyPath, storePath);
  const store = new ConfigStore(storePath);

  assert.equal(store.get('glowRepeats'), 9, 'settings survive the rebrand');
  assert.equal(fs.existsSync(legacyPath), false, 'old file is renamed, not copied');
});

test('adoption never overwrites an existing new-name store', () => {
  const storePath = tempStorePath('periphery-config.json');
  const legacyPath = path.join(path.dirname(storePath), 'flowstate-config.json');
  fs.writeFileSync(legacyPath, JSON.stringify({ glowRepeats: 9 }));
  fs.writeFileSync(storePath, JSON.stringify({ glowRepeats: 5 }));

  JsonFileStore.adoptLegacyFile(legacyPath, storePath);

  assert.equal(new ConfigStore(storePath).get('glowRepeats'), 5);
  assert.equal(fs.existsSync(legacyPath), true);
});

test('secrets can be reported on and removed without being read back', () => {
  const storePath = tempStorePath('secrets.json');
  const store = new SecureStore(storePath, fakeCrypto(true));

  assert.equal(store.hasSecret('gitlab-pat'), false);
  store.setSecret('gitlab-pat', 'glpat-secret');
  assert.equal(store.hasSecret('gitlab-pat'), true);

  assert.equal(store.deleteSecret('gitlab-pat'), true);
  assert.equal(store.hasSecret('gitlab-pat'), false);
  assert.equal(store.getSecret('gitlab-pat'), null);
  assert.equal(new SecureStore(storePath, fakeCrypto(true)).hasSecret('gitlab-pat'), false);
});

'use strict';

const { app, safeStorage } = require('electron');
const path = require('path');

const SecureStore = require('./stores/SecureStore');

/**
 * On Windows this is DPAPI, on macOS the Keychain, on Linux the available
 * secret service (kwallet/libsecret) — the ciphertext itself still lives in
 * the JSON file below.
 */
const crypto = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plain) => safeStorage.encryptString(plain),
  decryptString: (buf) => safeStorage.decryptString(buf),
};

module.exports = new SecureStore(
  path.join(app.getPath('userData'), 'flowstate-secrets.json'),
  crypto,
);

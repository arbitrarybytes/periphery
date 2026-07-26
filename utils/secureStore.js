'use strict';

const { app, safeStorage } = require('electron');
const path = require('path');

const SecureStore = require('./stores/SecureStore');
const JsonFileStore = require('./stores/JsonFileStore');

const userData = app.getPath('userData');
const storePath = path.join(userData, 'periphery-secrets.json');

// Tokens stored before the FlowState -> Periphery rebrand.
JsonFileStore.adoptLegacyFile(path.join(userData, 'flowstate-secrets.json'), storePath);

// safeStorage already has the CryptoBackend shape SecureStore expects. On
// Windows it is DPAPI, on macOS the Keychain, on Linux the available secret
// service (kwallet/libsecret) — the ciphertext itself still lives in the JSON
// file below.
module.exports = new SecureStore(storePath, safeStorage);

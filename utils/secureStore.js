const { safeStorage, app } = require('electron');
const fs = require('fs');
const path = require('path');

class SecureStore {
  constructor() {
    this.storePath = path.join(app.getPath('userData'), 'flowstate-secrets.json');
    this.store = this._loadStore();
  }

  _loadStore() {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.error('Failed to load secure store', err);
    }
    return {};
  }

  _saveStore() {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save secure store', err);
    }
  }

  /**
   * Encrypts and saves a secret
   */
  setSecret(key, value) {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('OS Encryption not available. Saving in plaintext (NOT SECURE).');
      this.store[key] = value;
    } else {
      const encryptedBuffer = safeStorage.encryptString(value);
      // Save as base64 to store in JSON
      this.store[key] = encryptedBuffer.toString('base64');
    }
    this._saveStore();
  }

  /**
   * Retrieves and decrypts a secret
   */
  getSecret(key) {
    const value = this.store[key];
    if (!value) return null;

    if (!safeStorage.isEncryptionAvailable()) {
      return value; // Assume plaintext if encryption wasn't available
    }

    try {
      const encryptedBuffer = Buffer.from(value, 'base64');
      return safeStorage.decryptString(encryptedBuffer);
    } catch (err) {
      console.error(`Failed to decrypt secret for key: ${key}`, err);
      return null;
    }
  }
}

module.exports = new SecureStore();

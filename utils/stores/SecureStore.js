'use strict';

const JsonFileStore = require('./JsonFileStore');

/** Owner read/write only; ignored on Windows, where ACLs are inherited. */
const SECRET_FILE_MODE = 0o600;

/**
 * Encrypted-at-rest secret storage.
 *
 * Each entry records whether it was actually encrypted, so a store written
 * while OS encryption was unavailable is still readable later (previously the
 * plaintext was fed to decryptString, which threw and silently dropped the
 * token).
 *
 * @typedef {object} CryptoBackend
 * @property {() => boolean} isEncryptionAvailable
 * @property {(plain: string) => Buffer} encryptString
 * @property {(buf: Buffer) => string} decryptString
 */
class SecureStore extends JsonFileStore {
  /**
   * @param {string} storePath
   * @param {CryptoBackend} crypto
   */
  constructor(storePath, crypto) {
    super(storePath, { mode: SECRET_FILE_MODE });
    this.crypto = crypto;
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {boolean} whether the value was stored encrypted
   */
  setSecret(key, value) {
    let encrypted = false;
    try {
      encrypted = this.crypto.isEncryptionAvailable();
    } catch (err) {
      console.error('[SecureStore] Could not query OS encryption availability', err);
    }

    if (encrypted) {
      this.store[key] = {
        encrypted: true,
        value: this.crypto.encryptString(value).toString('base64'),
      };
    } else {
      console.warn(`[SecureStore] OS encryption unavailable; storing "${key}" in plaintext (NOT SECURE).`);
      this.store[key] = { encrypted: false, value };
    }

    this._save();
    return encrypted;
  }

  /**
   * @param {string} key
   * @returns {string|null}
   */
  getSecret(key) {
    const entry = this.store[key];
    if (entry === undefined || entry === null) return null;

    // Entries written before the encrypted/plaintext discriminator existed
    // were bare strings; treat them as legacy and refuse to guess.
    if (typeof entry === 'string') {
      console.warn(`[SecureStore] Legacy entry for "${key}"; re-enter it in Settings.`);
      return null;
    }

    if (!entry.encrypted) return entry.value;

    try {
      return this.crypto.decryptString(Buffer.from(entry.value, 'base64'));
    } catch (err) {
      console.error(`[SecureStore] Failed to decrypt secret for key: ${key}`, err);
      return null;
    }
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  hasSecret(key) {
    return this.store[key] !== undefined && this.store[key] !== null;
  }

  /**
   * Removes a stored secret, so disabling a connector can also drop its
   * credential rather than leaving it on disk forever.
   * @param {string} key
   * @returns {boolean} whether anything was removed
   */
  deleteSecret(key) {
    if (!this.hasSecret(key)) return false;
    delete this.store[key];
    this._save();
    return true;
  }
}

module.exports = SecureStore;
module.exports.SECRET_FILE_MODE = SECRET_FILE_MODE;

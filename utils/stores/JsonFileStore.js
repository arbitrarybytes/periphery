'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal JSON-file persistence shared by ConfigStore and SecureStore.
 * Deliberately free of Electron imports so both can be unit-tested and
 * ported alongside the connectors (see docs/ADR.md).
 */
class JsonFileStore {
  /**
   * Adopts a store file left behind by an earlier app name (FlowState →
   * Periphery), so a rebrand does not silently discard the user's settings
   * and tokens. No-op unless the old file exists and the new one does not.
   * @param {string} legacyPath
   * @param {string} storePath
   */
  static adoptLegacyFile(legacyPath, storePath) {
    try {
      if (fs.existsSync(legacyPath) && !fs.existsSync(storePath)) {
        fs.renameSync(legacyPath, storePath);
        console.log(`[Store] Migrated ${path.basename(legacyPath)} -> ${path.basename(storePath)}`);
      }
    } catch (err) {
      console.error(`[Store] Could not migrate ${legacyPath}`, err);
    }
  }

  /**
   * @param {string} storePath - absolute path of the backing JSON file
   * @param {object} [options]
   * @param {number} [options.mode] - file mode applied on write
   */
  constructor(storePath, { mode } = {}) {
    this.storePath = storePath;
    this.mode = mode;
    this.store = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf8');
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
        console.error(`[Store] ${this.storePath} is not a JSON object, ignoring it.`);
      }
    } catch (err) {
      console.error(`[Store] Failed to load ${this.storePath}`, err);
    }
    return {};
  }

  /**
   * Writes via a temp file + rename so a crash mid-write cannot leave a
   * truncated store behind (which previously meant silent token loss).
   */
  _save() {
    const tmpPath = `${this.storePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(this.store, null, 2), {
        encoding: 'utf8',
        ...(this.mode === undefined ? {} : { mode: this.mode }),
      });
      fs.renameSync(tmpPath, this.storePath);
    } catch (err) {
      console.error(`[Store] Failed to save ${this.storePath}`, err);
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // best effort only
      }
    }
  }
}

module.exports = JsonFileStore;

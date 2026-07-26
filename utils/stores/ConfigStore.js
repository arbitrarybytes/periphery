'use strict';

const JsonFileStore = require('./JsonFileStore');

/** Effective defaults for every non-secret setting. */
const DEFAULTS = Object.freeze({
  glowRepeats: 3,
  verboseMode: true,
  respectFocusAssist: true,
  slackTideEnabled: true,
  pomodoroEnabled: true,
  pomodoroMinutes: 25,
  outlookEnabled: true,
  gitlabEnabled: true,
  gitlabProjectId: '',
  outlookEmail: '',
});

class ConfigStore extends JsonFileStore {
  /**
   * @param {string} storePath
   * @param {object} [defaults]
   */
  constructor(storePath, defaults = DEFAULTS) {
    super(storePath);
    this.defaults = defaults;
    // Defaults are merged *under* the loaded file rather than used only when
    // no file exists, so a key added in a later release still has a value for
    // users who already have a config on disk.
    this.store = { ...defaults, ...this.store };
  }

  get(key, defaultValue = null) {
    if (this.store[key] !== undefined) return this.store[key];
    if (this.defaults[key] !== undefined) return this.defaults[key];
    return defaultValue;
  }

  set(key, value) {
    this.store[key] = value;
    this._save();
  }

  /**
   * Applies several keys with a single write.
   * @param {Record<string, unknown>} values
   */
  setMany(values) {
    Object.assign(this.store, values);
    this._save();
  }

  getAll() {
    return { ...this.store };
  }
}

module.exports = ConfigStore;
module.exports.DEFAULTS = DEFAULTS;

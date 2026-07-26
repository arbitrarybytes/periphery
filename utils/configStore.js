const { app } = require('electron');
const fs = require('fs');
const path = require('path');

class ConfigStore {
  constructor() {
    this.storePath = path.join(app.getPath('userData'), 'flowstate-config.json');
    this.store = this._loadStore();
  }

  _loadStore() {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.error('Failed to load config store', err);
    }
    return {
      glowRepeats: 3,
      verboseMode: true,
      outlookEnabled: true,
      gitlabEnabled: true
    };
  }

  _saveStore() {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save config store', err);
    }
  }

  get(key, defaultValue = null) {
    return this.store[key] !== undefined ? this.store[key] : defaultValue;
  }

  set(key, value) {
    this.store[key] = value;
    this._saveStore();
  }
  
  getAll() {
    return { ...this.store };
  }
}

module.exports = new ConfigStore();

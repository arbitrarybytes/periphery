'use strict';

const { app } = require('electron');
const path = require('path');

const ConfigStore = require('./stores/ConfigStore');

module.exports = new ConfigStore(path.join(app.getPath('userData'), 'flowstate-config.json'));

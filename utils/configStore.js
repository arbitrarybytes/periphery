'use strict';

const { app } = require('electron');
const path = require('path');

const ConfigStore = require('./stores/ConfigStore');
const JsonFileStore = require('./stores/JsonFileStore');

const userData = app.getPath('userData');
const storePath = path.join(userData, 'periphery-config.json');

// Settings written before the FlowState -> Periphery rebrand.
JsonFileStore.adoptLegacyFile(path.join(userData, 'flowstate-config.json'), storePath);

module.exports = new ConfigStore(storePath);

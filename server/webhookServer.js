'use strict';

const express = require('express');

const {
  sanitizeCuePayload, sanitizeResolvePayload, CUE_NAMES, STATE_CUES, ICON_NAMES,
} = require('../utils/cuePayload');

const { version } = require('../package.json');

const DEFAULT_PORT = 49123;
/** Which shell is answering. See ai-native/versioning.md. */
const EDITION = 'node';
/** Loopback only. Never widen this: the receiver is unauthenticated by design. */
const HOST = '127.0.0.1';
const BODY_LIMIT = '8kb';

/**
 * Hostnames a genuine loopback client will send. Only the host is checked, not
 * the port: the request already arrived on our socket, so the port carries no
 * information. Checking this blocks DNS-rebinding, where a browser resolves
 * attacker.example to 127.0.0.1 and posts to us with its own Host header.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * @param {string|undefined} header - raw Host header, e.g. "127.0.0.1:49123"
 * @returns {boolean}
 */
function isLoopbackHost(header) {
  if (typeof header !== 'string') return false;
  const host = header.toLowerCase().trim();
  // Strip the port, taking care not to split an IPv6 literal on its colons.
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0];
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Builds the local cue receiver.
 *
 * There is deliberately no CORS middleware. The only legitimate clients are
 * local scripts and CLI tools, which are unaffected by CORS; enabling it would
 * instead let any web page the user visits drive the overlay.
 *
 * @param {object} options
 * @param {(payload: object) => void} options.onCue - called with a validated payload
 * @param {(request: {ref?: string, all: boolean}) => number} [options.onResolve]
 *   clears a state cue (see STATE_CUES); returns how many were cleared
 * @returns {import('express').Express}
 */
function createWebhookApp({ onCue, onResolve }) {
  const app = express();

  app.disable('x-powered-by');

  app.use((req, res, next) => {
    if (!isLoopbackHost(req.headers.host)) {
      res.status(403).json({ success: false, error: 'Forbidden host' });
      return;
    }
    // Local tooling never sends Origin; a browser always does. Its presence
    // means the request came from a web page rather than the user's machine.
    if (req.headers.origin !== undefined) {
      res.status(403).json({ success: false, error: 'Browser origins are not accepted' });
      return;
    }
    next();
  });

  app.use(express.json({ limit: BODY_LIMIT }));

  app.get('/health', (req, res) => {
    res.json({
      success: true,
      // Both editions answer on the same port and behave alike, so a client,
      // hook, or bug report needs a way to say which one replied.
      version,
      edition: EDITION,
      cues: CUE_NAMES,
      stateCues: STATE_CUES,
      icons: ICON_NAMES,
    });
  });

  app.post('/notify', (req, res) => {
    const payload = sanitizeCuePayload(req.body);
    if (!payload) {
      res.status(400).json({
        success: false,
        error: `"cue" is required and must be one of: ${CUE_NAMES.join(', ')}`,
      });
      return;
    }

    onCue(payload);
    res.status(200).json({ success: true, message: `Triggered ${payload.cue}` });
  });

  // Clears a state cue. `{"ref": "..."}` clears one, `{"all": true}` clears
  // every one — the counterpart to posting a `glow-blocked` cue.
  app.post('/resolve', (req, res) => {
    const request = sanitizeResolvePayload(req.body);
    if (!request) {
      res.status(400).json({
        success: false,
        error: 'Send {"ref": "<id>"} or {"all": true}',
      });
      return;
    }

    const cleared = onResolve ? onResolve(request) : 0;
    res.status(200).json({
      success: true,
      cleared,
      message: cleared > 0
        ? `Cleared ${cleared} blocked agent${cleared === 1 ? '' : 's'}`
        : 'Nothing was waiting',
    });
  });

  // Malformed JSON reaches here as a SyntaxError from express.json().
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    console.error('[Webhook] Request error', err.message);
    res.status(400).json({ success: false, error: 'Invalid request body' });
  });

  return app;
}

/**
 * Starts the receiver on the loopback interface.
 * @param {object} options - as createWebhookApp, plus:
 * @param {(err: Error) => void} [options.onError] - called instead of throwing
 *   when the port is already taken (a second instance, or another app).
 * @returns {import('http').Server}
 */
function startWebhookServer({ onCue, onResolve, port = DEFAULT_PORT, onError }) {
  const app = createWebhookApp({ onCue, onResolve });
  const server = app.listen(port, HOST, () => {
    console.log(`Periphery local hook listening on http://${HOST}:${port}`);
  });

  server.on('error', (err) => {
    if (onError) {
      onError(err);
      return;
    }
    console.error('[Webhook] Server error', err);
  });

  return server;
}

module.exports = {
  startWebhookServer, DEFAULT_PORT, HOST, EDITION,
};

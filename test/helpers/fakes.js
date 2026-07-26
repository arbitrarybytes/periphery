'use strict';

/**
 * Test doubles shared by the connector tests.
 */

/**
 * Stubs global fetch with a queue of scripted responses keyed by URL substring.
 * @param {Array<{match: string, status?: number, body?: unknown}>} routes
 * @returns {{restore: () => void, calls: string[]}}
 */
function stubFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const route = routes.find((r) => String(url).includes(r.match));
    if (!route) throw new Error(`No stubbed route for ${url}`);

    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => route.body,
    };
  };

  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

/**
 * @param {Record<string, string>} secrets
 * @returns {{getSecret: (key: string) => string|null}}
 */
function fakeSecretStore(secrets) {
  return { getSecret: (key) => secrets[key] ?? null };
}

/**
 * Collects the cues a connector emits.
 * @param {import('../../connectors/BaseConnector')} connector
 * @returns {object[]}
 */
function collectCues(connector) {
  const cues = [];
  connector.on('trigger-cue', (payload) => cues.push(payload));
  return cues;
}

module.exports = { stubFetch, fakeSecretStore, collectCues };

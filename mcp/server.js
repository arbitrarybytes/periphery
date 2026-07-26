#!/usr/bin/env node
'use strict';

/**
 * Periphery MCP server — lets coding agents (Claude Code, Devin, GitHub
 * Copilot, or anything MCP-capable) signal through ambient light instead of
 * a terminal bell the user cannot see. See ai-native/agents.md for client setup.
 *
 * Speaks MCP over stdio (newline-delimited JSON-RPC 2.0) and forwards tool
 * calls to the local webhook (server/webhookServer.js). Zero dependencies;
 * requires Node >= 18 for global fetch. Never write logs to stdout — that
 * channel belongs to the protocol; diagnostics go to stderr.
 */

const DEFAULT_PORT = 49123; // Keep in sync with server/webhookServer.js — this
// file must stay dependency-free so agents can run it without node_modules.

const AGENT_COLOR = 'rgba(168, 130, 255, 0.85)'; // utils/palette.js AGENT
const FAIL_COLOR = 'rgba(255, 0, 50, 0.9)'; // utils/palette.js DANGER

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'periphery', version: '1.0.0' };

const TOOLS = [
  {
    name: 'task_complete',
    description: 'Signal that a long-running task finished. Shows a persistent '
      + 'violet beacon in the corner of the user\'s screen that stays until they '
      + 'are back at the keyboard, so the result is never missed. Use this when '
      + 'a build, test run, refactor, or any task the user delegated is done.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One short line describing what finished, e.g. "Tests passed: 214/214" (160 chars max)',
        },
        success: {
          type: 'boolean',
          description: 'Whether the task succeeded (default true). Failures show in red.',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'notify',
    description: 'Fire a one-shot ambient visual cue on the user\'s screen — a '
      + 'quiet glow, not a popup. Use for progress worth knowing that does not '
      + 'need acknowledgment. Cues: glow (edge breathe), glow-bottom (subtle '
      + 'horizon), glow-pulse (repeating pulse), comet (bright streak; reserved '
      + 'for genuinely urgent events).',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text for the message pill (160 chars max)' },
        cue: {
          type: 'string',
          enum: ['glow', 'glow-bottom', 'glow-pulse', 'comet'],
          description: 'Cue variant (default glow-pulse)',
        },
        color: { type: 'string', description: 'Optional hex/rgb()/rgba() colour literal' },
        urgent: { type: 'boolean', description: 'Pierce focus mode (use sparingly)' },
      },
      required: ['message'],
    },
  },
];

/** @param {unknown} args @returns {object} the webhook payload for task_complete */
function taskCompletePayload(args) {
  const failed = args.success === false;
  return {
    cue: 'glow-agent',
    icon: 'agent',
    color: failed ? FAIL_COLOR : AGENT_COLOR,
    msg: String(args.summary),
  };
}

/** @param {unknown} args @returns {object} the webhook payload for notify */
function notifyPayload(args) {
  const payload = {
    cue: typeof args.cue === 'string' ? args.cue : 'glow-pulse',
    msg: String(args.message),
    icon: 'agent',
  };
  if (typeof args.color === 'string') payload.color = args.color;
  if (args.urgent === true) payload.urgent = true;
  return payload;
}

/**
 * Handles one JSON-RPC message.
 * @param {object} message
 * @param {(payload: object) => Promise<{ok: boolean, error?: string}>} postCue
 * @returns {Promise<object|null>} the response, or null for notifications
 */
async function handleMessage(message, postCue) {
  if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') return null;
  const { id, method, params } = message;

  // Notifications (no id) get no response.
  if (id === undefined || id === null) return null;

  const respond = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

  switch (method) {
    case 'initialize':
      return respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};

      let payload;
      if (name === 'task_complete' && typeof args.summary === 'string') {
        payload = taskCompletePayload(args);
      } else if (name === 'notify' && typeof args.message === 'string') {
        payload = notifyPayload(args);
      } else if (name === 'task_complete' || name === 'notify') {
        return fail(-32602, `Missing required argument for ${name}`);
      } else {
        return fail(-32602, `Unknown tool: ${name}`);
      }

      const result = await postCue(payload);
      if (!result.ok) {
        return respond({
          content: [{ type: 'text', text: `Could not deliver the cue: ${result.error}` }],
          isError: true,
        });
      }
      return respond({
        content: [{
          type: 'text',
          text: name === 'task_complete'
            ? 'Beacon lit. It will stay in the corner of the user\'s screen until they are back at the keyboard.'
            : 'Cue delivered as ambient light.',
        }],
      });
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

/** POSTs a cue to the local webhook. */
async function postCueToWebhook(payload) {
  const port = Number(process.env.PERIPHERY_PORT || DEFAULT_PORT);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, error: body.error || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: `Periphery is not running on port ${port}` };
  }
}

function main() {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  // Messages are handled on one serial chain: responses keep request order,
  // and stdin closing waits for in-flight work instead of dropping replies.
  let inFlight = Promise.resolve();

  rl.on('line', (line) => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write('[periphery-mcp] Ignoring malformed JSON line\n');
      return;
    }
    inFlight = inFlight.then(async () => {
      const response = await handleMessage(message, postCueToWebhook);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });

  rl.on('close', () => {
    inFlight.then(() => process.exit(0));
  });
}

// Exported for tests; runs as an MCP server when invoked directly.
if (require.main === module) main();

module.exports = { handleMessage, TOOLS, PROTOCOL_VERSION };

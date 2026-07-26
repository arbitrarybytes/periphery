#!/usr/bin/env node
'use strict';

/**
 * `periphery` CLI — thin sugar over the local webhook (see docs/webhooks.md).
 * Zero dependencies; requires Node >= 18 for global fetch.
 *
 *   periphery notify --msg "Build finished" [--cue glow-pulse] [--color ...]
 *                    [--icon ...] [--urgent] [--agent]
 *   periphery done ["msg"] [--fail]     # agent-style completion beacon
 *   periphery health                    # what the running build accepts
 *
 * `done` is built for command chaining and coding agents:
 *   long_build && periphery done "build finished" || periphery done --fail "build failed"
 */

const DEFAULT_PORT = 49123; // Keep in sync with server/webhookServer.js — this
// file must stay dependency-free so it runs without the app's node_modules.

const AGENT_COLOR = 'rgba(168, 130, 255, 0.85)'; // utils/palette.js AGENT
const FAIL_COLOR = 'rgba(255, 0, 50, 0.9)'; // utils/palette.js DANGER

const USAGE = `periphery — ambient cues from your terminal

Usage:
  periphery notify --msg "text" [options]   Fire a cue
  periphery done ["msg"] [--fail]           Persistent agent beacon (glow-agent)
  periphery health                          List cues/icons the app accepts

Options:
  --cue <name>     glow | glow-bottom | glow-pulse | glow-agent | comet
  --msg <text>     Message for the text pill (160 chars max)
  --color <css>    Hex/rgb()/rgba() literal or colour keyword
  --icon <name>    Bundled icon (gitlab, github, outlook, calendar, pomodoro, alert, agent)
  --urgent         Deliver at the highest tier (pierces focus mode)
  --agent          Shorthand for --cue glow-agent --icon agent
  --port <n>       Webhook port (default ${DEFAULT_PORT}; or PERIPHERY_PORT env)
`;

/**
 * @param {string[]} argv
 * @returns {{command: string|undefined, positional: string[], flags: Record<string, string|boolean>}}
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const valueFlags = new Set(['cue', 'msg', 'color', 'icon', 'port']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (valueFlags.has(name)) {
      flags[name] = argv[++i];
    } else {
      flags[name] = true;
    }
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

/**
 * @param {{command: string|undefined, positional: string[], flags: Record<string, string|boolean>}} parsed
 * @returns {{path: string, payload?: object}|null} the request to make, or null for usage errors
 */
function buildRequest({ command, positional, flags }) {
  if (command === 'health') return { path: '/health' };

  if (command === 'notify') {
    const payload = { cue: typeof flags.cue === 'string' ? flags.cue : 'glow-pulse' };
    if (flags.agent === true) {
      payload.cue = 'glow-agent';
      payload.icon = 'agent';
    }
    if (typeof flags.msg === 'string') payload.msg = flags.msg;
    if (typeof flags.color === 'string') payload.color = flags.color;
    if (typeof flags.icon === 'string') payload.icon = flags.icon;
    if (flags.urgent === true) payload.urgent = true;
    return { path: '/notify', payload };
  }

  if (command === 'done') {
    const failed = flags.fail === true;
    return {
      path: '/notify',
      payload: {
        cue: 'glow-agent',
        icon: 'agent',
        color: failed ? FAIL_COLOR : AGENT_COLOR,
        msg: positional[0]
          || (typeof flags.msg === 'string' ? flags.msg : null)
          || (failed ? 'Task failed' : 'Task complete'),
      },
    };
  }

  return null;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const request = buildRequest(parsed);
  if (!request) {
    process.stderr.write(USAGE);
    process.exit(parsed.command === undefined || parsed.command === 'help' ? 0 : 1);
  }

  const port = Number(parsed.flags.port || process.env.PERIPHERY_PORT || DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}${request.path}`;

  try {
    const response = await fetch(url, request.payload ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.payload),
    } : undefined);

    const body = await response.json();
    if (!response.ok) {
      process.stderr.write(`periphery: ${body.error || `HTTP ${response.status}`}\n`);
      process.exit(1);
    }
    process.stdout.write(request.path === '/health'
      ? `${JSON.stringify(body, null, 2)}\n`
      : `${body.message || 'ok'}\n`);
  } catch {
    process.stderr.write(`periphery: could not reach Periphery on port ${port} — is it running?\n`);
    process.exit(1);
  }
}

// Exported for tests; runs as a CLI when invoked directly.
if (require.main === module) main();

module.exports = { parseArgs, buildRequest, DEFAULT_PORT };

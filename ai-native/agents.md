# Periphery for Coding Agents

Coding agents finish long tasks while you are looking elsewhere. A terminal
bell rings into a window you cannot see; a toast interrupts the thing you
switched to. Periphery gives agents a third option: **ambient light that
waits for you**.

Two integration paths, both local-only:

| Path | Best for | Entry point |
| ---- | -------- | ----------- |
| **MCP server** | Claude Code, Devin, GitHub Copilot, any MCP client | `mcp/server.js` |
| **CLI / webhook** | Hooks, shell chains, agents without MCP | `cli/periphery.js` or plain HTTP |

Both talk to the same loopback receiver (`http://127.0.0.1:49123`, see
[webhooks.md](webhooks.md)); nothing leaves your machine.

## The two agent cues, and when to use which

| Situation | Cue | Behaviour |
| --------- | --- | --------- |
| Task **finished** | `glow-agent` (violet, bottom-**right**) | Persists until you are back at the keyboard, then replays its message once and fades |
| Agent **blocked on you** | `glow-blocked` (coral, bottom-**left**) | Persists and **escalates with age**; clears only when the agent says it can proceed, or you dismiss it |

They sit in opposite corners and pulse with different rhythms on purpose:
"done" and "waiting for you" must never be confused at a glance.

## The blocked beacon (`glow-blocked`) — an agent waiting on you

A finished task merely waits to be noticed; the cost of missing it is bounded.
A **blocked** agent burns wall-clock time on work already in flight, and that
cost compounds every second. So this cue is the one thing in Periphery that
gets *more* insistent on its own:

| Age | Level | What you see |
| --- | ----- | ------------ |
| 0–60 s | 0 | A quiet coral glow, bottom-left — about as loud as a completion beacon |
| 1–4 min | 1 | Brighter, larger, faster two-beat rhythm |
| 4 min+ | 2 | Insistent — and that is the ceiling |

Escalation is **bounded by design**. It never becomes a comet, never makes a
sound, never covers anything. It rides on three channels at once — brightness,
size, and rhythm — so it still escalates on battery and under
`prefers-reduced-motion`, where it holds still at a rising brightness.

Two behaviours that make it correct rather than just "an orange beacon":

*   **Being back at the keyboard does not clear it.** Presence is not approval.
    It clears when the agent calls `task_unblocked`, when you dismiss it from
    the tray, or after a one-hour safety timeout (an agent stalled that long is
    presumed dead, not waiting).
*   **It pierces focus mode by default.** This is your own delegated work
    asking for the one thing only you can give — but it pierces *gently*, as an
    escalating ambient beacon rather than an interruption. Turn off
    "…even during focus mode" in Settings if you would rather it be held like
    any other ambient cue.

While anything is blocked, the tray icon carries a **coral** badge dot (it
outranks the amber connector-health dot — a blocked agent is actively wasting
time), the tooltip counts them, and a **Dismiss N waiting agents** item appears
at the top of the tray menu.

**Feature toggles:** Settings → *Summaries & Agents* → "Escalate agents waiting
on approval" (off = renders as an ordinary completion beacon) and "…even during
focus mode".

### Using it

```bash
# MCP (preferred — agents call these directly):
#   task_blocked   { question: "Approve deleting 3 migration files?", ref: "mig-1" }
#   task_unblocked { ref: "mig-1" }          # omit ref to clear everything

# CLI:
periphery blocked "Approve deleting 3 migration files?" --ref mig-1
periphery unblocked --ref mig-1

# Raw HTTP:
curl -X POST http://127.0.0.1:49123/notify \
     -d '{"cue":"glow-blocked","icon":"blocked","ref":"mig-1","msg":"Approve?"}'
curl -X POST http://127.0.0.1:49123/resolve -d '{"ref":"mig-1"}'
```

Always pair them. A stale beacon trains the user to ignore real ones — which is
the only way this feature can fail. Re-calling `task_blocked` with the same
`ref` refreshes the wording but deliberately **does not reset the clock**, so a
chatty agent cannot keep itself quiet.

## The completion beacon (`glow-agent`)

Ordinary cues fade after a few seconds — if you are away or deep in another
window, they are gone. Agent completions use a **different variant of glow**
built to be un-missable without being interruptive:

*   A violet wedge of light **breathes in the bottom-right corner** with the
    message pill shown once on arrival.
*   It **does not expire**. It stays until you are demonstrably back at the
    keyboard (at least 45 s on screen, then input activity), at which point
    the message pill **replays once** and the beacon fades. Away for three
    hours? The beacon waits three hours.
*   Failures render in red (`success: false` / `--fail`), successes in violet.
*   It skips the typing-pause hold (persistence makes pause-timing moot) and
    respects focus mode like every tier-2 cue.
*   On battery or with reduce-motion set, the beacon holds still instead of
    breathing — persistence is the feature, the animation is decoration.

**Feature toggle:** Settings → *Summaries & Agents* → “Persistent beacon for
coding agents”. Turned off, `glow-agent` degrades to a normal one-shot glow —
agents keep working, nothing becomes special.

## MCP server

`mcp/server.js` is a zero-dependency MCP server (stdio transport, Node ≥ 18).
It exposes four tools:

*   **`task_complete`** `{ summary, success? }` — lights the persistent agent
    beacon. Use when a delegated task (build, test run, refactor, migration)
    finishes.
*   **`task_blocked`** `{ question, ref? }` — lights the escalating blocked
    beacon. Call it the *moment* you start waiting on the user, not later.
*   **`task_unblocked`** `{ ref? }` — clears it. Omit `ref` to clear all.
*   **`notify`** `{ message, cue?, color?, urgent? }` — one-shot ambient cue
    for progress worth knowing that needs no acknowledgment.

Verify it locally (Periphery must be running):

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_complete","arguments":{"summary":"hello from MCP"}}}' | node mcp/server.js
```

### Claude Code

One command, from anywhere (use your absolute path to this repo):

```bash
claude mcp add periphery -- node C:/path/to/notification-system/mcp/server.js
```

Or per-project via `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "periphery": {
      "command": "node",
      "args": ["C:/path/to/notification-system/mcp/server.js"]
    }
  }
}
```

Claude Code will call `task_complete` when you ask it to (“light the beacon
when the tests finish”). To make it automatic, add a Stop hook in
`.claude/settings.json` — no MCP required:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node C:/path/to/notification-system/cli/periphery.js done \"Claude finished\""
      }]
    }]
  }
}
```

### Devin

Add the server in **Settings → MCP Marketplace / Custom MCP Server** with the
stdio command `node C:/path/to/notification-system/mcp/server.js` (no
environment variables needed; set `PERIPHERY_PORT` only if you changed the
webhook port). Then tell Devin in its playbook or knowledge:

> When a long-running task completes, call the `task_complete` tool from the
> `periphery` MCP server with a one-line summary. Whenever you need my approval
> or a decision before continuing, call `task_blocked` with the question, and
> `task_unblocked` once I have answered.

For cloud-hosted Devin sessions the MCP server runs where Devin runs, not
where you sit — in that case skip MCP and have Devin’s workspace call your
machine only if you have a tunnel you trust. The beacon is designed for
agents running **on your machine**.

### GitHub Copilot (VS Code)

Create `.vscode/mcp.json` in your workspace (or add via **MCP: Add Server**):

```json
{
  "servers": {
    "periphery": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/notification-system/mcp/server.js"]
    }
  }
}
```

Copilot’s agent mode will list `task_complete` and `notify` under available
tools. A workspace instruction (`.github/copilot-instructions.md`) makes use
automatic:

> After completing any task that took more than a minute, call the
> `task_complete` tool from the periphery server with a short summary. If you
> are ever waiting on me to approve or decide something, call `task_blocked`
> first and `task_unblocked` after.

## CLI

Zero-dependency sugar over the webhook — ideal for shell chains and hooks:

```bash
# Agent-style completion (persistent beacon):
node cli/periphery.js done "Migration finished: 42 files"

# Chain on success/failure:
npm test && node cli/periphery.js done "Tests green" || node cli/periphery.js done --fail "Tests failed"

# One-shot cues and introspection:
node cli/periphery.js notify --msg "Halfway there" --cue glow-pulse
node cli/periphery.js health
```

`npm link` (or a global install) puts `periphery` and `periphery-mcp` on your
PATH via the package `bin` entries. `--port` / `PERIPHERY_PORT` override the
default port.

Agents without MCP or Node can POST directly:

```bash
curl -X POST http://127.0.0.1:49123/notify \
     -H "Content-Type: application/json" \
     -d '{"cue":"glow-agent","icon":"agent","msg":"Task complete"}'
```

## Security notes

*   The MCP server and CLI are **clients** of the loopback receiver; they add
    no listening surface of their own.
*   Payloads are validated by the same allowlist as every webhook cue
    (`utils/cuePayload.js`): bundled icons only, exact colour literals,
    160-char messages.
*   The threat model is unchanged: anything running as your user can draw on
    your screen — see [webhooks.md](webhooks.md#threat-model).

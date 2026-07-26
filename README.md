# <img src="ui/assets/icon.svg" width="28" alt="" align="top"> Periphery

**Periphery** is a local-first, unobtrusive notification system designed specifically for deep-work professionals and enterprise developers.

Modern chat apps and notification centers are designed to steal your attention. Periphery is designed to protect it. Instead of jarring popups and sounds, it uses ambient, cinematic visual cues (like edge glows and shooting stars) drawn directly over your screen on a transparent canvas. You only notice what matters, exactly when it matters, without losing your train of thought.

## Core Philosophy: Privacy & Security First

Periphery was built from the ground up for strict enterprise environments where data exfiltration and cloud dependencies are unacceptable.

*   **No Cloud Backend:** There is no central server processing events, and no telemetry. The only outbound requests Periphery makes are the ones you configure: directly to GitLab and Microsoft Graph, from your machine. All UI assets are bundled locally, so the overlay never loads anything from the network.
*   **Encrypted Secret Storage:** Personal Access Tokens and OAuth tokens are encrypted with your OS credential store via Electron's [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) (DPAPI on Windows, Keychain on macOS, kwallet/libsecret on Linux). The ciphertext is written to `periphery-secrets.json` in the app's user-data directory. Where the OS offers no encryption backend — some Linux desktops — Periphery logs a warning and stores the value in plaintext; the Settings window always shows whether a token is stored and lets you remove it.
*   **Loopback-Only Webhook:** The local HTTP receiver binds to `127.0.0.1` and is unreachable from the network. See [ai-native/webhooks.md](ai-native/webhooks.md) for the full threat model.
*   **No Third-Party Brokers:** By running integrations locally, Periphery eliminates the need for 3rd-party automation brokers like Zapier or Make.com, which are often blocked by corporate firewalls.

Renderer processes run sandboxed with context isolation and a restrictive CSP; they reach the main process only through the narrow bridges in `preload.js` / `preload-settings.js`, and no bridge can read a stored secret back out.

## Architecture

Periphery is **migrating from Electron to Tauri 2** ([ADR 4](ai-native/ADR.md)). Both
shells drive the same frontend in [`ui/`](ui/) and the same behaviour; the Electron build
stays runnable until the Tauri shell is proven, so there is never a window with no working app.

```
src-tauri/               Rust backend (Tauri 2) — the destination
  src/cue.rs             Allowlist validation for untrusted cue payloads
  src/tiers.rs           Attention hierarchy, focus deferral, flush summary
  src/blocked.rs         Blocked-agent state + age escalation
  src/slack_tide.rs      Hold-until-pause delivery queue
  src/agent_beacon.rs    Acknowledgment watcher for completion beacons
  src/digest.rs          End-of-focus / while-you-were-away digests
  src/focus.rs           Native SHQueryUserNotificationState (no PowerShell)
  src/clock.rs           Injectable clock + input-idle source (testability)
```

Building the Tauri app needs the Rust toolchain plus the MSVC C++ build tools;
`npm start` (Electron) needs neither.

The Electron shell, still in place:

```
main.js                  Window/tray lifecycle, IPC, connector wiring
server/webhookServer.js  Loopback cue receiver (Express)
connectors/              Polling plugins; no Electron imports, unit-tested
utils/cuePayload.js      Allowlist validation for untrusted cue payloads
utils/win11.js           Accent parsing, attention tiers, DND state mapping
utils/focusAssist.js     Focus Assist / DND poller (SHQueryUserNotificationState)
utils/teamsPresence.js   Teams presence poller (Microsoft Graph /me/presence)
utils/slackTide.js       Hold-until-pause delivery queue (Slack Tide)
utils/agentBeacon.js     Acknowledgment watcher for persistent agent cues
utils/blockedAgents.js   Blocked-agent state + age escalation (state cues)
utils/digest.js          End-of-focus / while-you-were-away digest bookkeeping
utils/trayBadge.js       Accent badge-dot compositing for the tray icon
utils/stores/            Config + encrypted secret persistence
cli/periphery.js         `periphery` CLI (notify / done / health)
mcp/server.js            Local MCP server for coding agents (stdio)
preload*.js              contextBridge APIs (Electron only; removed after the port)
ui/                      Frontend: overlay, settings, onboarding (shared by both shells)
docs/                    Static landing page (GitHub Pages; not part of the app)
```

### The Connector Engine
The system relies on a modular `ConnectorManager` that loads specific integrations.
1.  **Direct API Polling:** Connectors (GitLab, GitHub, Outlook) poll APIs directly from your machine. They receive their credentials through an injected secret store rather than importing Electron, which keeps them testable and portable. The GitHub connector watches Actions runs on a repository plus your notifications (review requests, mentions, assignments).
2.  **The Local Webhook:** Periphery runs a lightweight HTTP server on `http://127.0.0.1:49123`. This lets you trigger notifications from native hooks in your existing developer tools (Git, npm, Docker) without a custom plugin for every tool.
3.  **Coding agents:** a zero-dependency [MCP server](ai-native/agents.md) and a `periphery` CLI let Claude Code, Devin, GitHub Copilot, or any script signal completions as ambient light — including the persistent **agent beacon** (below).

## Windows 11 Integration

Periphery is tuned first for Windows 11, degrading gracefully elsewhere:

*   **Fluent settings window.** The Settings window uses the Mica backdrop with a hidden title bar (Window Controls Overlay), Segoe UI Variable typography, and Win11-style cards and toggles that follow the system light/dark theme.
*   **Accent-colour harmony.** Cues that arrive without an explicit `color` — and the comet's default tail, the test cue, and the settings controls — use your Windows accent colour, updating live when you change it.
*   **Focus Assist / Do Not Disturb respect.** While Windows reports that it would suppress toasts (Focus Assist, presentation mode, a full-screen app) — or while you toggle **Focus mode** in the tray menu — only Tier 1 cues and meeting reminders get through. Everything else is held and flushed as a single quiet summary glow when focus ends. Detection polls `SHQueryUserNotificationState` via PowerShell every 45 s; it is best-effort and can be disabled in Settings.
*   **Tray as a status surface.** The tray tooltip says what Periphery is doing, and while cues are held in focus mode the tray icon carries a small accent-coloured badge dot. When a connector needs attention — expired token, API rate limit — the dot turns amber and the tooltip names the reason, and the Settings window shows the same issues in a banner that updates live. A rate limit is treated as transient (polling continues and the badge clears on the next good response); a dead token stops that poller until you re-enter credentials. Toggleable in Settings.
*   **Power & motion awareness.** On battery the overlay switches to shorter, cheaper animations and drops backdrop blur; with the OS "reduce motion" preference set, travelling cues (comet, text pill) become stationary fades.

## Attention-Aware Delivery

Beyond *how* a cue looks, Periphery decides *when* it deserves your eyes:

*   **Slack Tide.** While you are mid-keystroke-burst, non-urgent cues are held and released in your next natural micro-pause (~6 s without input), spaced out so pills never pile up. Nothing is held longer than 90 seconds, and a burst larger than the queue collapses into a single "+N more" cue. Idle detection uses the OS input-idle timer — no keylogging, just "seconds since last input". Toggleable in Settings.
*   **The Constellation.** Cues held by focus mode don't vanish into a counter: each leaves a dim, slowly twinkling star near the top-right corner of the screen, tinted with the cue's colour. A glance tells you *how much* happened while you were deep — without telling you *what*, which is exactly the information that breaks flow. When focus ends the stars fade out and a single summary glow reports the tally by source ("5 updates — gitlab 3, outlook 2"). Stars hold still on battery and under the OS reduce-motion preference.

*   **The end-of-focus digest.** When focus ends you get more than a tally, if you want it: an expandable card on the primary display lists each held update with its source and time. It is the overlay's only interactive surface — the window grants it real mouse events just while the pointer is over it — and it dismisses itself if ignored. Toggleable in Settings.
*   **"While you were away."** Unlocking after 30+ minutes greets you with the same digest for everything that arrived while the screen was locked, announced by one quiet glow. Toggleable in Settings.
*   **The agent beacon (`glow-agent`).** Coding-agent completions get their own cue variant: a violet glow breathing in the bottom-right corner that *does not expire* — it waits until you are demonstrably back at the keyboard, then replays its message once and fades. A subtle glow can be missed; the beacon cannot. See [ai-native/agents.md](ai-native/agents.md). Toggleable in Settings (off = agent cues render as a normal glow).
*   **The blocked beacon (`glow-blocked`).** The one cue that gets *more* insistent on its own. When a coding agent stalls waiting for your approval it burns wall-clock time every second, so a coral beacon in the bottom-left corner escalates with age — brighter, larger, faster — bounded at three levels, never a comet and never a sound. Critically, **being back at the keyboard does not clear it**: presence is not approval. It clears when the agent reports itself unblocked, when you dismiss it from the tray, or after a one-hour safety timeout. Pierces focus mode by default (it is your own delegated work asking); both behaviours are Settings toggles. See [ai-native/agents.md](ai-native/agents.md).
*   **Teams presence sync.** Opt-in: Periphery polls Microsoft Graph `/me/presence`, and being in a call, presenting, or on Do Not Disturb (including Teams "Focusing") holds ambient cues exactly like Focus Assist. Fails open — an expired token can never leave cues muted.

Delivery priority for every cue: focus hold (constellation) → slack tide (wait for a pause) → immediate. Tier 1 cues and meeting reminders always go straight through; agent beacons skip the tide because persistence makes pause-timing moot.

## The Attention Hierarchy (Visual Cues)

Periphery uses an Attention Hierarchy to map the urgency of an event to a visual cue:
*   **Tier 1 (High Urgency - Break Flow):** *The Comet or Fast Pulse.* Used for direct manager DMs or Sev-1 production incidents.
*   **Tier 2 (Awareness - Context Shift):** *Subtle Edge Glow.* Used for CI/CD pipeline failures or upcoming meetings.
*   **Tier 3 (Ambient - Background State):** *Slow Bottom Glow.* Used for gentle reminders like Pomodoro breaks or CC'd emails.

## First Cue in 60 Seconds

On first launch Periphery opens a small setup wizard: fire a test comet, then
point it at a project folder. It detects a git repository, `package.json`, and
Docker, and writes the [webhook recipes](ai-native/webhooks.md) for you — a
`post-commit` hook and `notify:success` / `notify:fail` npm scripts — never
overwriting anything that already exists (Docker gets a copyable recipe).
Reopen it any time from the tray → **Setup wizard**.

## Installing

```bash
npm run dist        # one-click NSIS installer (delta-update capable)
npm run dist:msix   # MSIX/appx package, for a future Store submission
```

The installed build can start at login and keep itself updated: updates
download in the background, announce themselves as a single quiet glow, and
install when you quit — never a popup. Both behaviours are Settings toggles
(`Application` section) and are inert in dev runs. The build is unsigned until
a certificate is configured; the decision and trade-offs are recorded in
[ADR 3](ai-native/ADR.md).

## Running the PoC

```bash
# Install dependencies
npm install

# Start the application
npm start

# Run the test suite and the linter
npm test
npm run lint
```

Both also run in CI (`.github/workflows/ci.yml`) on a Windows runner.

*Note: The application is designed to be invisible until a cue is triggered.* Reach Settings from the Periphery tray icon — on Windows it may start in the tray overflow menu (the `^` chevron).

To test the local webhook engine, run this in your terminal:
```powershell
Invoke-RestMethod -Uri http://127.0.0.1:49123/notify -Method POST -Body '{"cue":"glow-pulse", "color":"rgba(0, 150, 255, 0.6)", "msg":"Hello World"}' -ContentType 'application/json'
```

`GET /health` returns the cue and icon names the running build accepts.

## The Landing Page

[`docs/`](docs/) holds the static landing page (served by GitHub Pages) that presents Periphery's tenets and demonstrates the cues live in the browser — the page itself fires a comet, edge glows, and bottom glows, and runs looping Slack Tide / Constellation demos. Open `docs/index.html` directly; there is no build step. It honors `prefers-reduced-motion` the same way the app does. (Unlike the app overlay, the site does load webfonts and [icons8](https://icons8.com) icons from CDNs.)

## Integrating Your Tools
To learn how to integrate your existing local tools (Git, npm, CI/CD) using the Local Webhook, please read the [Webhook Integration Guide](ai-native/webhooks.md).

## Setting Up Your Accounts

Step-by-step setup for Outlook.com (personal Microsoft account) and a GitHub
repository — including the token gotchas — is in
[ai-native/getting-started.md](ai-native/getting-started.md).

## Where Periphery Goes Next

Proposed vNext directions — new delivery channels, connectors, and friction removal — are collected in [ai-native/vnext.md](ai-native/vnext.md).

A deeper analysis of where ambient notification is uniquely valuable across the
Developer, Product Manager, and Executive loops — including the four missing
primitives that unlock most of it — is in
[ai-native/opportunities.md](ai-native/opportunities.md).

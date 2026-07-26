# <img src="assets/icon.svg" width="28" alt="" align="top"> Periphery

**Periphery** (formerly FlowState) is a local-first, unobtrusive notification system designed specifically for deep-work professionals and enterprise developers.

Modern chat apps and notification centers are designed to steal your attention. Periphery is designed to protect it. Instead of jarring popups and sounds, it uses ambient, cinematic visual cues (like edge glows and shooting stars) drawn directly over your screen on a transparent canvas. You only notice what matters, exactly when it matters, without losing your train of thought.

## Core Philosophy: Privacy & Security First

Periphery was built from the ground up for strict enterprise environments where data exfiltration and cloud dependencies are unacceptable.

*   **No Cloud Backend:** There is no central server processing events, and no telemetry. The only outbound requests Periphery makes are the ones you configure: directly to GitLab and Microsoft Graph, from your machine. All UI assets are bundled locally, so the overlay never loads anything from the network.
*   **Encrypted Secret Storage:** Personal Access Tokens and OAuth tokens are encrypted with your OS credential store via Electron's [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) (DPAPI on Windows, Keychain on macOS, kwallet/libsecret on Linux). The ciphertext is written to `periphery-secrets.json` in the app's user-data directory. Where the OS offers no encryption backend — some Linux desktops — Periphery logs a warning and stores the value in plaintext; the Settings window always shows whether a token is stored and lets you remove it.
*   **Loopback-Only Webhook:** The local HTTP receiver binds to `127.0.0.1` and is unreachable from the network. See [docs/webhooks.md](docs/webhooks.md) for the full threat model.
*   **No Third-Party Brokers:** By running integrations locally, Periphery eliminates the need for 3rd-party automation brokers like Zapier or Make.com, which are often blocked by corporate firewalls.

Renderer processes run sandboxed with context isolation and a restrictive CSP; they reach the main process only through the narrow bridges in `preload.js` / `preload-settings.js`, and no bridge can read a stored secret back out.

## Architecture

Periphery is currently prototyped using **Electron**, which gives us transparent, click-through overlays — one per connected display — that never steal focus.

```
main.js                  Window/tray lifecycle, IPC, connector wiring
server/webhookServer.js  Loopback cue receiver (Express)
connectors/              Polling plugins; no Electron imports, unit-tested
utils/cuePayload.js      Allowlist validation for untrusted cue payloads
utils/win11.js           Accent parsing, attention tiers, DND state mapping
utils/focusAssist.js     Focus Assist / DND poller (SHQueryUserNotificationState)
utils/slackTide.js       Hold-until-pause delivery queue (Slack Tide)
utils/trayBadge.js       Accent badge-dot compositing for the tray icon
utils/stores/            Config + encrypted secret persistence
preload*.js              contextBridge APIs
renderer.js, styles.css  The overlay itself
```

### The Connector Engine
The system relies on a modular `ConnectorManager` that loads specific integrations.
1.  **Direct API Polling:** Connectors (like GitLab or Outlook) poll APIs directly from your machine. They receive their credentials through an injected secret store rather than importing Electron, which keeps them testable and portable.
2.  **The Local Webhook:** Periphery runs a lightweight HTTP server on `http://127.0.0.1:49123`. This lets you trigger notifications from native hooks in your existing developer tools (Git, npm, Docker) without a custom plugin for every tool.

## Windows 11 Integration

Periphery is tuned first for Windows 11, degrading gracefully elsewhere:

*   **Fluent settings window.** The Settings window uses the Mica backdrop with a hidden title bar (Window Controls Overlay), Segoe UI Variable typography, and Win11-style cards and toggles that follow the system light/dark theme.
*   **Accent-colour harmony.** Cues that arrive without an explicit `color` — and the comet's default tail, the test cue, and the settings controls — use your Windows accent colour, updating live when you change it.
*   **Focus Assist / Do Not Disturb respect.** While Windows reports that it would suppress toasts (Focus Assist, presentation mode, a full-screen app) — or while you toggle **Focus mode** in the tray menu — only Tier 1 cues and meeting reminders get through. Everything else is held and flushed as a single quiet summary glow when focus ends. Detection polls `SHQueryUserNotificationState` via PowerShell every 45 s; it is best-effort and can be disabled in Settings.
*   **Tray as a status surface.** The tray tooltip says what Periphery is doing, and while cues are held in focus mode the tray icon carries a small accent-coloured badge dot.
*   **Power & motion awareness.** On battery the overlay switches to shorter, cheaper animations and drops backdrop blur; with the OS "reduce motion" preference set, travelling cues (comet, text pill) become stationary fades.

## Attention-Aware Delivery

Beyond *how* a cue looks, Periphery decides *when* it deserves your eyes:

*   **Slack Tide.** While you are mid-keystroke-burst, non-urgent cues are held and released in your next natural micro-pause (~6 s without input), spaced out so pills never pile up. Nothing is held longer than 90 seconds, and a burst larger than the queue collapses into a single "+N more" cue. Idle detection uses the OS input-idle timer — no keylogging, just "seconds since last input". Toggleable in Settings.
*   **The Constellation.** Cues held by focus mode don't vanish into a counter: each leaves a dim, slowly twinkling star near the top-right corner of the screen, tinted with the cue's colour. A glance tells you *how much* happened while you were deep — without telling you *what*, which is exactly the information that breaks flow. When focus ends the stars fade out and a single summary glow reports the tally by source ("5 updates — gitlab 3, outlook 2"). Stars hold still on battery and under the OS reduce-motion preference.

Delivery priority for every cue: focus hold (constellation) → slack tide (wait for a pause) → immediate. Tier 1 cues and meeting reminders always go straight through.

## The Attention Hierarchy (Visual Cues)

Periphery uses an Attention Hierarchy to map the urgency of an event to a visual cue:
*   **Tier 1 (High Urgency - Break Flow):** *The Comet or Fast Pulse.* Used for direct manager DMs or Sev-1 production incidents.
*   **Tier 2 (Awareness - Context Shift):** *Subtle Edge Glow.* Used for CI/CD pipeline failures or upcoming meetings.
*   **Tier 3 (Ambient - Background State):** *Slow Bottom Glow.* Used for gentle reminders like Pomodoro breaks or CC'd emails.

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

## Integrating Your Tools
To learn how to integrate your existing local tools (Git, npm, CI/CD) using the Local Webhook, please read the [Webhook Integration Guide](docs/webhooks.md).

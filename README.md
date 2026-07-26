# FlowState

**FlowState** is a local-first, unobtrusive notification system designed specifically for deep-work professionals and enterprise developers.

Modern chat apps and notification centers are designed to steal your attention. FlowState is designed to protect it. Instead of jarring popups and sounds, it uses ambient, cinematic visual cues (like edge glows and shooting stars) drawn directly over your screen on a transparent canvas. You only notice what matters, exactly when it matters, without losing your train of thought.

## Core Philosophy: Privacy & Security First

FlowState was built from the ground up for strict enterprise environments where data exfiltration and cloud dependencies are unacceptable.

*   **No Cloud Backend:** There is no central server processing events, and no telemetry. The only outbound requests FlowState makes are the ones you configure: directly to GitLab and Microsoft Graph, from your machine. All UI assets are bundled locally, so the overlay never loads anything from the network.
*   **Encrypted Secret Storage:** Personal Access Tokens and OAuth tokens are encrypted with your OS credential store via Electron's [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) (DPAPI on Windows, Keychain on macOS, kwallet/libsecret on Linux). The ciphertext is written to `flowstate-secrets.json` in the app's user-data directory. Where the OS offers no encryption backend — some Linux desktops — FlowState logs a warning and stores the value in plaintext; the Settings window always shows whether a token is stored and lets you remove it.
*   **Loopback-Only Webhook:** The local HTTP receiver binds to `127.0.0.1` and is unreachable from the network. See [docs/webhooks.md](docs/webhooks.md) for the full threat model.
*   **No Third-Party Brokers:** By running integrations locally, FlowState eliminates the need for 3rd-party automation brokers like Zapier or Make.com, which are often blocked by corporate firewalls.

Renderer processes run sandboxed with context isolation and a restrictive CSP; they reach the main process only through the narrow bridges in `preload.js` / `preload-settings.js`, and no bridge can read a stored secret back out.

## Architecture

FlowState is currently prototyped using **Electron**, which gives us transparent, click-through overlays — one per connected display — that never steal focus.

```
main.js                  Window/tray lifecycle, IPC, connector wiring
server/webhookServer.js  Loopback cue receiver (Express)
connectors/              Polling plugins; no Electron imports, unit-tested
utils/cuePayload.js      Allowlist validation for untrusted cue payloads
utils/stores/            Config + encrypted secret persistence
preload*.js              contextBridge APIs
renderer.js, styles.css  The overlay itself
```

### The Connector Engine
The system relies on a modular `ConnectorManager` that loads specific integrations.
1.  **Direct API Polling:** Connectors (like GitLab or Outlook) poll APIs directly from your machine. They receive their credentials through an injected secret store rather than importing Electron, which keeps them testable and portable.
2.  **The Local Webhook:** FlowState runs a lightweight HTTP server on `http://127.0.0.1:49123`. This lets you trigger notifications from native hooks in your existing developer tools (Git, npm, Docker) without a custom plugin for every tool.

## The Attention Hierarchy (Visual Cues)

FlowState uses an Attention Hierarchy to map the urgency of an event to a visual cue:
*   **Tier 1 (High Urgency - Break Flow):** *The Comet or Fast Pulse.* Used for direct manager DMs or Sev-1 production incidents.
*   **Tier 2 (Awareness - Context Shift):** *Subtle Edge Glow.* Used for CI/CD pipeline failures or upcoming meetings.
*   **Tier 3 (Ambient - Background State):** *Slow Bottom Glow.* Used for gentle reminders like Pomodoro breaks or CC'd emails.

## Running the PoC

```bash
# Install dependencies
npm install

# Start the application
npm start

# Run the test suite
npm test
```

*Note: The application is designed to be invisible until a cue is triggered.* Reach Settings from the FlowState tray icon — on Windows it may start in the tray overflow menu (the `^` chevron).

To test the local webhook engine, run this in your terminal:
```powershell
Invoke-RestMethod -Uri http://127.0.0.1:49123/notify -Method POST -Body '{"cue":"glow-pulse", "color":"rgba(0, 150, 255, 0.6)", "msg":"Hello World"}' -ContentType 'application/json'
```

`GET /health` returns the cue and icon names the running build accepts.

## Integrating Your Tools
To learn how to integrate your existing local tools (Git, npm, CI/CD) using the Local Webhook, please read the [Webhook Integration Guide](docs/webhooks.md).

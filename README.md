# FlowState

**FlowState** is a local-first, unobtrusive notification system designed specifically for deep-work professionals and enterprise developers. 

Modern chat apps and notification centers are designed to steal your attention. FlowState is designed to protect it. Instead of jarring popups and sounds, it uses ambient, cinematic visual cues (like edge glows and shooting stars) drawn directly over your screen on a transparent canvas. You only notice what matters, exactly when it matters, without losing your train of thought.

## Core Philosophy: Privacy & Security First

FlowState was built from the ground up for strict enterprise environments where data exfiltration and cloud dependencies are unacceptable.

*   **100% Local Execution:** There is no cloud backend. FlowState does not phone home, nor does it send any of your data to external servers. The core engine runs entirely on your local machine.
*   **Cryptographic Secret Storage:** Any Personal Access Tokens (PATs) or OAuth tokens used by FlowState's connectors are encrypted using your operating system's native hardware-backed credential manager (e.g., Windows Credential Guard). Tokens are never stored in plaintext on disk.
*   **No Third-Party Brokers:** By running integrations locally, FlowState eliminates the need for 3rd-party automation brokers like Zapier or Make.com, which are often blocked by corporate firewalls. Your data never leaves your network.

## Architecture

FlowState is currently prototyped using **Electron**, allowing for a transparent, click-through overlay that spans your monitors without stealing focus.

### The Connector Engine
The system relies on a modular `ConnectorManager` that loads specific integrations.
1.  **Direct API Polling:** Connectors (like GitLab or Outlook) securely poll APIs directly from your machine.
2.  **The Local Webhook (Option 1):** FlowState runs a lightweight, local HTTP server (`http://localhost:49123`). This allows you to trigger notifications using native hooks in your existing developer tools (Git, npm, Docker) without needing a custom plugin for every single tool.

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
```

*Note: The application is designed to be invisible until a cue is triggered.*

To test the local webhook engine, you can run this command in your terminal:
```powershell
Invoke-RestMethod -Uri http://localhost:49123/notify -Method POST -Body '{"cue":"glow-pulse", "color":"rgba(0, 150, 255, 0.6)", "msg":"Hello World"}' -ContentType 'application/json'
```

## Integrating Your Tools
To learn how to integrate your existing local tools (Git, npm, CI/CD) using the Local Webhook, please read the [Webhook Integration Guide](docs/webhooks.md).

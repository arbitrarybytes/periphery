# Periphery: Unobtrusive Desktop Notification System
## Product Specification

> **Status (2026-07-26):** This is the product vision. Items marked ✅ are implemented in the current PoC; items marked 🔭 are planned but not yet built. Where the vision and the code differ (notably the tech stack), the divergence is recorded in [ADR.md](ADR.md).

### 1. Vision & Core Philosophy
Periphery is a desktop notification layer designed to keep professionals informed without breaking their deep work state (flow). Moving beyond standard OS toast notifications—which are often jarring, anxiety-inducing, and demand immediate attention—Periphery utilizes subtle, delightful, and ambient visual/audio cues. 

**Crucially, Periphery is an enterprise-ready, local-first application.** No user data, calendar events, or proprietary code ever leaves the local machine. It acts as a local broker between your tasks and your screen.

### 2. Core Architecture (Local-First Guarantee)
To satisfy strict enterprise security requirements:
*   ✅ **No Cloud Backend:** There is no central server processing events. 
*   ✅ **Direct Polling via PATs:** For cloud services (GitLab and GitHub), users provide Personal Access Tokens. The local app polls these APIs directly. Data flows strictly from the third-party service directly to the user's local machine. Tokens are encrypted with the OS credential store via Electron `safeStorage` and persisted as ciphertext in the app's user-data directory (not as individual OS Keychain entries — see README "Encrypted Secret Storage").
*   ✅ **Local Webhook Receiver:** The app runs a lightweight, loopback-only HTTP server (`127.0.0.1:49123`) that local scripts and tools can send POST requests to. See [webhooks.md](webhooks.md).
*   🔭 **Tech Stack:** The production target is Tauri (Rust backend) for a minimal memory footprint. The current PoC is deliberately built on Electron; see [ADR 1](ADR.md) for the decision and the portability constraints it imposes (connectors and validation stay Electron-free).

### 3. Notification Mechanisms (The "Cues")
Moving beyond the original "flying bird" experiment, the system offers a diverse marketplace of unobtrusive cues that grasp focus gently:

*   ✅ **The Edge Glow:** A subtle, breathing, colored gradient that appears along the very edge of the monitor (e.g., Green for a successful pipeline, pulsing Red for a failure). *Shipped as three variants: `glow` (full-edge breathe), `glow-bottom` (bottom gradient), and `glow-pulse` (repeating pulse).*
*   ✅ **The Comet:** A tiny, swift streak of light across the top of the monitor.
*   ✅ **Kinetic Typography:** The event name (e.g., "Build #42 Passed") floats gracefully upwards from the bottom of the screen. *Shipped as the glassmorphism message pill that accompanies any cue when Verbose Mode is on.*
*   🔭 **Ambient Audio:** Non-intrusive soundscapes. A soft wind chime, a distant train whistle, or a single water drop.
*   🔭 **Screen Pets/Companions:** A sleeping pixel-art cat sitting on top of the active window that wakes up and stretches when a task is done.
*   🔭 **Weather Overlays:** A brief, 3-second gentle rain overlay on the screen, or a ray of sunlight passing through.
*   ✅ **The Constellation (notification residue):** Cues held during focus mode leave dim twinkling stars in a screen corner — a glanceable "how much happened" without revealing what. *(Added post-spec; see README "Attention-Aware Delivery".)*
*   ✅ **Slack Tide (pause-timed delivery):** Non-urgent cues wait for a natural typing pause before appearing, capped at 90 s. *(Added post-spec; not a visual cue but a delivery discipline all cues share.)*
*   ✅ **The Agent Beacon (`glow-agent`):** A persistent corner glow for coding-agent completions that stays until the user is back at the keyboard, then replays its message once. *(Added post-spec; see [agents.md](agents.md).)*
*   ✅ **Digests:** An expandable end-of-focus digest panel, and a "while you were away" summary after 30+ minute locks. *(Added post-spec; see README "Attention-Aware Delivery".)*

### 4. Connectors & Individual Productivity (The Triggers)
Focusing on developer and individual productivity, the app will ship with the following core connectors:

*   ✅ **Local Hook (webhook form):** Any local tool can POST to `127.0.0.1:49123/notify` (see [webhooks.md](webhooks.md)). ✅ The `periphery` CLI (`cli/periphery.js`: `notify` / `done` / `health`) and a local MCP server for coding agents (`mcp/server.js`) ship as sugar over this endpoint — see [agents.md](agents.md).
*   ✅ **GitLab:** Polls pipelines on a configured project (success/failure, naming the failing job) and the user's pending todos (review requests, assignments, mentions, approvals).
*   ✅ **GitHub:** Polls Actions workflow runs on a configured repository plus the user's notifications (review requests, mentions, assignments).
*   ✅ **Teams presence (Microsoft Graph):** Opt-in; in a call / presenting / DND (including "Focusing") holds ambient cues like focus mode. Fails open on auth errors.
*   ✅ **Outlook (Microsoft Graph):** Polls unread inbox mail — distinguishing direct 'To' from low-priority 'CC' — and fires a reminder shortly before calendar events start. *(Not in the original spec; added during Phase 2.)*
*   ✅ **Time & Pomodoro:** Built-in local break reminder timer, configurable 1–240 minutes.
*   🔭 **Local File Watcher:** Triggers when a specific large file is created or modified (useful for long video renders or database exports).
*   🔭 **Docker Container Status:** Listens to the local Docker socket and notifies when a specific container crashes or finishes a run.

### 5. Settings & Connectors Panel (The UI)
The application window is a control center strictly for configuring rules, rather than a place to spend time.

> *Current state: a single tray-launched settings form covering appearance (verbose mode, pulse repeats, test cue), the break reminder, and GitLab/Outlook credentials with stored-token status and removal. The richer surfaces below are* 🔭 *planned.*

*   **The Canvas (Rules Engine):** A simple IF-THEN interface. 
    *   *IF [Connector: GitHub Pipeline Fails on Repo X]* 
    *   *THEN [Cue: Pulsing Red Edge Glow + Thunder Audio]*
*   **Connector Store:** A local catalog where users can enable plugins for different services (Jira, Slack local API, GitLab, Docker).
*   **Cue Wardrobe:** A gallery to preview and select different notification mechanisms. Users can fine-tune opacity, duration, and speed to ensure it fits their personal tolerance for distraction.
*   **Security Vault:** A dedicated tab for managing Personal Access Tokens, clearly explaining that keys are stored in the local OS Keychain and never transmitted to a third party.

### 6. Next Steps & Development Phases
1.  ✅ **Phase 1 (Proof of Concept):** Build the local hook (webhook receiver) and the core visual cues (Edge Glow variants and The Comet) to validate the unobtrusive nature of the notifications.
2.  ✅ **Phase 2 (Connectors):** Implement the local polling engine using PATs — delivered for GitLab, GitHub, and Outlook, on a connector abstraction that never imports Electron.
3.  ◐ **Phase 3 (Settings UI):** Build the GUI for configuring connections and cues — basic settings window shipped; the rules engine, connector store, and cue wardrobe remain 🔭.

Directions beyond Phase 3 are collected in [vnext.md](vnext.md).

### 7. Associated Artifacts
*   ✅ **Landing page** (`website/`): a static, dependency-free site (plain HTML/CSS/JS, no build step) that presents the core tenets and *demonstrates* the cues in-browser — the page renders a live comet, edge glow, and bottom glow, plus looping Slack Tide and Constellation demos. It honors `prefers-reduced-motion` with the same stationary-fade degradation the app uses. Note: the site loads webfonts and icons8 icons from CDNs; the "no network assets" guarantee applies to the app overlay, not the marketing site.
*   ✅ **CI** (`.github/workflows/ci.yml`): runs `npm test` and `npm run lint` on a Windows runner.

# FlowState: Unobtrusive Desktop Notification System
## Product Specification

### 1. Vision & Core Philosophy
FlowState (working title) is a desktop notification layer designed to keep professionals informed without breaking their deep work state (flow). Moving beyond standard OS toast notifications—which are often jarring, anxiety-inducing, and demand immediate attention—FlowState utilizes subtle, delightful, and ambient visual/audio cues. 

**Crucially, FlowState is an enterprise-ready, local-first application.** No user data, calendar events, or proprietary code ever leaves the local machine. It acts as a local broker between your tasks and your screen.

### 2. Core Architecture (Local-First Guarantee)
To satisfy strict enterprise security requirements:
*   **No Cloud Backend:** There is no central server processing events. 
*   **Direct Polling via PATs:** For cloud services (GitHub, GitLab), users provide Personal Access Tokens (stored securely in the OS Keychain). The local app polls these APIs directly. Data flows strictly from the third-party service directly to the user's local machine.
*   **Local Webhook Receiver:** The app runs a lightweight local HTTP server (e.g., `localhost:49123`) that local scripts, Docker containers, or internal network tools can send POST requests to.
*   **Tech Stack:** Built on Tauri (Rust backend + React/Vue frontend) for a minimal memory footprint and native OS capabilities, avoiding the bloat of traditional Electron apps.

### 3. Notification Mechanisms (The "Cues")
Moving beyond the original "flying bird" experiment, the system offers a diverse marketplace of unobtrusive cues that grasp focus gently:

*   **The Edge Glow:** A subtle, breathing, colored gradient that appears along the very edge of the monitor (e.g., Green for a successful pipeline, pulsing Red for a failure).
*   **Ambient Audio:** Non-intrusive soundscapes. A soft wind chime, a distant train whistle, or a single water drop.
*   **Screen Pets/Companions:** A sleeping pixel-art cat sitting on top of the active window that wakes up and stretches when a task is done.
*   **Weather Overlays:** A brief, 3-second gentle rain overlay on the screen, or a ray of sunlight passing through.
*   **The Comet:** A tiny, swift streak of light across the top of the monitor.
*   **Kinetic Typography:** The event name (e.g., "Build #42 Passed") floats gracefully upwards from the bottom of the screen at 10% opacity.

### 4. Connectors & Individual Productivity (The Triggers)
Focusing on developer and individual productivity, the app will ship with the following core connectors:

*   **Local CLI Hook:** A simple command-line tool installed globally (`flowstate`). Developers can pipe their commands: 
    `npm run build && flowstate notify --cue=glow --color=green --msg="Build Complete"`
*   **GitHub / GitLab Actions:** Polls for status changes on specific repositories or PRs. (e.g., "When my PR checks pass, show a Green Edge Glow").
*   **Local File Watcher:** Triggers when a specific large file is created or modified (useful for long video renders or database exports).
*   **Time & Pomodoro:** Built-in local timers. (e.g., "After 45 minutes of focus, send a blue comet across the screen to remind me to stretch").
*   **Docker Container Status:** Listens to the local Docker socket and notifies when a specific container crashes or finishes a run.

### 5. Settings & Connectors Panel (The UI)
The application window is a control center strictly for configuring rules, rather than a place to spend time.

*   **The Canvas (Rules Engine):** A simple IF-THEN interface. 
    *   *IF [Connector: GitHub Pipeline Fails on Repo X]* 
    *   *THEN [Cue: Pulsing Red Edge Glow + Thunder Audio]*
*   **Connector Store:** A local catalog where users can enable plugins for different services (Jira, Slack local API, GitLab, Docker).
*   **Cue Wardrobe:** A gallery to preview and select different notification mechanisms. Users can fine-tune opacity, duration, and speed to ensure it fits their personal tolerance for distraction.
*   **Security Vault:** A dedicated tab for managing Personal Access Tokens, clearly explaining that keys are stored in the local OS Keychain and never transmitted to a third party.

### 6. Next Steps & Development Phases
1.  **Phase 1 (Proof of Concept):** Build the local CLI hook and two visual cues (Edge Glow and The Comet) to validate the unobtrusive nature of the notifications.
2.  **Phase 2 (Connectors):** Implement the local polling engine for GitHub and GitLab using PATs.
3.  **Phase 3 (Settings UI):** Build the rules engine and GUI for configuring connections and cues.

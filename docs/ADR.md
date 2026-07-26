# Architecture Decision Records (ADRs)

## ADR 1: Retaining Electron for Phase 2 Prototyping

**Date:** 2026-07-26
**Status:** Accepted

### Context
The final product vision for FlowState specifies using Tauri (Rust backend) to guarantee a minimal memory footprint and leverage native OS capabilities without the bloat of a bundled Chromium browser. However, the initial visual Proof of Concept (Phase 1) was rapidly prototyped using Electron, as it provides out-of-the-box support for transparent, click-through desktop overlays using web technologies.

Moving into Phase 2 (Building the Connectors and Local Polling Engine), we evaluated whether to port the PoC to Tauri immediately or continue using Electron.

### Decision
We will **proceed with Option 1: Retain Electron for Phase 2**.
We will build the polling engine and connector abstractions using Node.js inside our current Electron `main.js` process.

### Consequences
*   **Positive:** Maintaining momentum. We can rapidly prototype the GitHub/GitLab and other connectors using standard JavaScript/Node.js libraries (like `axios` or native `fetch`) without the overhead of setting up the Rust toolchain, learning Tauri's IPC, and rewriting the backend.
*   **Negative:** Technical debt. The connector logic written in Node.js will eventually need to be rewritten in Rust when we make the final transition to Tauri for production distribution.
*   **Mitigation:** We will design the connector logic in a modular way (separating the polling/fetching logic from the Electron IPC layer) to make the eventual port to Rust as straightforward as possible.

### Follow-up (implementation note)
The mitigation is now enforced rather than aspirational: nothing under `connectors/`, `utils/cuePayload.js`, or `utils/stores/` imports Electron. Connectors receive their secret store through `config`, and the host supplies a `sendCue` callback, so the whole polling layer runs — and is unit-tested — under plain Node. What has to be rewritten for Tauri is `main.js`, the preload bridges, and the renderer.

## ADR 2: Detecting Focus Assist by Polling `SHQueryUserNotificationState`

**Date:** 2026-07-26
**Status:** Accepted

### Context
The Windows 11 integration holds ambient cues while the user does not want to be disturbed. Windows exposes no supported push notification for this state, so FlowState has to ask. The candidates were:

1. **A native Node module** (N-API) calling `SHQueryUserNotificationState`. Accurate and event-free, but adds a compile step, per-Electron-ABI rebuilds, and a Rust rewrite on the Tauri port.
2. **Reading the Focus Assist registry blobs** (`...\CloudStore\...windows.data.notifications.quiethourssettings...`). Undocumented, binary, broken across Windows builds — and it reports the *setting*, not the effective state (it misses presentation mode and full-screen apps).
3. **Spawning PowerShell periodically** to P/Invoke `SHQueryUserNotificationState` and print the integer.

### Decision
**Option 3: poll via PowerShell**, every 45 seconds, treating every state except `QUNS_ACCEPTS_NOTIFICATIONS (5)` as "hold cues". The probe is best-effort: any spawn/parse failure keeps the last known state, and the feature can be disabled in Settings.

### Consequences
*   **Positive:** No native dependencies and no ABI coupling; the query targets the same supported shell API a native module would use, so it reflects the *effective* state (Focus Assist, presentation mode, full-screen apps). The state mapping itself is pure JS (`utils/win11.js`) and unit-tested.
*   **Negative:** Up to 45 seconds of latency on focus transitions, and a short-lived `powershell.exe` process per probe. A cue can slip through in the window between the user entering focus and the next probe.
*   **Accepted because:** cue delivery degrades gracefully (a missed hold means one ambient glow, not a data loss), and the manual tray "Focus mode" toggle covers users who need the hold to be immediate.
*   **Tauri note:** the Rust port calls `SHQueryUserNotificationState` directly and deletes the PowerShell bridge; `utils/win11.js` logic (tiering, deferral, state mapping) ports as-is.


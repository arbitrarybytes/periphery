# Architecture Decision Records (ADRs)

> Naming note: ADRs are historical records and are not rewritten. "FlowState" below is the project's pre-rename name; it refers to what is now **Periphery**.

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


## ADR 3: NSIS via electron-builder for the Installer and Delta Updates

**Date:** 2026-07-26
**Status:** Accepted

### Context
Clone-and-`npm start` is the biggest adoption tax. The candidates for a Windows installer with auto-update were: **MSIX/appx** (modern packaging, Store-managed updates, but `electron-updater` cannot self-update an appx outside the Store and per-machine MSIX signing is unforgiving), **Squirrel.Windows** (legacy, effectively unmaintained), and **NSIS via electron-builder** (one-click install, and `electron-updater` differential downloads give the "delta updates" we want from a plain HTTPS file server).

### Decision
**NSIS via electron-builder** with `electron-updater`: `differentialPackage: true`, background download, quiet install-on-quit. `npm run dist` builds it; `npm run dist:msix` remains available for a future Store submission. The publish feed is a generic HTTPS URL (`build.publish.url` in package.json — a placeholder until a real feed exists).

### Consequences
*   **Positive:** delta updates with no update server (any static host works); updates are announced as a single ambient cue and install on quit — no dialogs, matching the product's ethos; start-at-login rides on `app.setLoginItemSettings`, guarded to packaged builds.
*   **Negative:** the build is unsigned until a code-signing certificate (or Azure Trusted Signing) is configured — SmartScreen will warn. Signing config (`win.certificateSubjectName` / `signtoolOptions`) is a release-time addition, not a code change.
*   **Toggles:** auto-update and start-at-login are user-facing settings (`autoUpdateEnabled`, `startAtLogin`); dev runs (`!app.isPackaged`) never register login items or check feeds.

## ADR 4: Migrating from Electron to Tauri

**Date:** 2026-07-26
**Status:** Accepted — **supersedes the "retain Electron" half of [ADR 1](#adr-1-retaining-electron-for-phase-2-prototyping)**

### Context
ADR 1 kept Electron for Phase 2 on the explicit understanding that it was
technical debt, with one mitigation enforced throughout: nothing under
`connectors/`, `utils/cuePayload.js`, or `utils/stores/` was allowed to import
Electron. That discipline held for the whole PoC, so the port is a rewrite of
the *shell*, not an archaeology project.

Three things now make the move worth paying for:

1. **Footprint.** Every Electron instance bundles Chromium. Tauri uses the
   WebView2 runtime already present on Windows 11 (confirmed on the dev
   machine: 150.0.4078.99), so the installed app drops from roughly 150 MB to
   single-digit MB, and the resident overlay processes get correspondingly
   cheaper — which matters for a tool whose entire pitch is that you forget it
   is running.
2. **Native OS access.** The Focus Assist probe in [ADR 2](#adr-2-detecting-focus-assist-by-polling-shqueryusernotificationstate)
   was a long-lived `powershell.exe` P/Invoking `SHQueryUserNotificationState`,
   accepted only because Electron could not call it without a native module.
   In Rust it is one direct `shell32` call. That deletes a child process, an
   `Add-Type` compile per spawn, the respawn-on-death logic, and the 45-second
   detection latency.
3. **The security story.** "No cloud, no telemetry, nothing leaves your
   machine" is the product's moat. A Rust binary with an explicit, auditable
   dependency set is a materially easier claim to defend than a bundled
   Chromium and an `npm` tree.

### Decision
Port to **Tauri 2** (2.11.5 at time of writing), rewriting the backend in Rust:

*   **Ported to Rust, with their tests:** cue validation, attention tiers,
    blocked-agent escalation, slack tide, digests, agent-beacon
    acknowledgment, focus-state mapping, config + secret stores, the loopback
    webhook receiver, and the connectors.
*   **Kept nearly as-is:** the overlay, settings, and onboarding frontends.
    They are vanilla HTML/CSS/JS with no framework, so they move across intact;
    only the Electron preload bridges become Tauri `invoke`/`emit` calls.
*   **Deleted:** `main.js`, both preloads, the PowerShell focus bridge, and the
    Electron/electron-builder dependency tree.

### Consequences
*   **Positive:** far smaller install and memory footprint; native Win32 calls
    (focus state, DPAPI) without subprocesses or native Node modules; a
    compiled, type-checked core with the same test coverage the JS had; the
    updater and autostart plugins replace electron-updater/electron-builder.
*   **Negative:** the Rust toolchain becomes a build prerequisite (rustup plus
    the MSVC C++ build tools — not a small first-time install), and the JS test
    suite is replaced rather than reused, so the port has to re-prove behaviour
    the JS tests already guaranteed. Porting the tests alongside the logic,
    rather than after it, is how that risk is managed.
*   **Neutral:** WebView2 is an Edge-versioned runtime rather than a pinned
    Chromium, so overlay rendering now depends on the user's WebView2 version.
    The cues are simple CSS animations, so the exposure is small — but it is
    real, and worth remembering if an effect ever misbehaves on one machine.
*   **Migration order:** pure logic first (highest value, zero platform risk),
    then stores and the webhook, then the shell, then the connectors. The
    Electron build stays runnable until the Tauri shell is proven, so there is
    never a window with no working app.

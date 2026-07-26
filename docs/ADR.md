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


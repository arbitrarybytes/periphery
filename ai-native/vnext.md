# Periphery vNext — Proposed Directions

> Status (2026-07-26): proposal, not commitment. Complements [spec.md](spec.md) §6; items already 🔭 in the spec are referenced, not restated. Ordered within each theme by expected value ÷ effort.

## 1. Quieter still — better unobtrusive delivery

*   **Off-screen light: Windows Dynamic Lighting channel.** Route Tier 2/3 cues to keyboard/mouse RGB via the Windows 11 [LampArray API](https://learn.microsoft.com/en-us/uwp/api/windows.devices.lights.lamparray) (Dynamic Lighting, HID LampArray standard, Win 11 23H2+). A pipeline failure becomes a slow amber breathe on the keyboard edge — zero pixels on screen, visible even when the monitor shows a full-screen app. Degrades to the existing on-screen cue when no LampArray device is present.
*   **Slack Tide v2: defer-to-breakpoint.** Interruption research (Iqbal & Bailey's [OASIS](https://www.interruptions.net/literature/Iqbal-TOCHI10.pdf); [CHI 2008](https://interruptions.net/literature/Iqbal-CHI08.pdf)) shows deferring notifications to *task breakpoints* — the coarser the better — measurably cuts resumption lag and frustration versus immediate delivery. Today's tide only watches input idle. Add coarse-breakpoint signals that need no content inspection: foreground-app switch, window minimize/close, a build or test run finishing (we already see these via the webhook), and lock/unlock. Release the queue at the coarsest breakpoint available inside the 90 s cap; keep the "no keylogging" stance (event types only).
*   **Active-monitor avoidance.** On multi-display setups, prefer rendering Tier 2/3 cues on the display that does *not* contain the focused window; Tier 1 stays on the active one.
*   ✅ *Shipped.* **End-of-focus digest, glanceable then expandable.** The constellation's summary glow gains an optional click-through: a local, ephemeral list of what was held (source, tier, message), newest first, self-dismissing. Also a "while you were away" digest on unlock after >30 min.
*   **Cue Wardrobe (spec §5) + accessibility palettes.** Ship the preview gallery with per-source/per-tier duration & opacity, a monochrome mode, and colourblind-safe presets so colour is never the only signal (pair colour with position/motion class).

## 2. More connectors — still local-first

*   ✅ *Shipped.* **GitHub**: Actions runs, review requests, mentions via REST + PAT; same shape as the GitLab connector.
*   **ntfy / Gotify bridge.** Subscribe to self-hosted [ntfy](https://github.com/Aetherinox/ntfy-desktop) or [Gotify](https://blog.vezpi.com/en/post/notification-system-gotify-vs-ntfy/) topics over WebSocket/SSE and render them as ambient cues. One connector inherits the entire Apprise/UnifiedPush integration ecosystem — including phone→desktop — while staying self-hosted and firewall-friendly.
*   ✅ *Shipped (read side).* **Teams presence sync (Microsoft Graph).** Read `Presence.Read` to treat *InACall / InAMeeting / DoNotDisturb* as focus-hold (note: Teams "Focusing" [surfaces as DoNotDisturb](https://learn.microsoft.com/en-us/answers/questions/1189978/presence-api-and-teams-focusing-status), which is exactly what we want). Still 🔭: two-way — entering Periphery focus mode sets Teams DND so humans stop pinging too.
*   **Calendar-driven focus.** Auto-enter focus mode during events the user tags (e.g. title contains "Focus") — the Outlook connector already polls the calendar; this is a rule, not a new connector.
*   **Docker events + file watcher** (spec §4 🔭): local Docker socket (`/events`) for container exit/health; `fs.watch` for render/export completion.
*   **Jira / Azure DevOps.** Direct REST polling with PAT: assigned-to-me transitions, PR votes, sprint start.
*   ✅ *Shipped.* **`periphery` CLI + MCP server.** The spec'd CLI sugar (`long_build && periphery done`), plus a local MCP server exposing `task_complete`/`notify` so coding agents can signal long-task completion ambiently instead of via terminal bells — with the persistent `glow-agent` beacon so completions survive being missed. See [agents.md](agents.md).

## 3. Less hassle — friction removal

*   **Onboarding wizard: "first cue in 60 seconds."** Detect git repos, Docker, and package.json scripts; offer one-click generated hooks (the webhooks.md recipes, written for you).
*   **Installer + autostart + auto-update.** Signed MSIX (or Squirrel) with start-at-login and delta updates; today's clone-and-`npm start` is the single biggest adoption tax.
*   **OAuth device-code flow** for Graph and GitLab instead of hand-pasted PATs: fewer steps, scoped tokens, automatic refresh — secrets still land in `safeStorage` ciphertext.
*   **Optional webhook bearer token.** Keep loopback-only, add an opt-in shared token to narrow the "any local process" surface (docs/webhooks.md threat model), plus named channels with per-channel default colour/icon.
*   **Connector health in the tray.** Surface failing pollers (auth expired, rate-limited) as a tray badge + settings banner instead of silent log lines.
*   **Tauri port** ([ADR 1](ADR.md)): production footprint, and the Rust backend calls `SHQueryUserNotificationState` directly — deleting the PowerShell polling bridge and its 45 s latency ([ADR 2](ADR.md)).

## Suggested vNext slice (one release)

1. GitHub connector · 2. Slack Tide defer-to-breakpoint · 3. Dynamic Lighting channel · 4. ntfy bridge · 5. Onboarding wizard + CLI.

That slice touches all three themes, needs no cloud service, and every item is testable under plain Node except the LampArray bridge (which isolates behind the same host-callback seam the connectors use).

# Versioning & release strategy

Periphery is **one product with two shells**. Until the Tauri shell reaches
parity, both are maintained and both are shippable. This document says how they
are numbered, how a user tells them apart, and what has to be true before one of
them goes away.

Status: **v1.0.0-beta.1** — first beta. No longer a proof of concept.

---

## 1. One product version, two editions

There is a single product version. It is not per-shell, because a user does not
care which runtime drew the glow — they care which behaviours exist.

| Edition | Runtime | Version source | Channel | Status |
| --- | --- | --- | --- | --- |
| **Node edition** | Electron + Node | `package.json` → `version` | `stable` | Feature-complete. This is what to install. |
| **Rust edition** | Tauri + Rust | `src-tauri/Cargo.toml` → `version` | `preview` | Logic core, stores, and webhook ported; shell in progress. |

Both files carry the **same** product version, and a test enforces it — a
mismatch would mean `/health` lies about what the user is running.

`src-tauri/tauri.conf.json` deliberately has **no** `version` key. Tauri falls
back to the Cargo package version, so each edition has exactly one place its
number is written.

### Why not version them separately?

Because the thing users and integrations depend on is neither shell: it is the
**cue contract** — the webhook vocabulary, the CLI, and the MCP tools. Two
version lines would imply two contracts. There is one.

---

## 2. Semantics

Standard SemVer, applied to the contract rather than to the code:

* **Major** — a breaking change to the *public contract*: removing or renaming a
  cue, an icon name, a webhook route, a CLI command, or an MCP tool. Also: a
  config key whose meaning changes such that an existing store is misread.
* **Minor** — a new cue, connector, tool, or setting. Existing hooks keep working.
* **Patch** — fixes and timing tuning that leave the contract identical.
* **Prerelease** — `-beta.N`, incrementing per beta release.

Internals — a module moving from JS to Rust, a poller changing its interval —
are **not** version-visible on their own. Migrating a subsystem to Tauri does
not bump anything by itself.

### What is public, and therefore frozen within 1.x

* Cue names and the state-cue set (`ai-native/spec.md`)
* Icon names
* `POST /notify`, `POST /resolve`, `GET /health` and their request shapes
* `127.0.0.1:49123`
* `periphery` CLI commands and flags
* MCP tool names and their input schemas

Everything else — internal modules, storage layout, poll intervals, the Rust
crate's API — is free to change.

---

## 3. Telling the editions apart at runtime

`GET /health` reports both fields:

```json
{ "success": true, "version": "1.0.0-beta.1", "edition": "node", "cues": ["..."] }
```

`edition` is `"node"` or `"tauri"`. A hook, agent, or bug report can then say
*which* shell answered — which matters precisely because they behave alike.

---

## 4. Co-existence rule

**Both editions may be installed. Only one may run at a time.**

They share `127.0.0.1:49123`, and that is deliberate. Every git hook, npm
script, Docker snippet, CI job, and agent config a user has written targets that
port. If the Rust edition moved to 49124, switching editions would silently
break every integration the user set up — the exact adoption tax the onboarding
wizard exists to remove.

So the port stays fixed, and the second instance to start **reports the clash**
in its tray tooltip and exits cleanly rather than dying with a stack trace. The
loopback receiver binding is separated from serving in `src-tauri/src/webhook.rs`
for this reason: a port clash is an `Err` the shell can present, not a panic.

Installers use distinct identifiers so they do not overwrite each other:

| Edition | App ID | Install name |
| --- | --- | --- |
| Node | `com.periphery.app` | Periphery |
| Rust | `com.periphery.preview` | Periphery Preview |

---

## 5. Promotion: when the Rust edition becomes the default

The Tauri shell ships as `preview` until **all** of the following hold. This is
a checklist, not a judgement call, so the decision cannot drift.

- [x] Logic core ported with tests at parity (cue validation, tiers, slack tide, blocked escalation, digest, agent beacon)
- [x] Config + secret stores ported, with secrets encrypted at rest via DPAPI
- [x] Webhook receiver ported with the loopback threat model intact and directly tested
- [x] Overlay windows: transparent, click-through, always-on-top, one per display
- [x] Delivery pipeline: focus hold → constellation → slack tide → broadcast
- [ ] All cue variants verified on a **multi-monitor** setup (single display verified end to end: comet, edge glow, message pills, blocked beacon, constellation stars, `/resolve`)
- [x] Tray icon, menu, and tooltip; badge priority implemented and unit-tested
- [ ] Tray health badge fed by real connector state (no connectors yet, so the amber dot cannot fire)
- [ ] Settings and onboarding windows functional (the Settings window opens; its frontend still speaks the Electron preload API)
- [ ] All four connectors polling, with health reporting
- [x] Focus Assist and idle detection wired to native APIs (`SHQueryUserNotificationState`, `GetLastInputInfo`)
- [ ] Lock/unlock detection for the "while you were away" summary
- [ ] Signed installer, autostart, and delta auto-update working — the updater plugin is deliberately unregistered until a signing key exists, because it panics on init without one
- [ ] A week of daily use by the maintainer with no fallback to the Node edition

When the list is complete, the Rust edition becomes `stable` at the next minor
release, and the Node edition moves to **maintenance**: security and correctness
fixes only, no new features.

The Node edition is removed in **2.0.0** — a major bump, because dropping a
shell changes the install story even though the cue contract is untouched.

---

## 6. Release checklist

1. `npm test` and `npm run lint` (Node edition).
2. `cargo test` and `cargo clippy --all-targets` (Rust edition).
3. Bump the version in **both** `package.json` and `src-tauri/Cargo.toml`.
4. Update the promotion checklist in this file if anything moved.
5. Tag `v<version>`. The tag is the product, not the edition.
6. Build both: `npm run dist` and `npm run tauri build`.

Artefact names carry the edition so a downloaded file is self-describing:
`Periphery-1.0.0-beta.1-node-setup.exe`, `Periphery-1.0.0-beta.1-tauri-setup.exe`.

---

## 7. Why keep both at all?

Deleting the Electron shell the moment the Rust one starts working would trade a
known-good app for an unproven one on the strength of a benchmark. The Node
edition is the control: when a cue misbehaves in the Rust build, the question
"does it do that in the other edition too?" is answerable in seconds, and that
is worth more during the port than the tidiness of a single tree.

It costs discipline — the frontend in `ui/` is shared, so a change must work in
both — but that shared frontend is also what keeps the two from diverging into
genuinely different products.

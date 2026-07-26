//! Periphery — the ambient notification core.
//!
//! Split into a library plus a thin binary, per the Tauri 2 convention. The
//! logic modules below are the port of the Electron `utils/` layer and are
//! deliberately shell-agnostic: they take an injected [`clock::Clock`] and
//! [`clock::IdleSource`] rather than reading the wall clock or the OS directly,
//! which is what makes the timing behaviour testable without sleeping.

pub mod agent_beacon;
pub mod blocked;
pub mod clock;
pub mod crypto;
pub mod cue;
pub mod delivery;
pub mod digest;
pub mod focus;
pub mod overlay;
pub mod shell;
pub mod slack_tide;
pub mod store;
pub mod tiers;
pub mod tray;
pub mod webhook;

/// Builds and runs the Tauri application. See [`shell::run`].
///
/// The window set is intentionally empty in `tauri.conf.json`: overlays are one
/// per display and are created programmatically once the monitor list is known.
pub fn run() {
    shell::run();
}

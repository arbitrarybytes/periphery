//! Transparent, click-through overlay windows — one per display.
//!
//! Port of the `createOverlayWindow` / `syncOverlays` half of `main.js`.
//!
//! Three properties make this an *overlay* rather than a window, and all three
//! are load-bearing:
//!
//! 1. **Transparent and undecorated**, so only the cue itself is ever drawn.
//! 2. **Click-through** (`set_ignore_cursor_events`). The overlay covers the
//!    whole screen; without this it would swallow every click on the desktop.
//! 3. **Always on top**, including over full-screen apps — otherwise cues are
//!    invisible during exactly the deep work they exist to protect.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Window labels are `overlay-0`, `overlay-1`, … matching monitor order. The
/// capability file allowlists `overlay-*`, so the prefix is load-bearing.
pub const LABEL_PREFIX: &str = "overlay-";

pub fn label_for(index: usize) -> String {
    format!("{LABEL_PREFIX}{index}")
}

pub fn is_overlay(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// Every live overlay window, in monitor order.
pub fn windows(app: &AppHandle) -> Vec<tauri::WebviewWindow> {
    let mut found: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| is_overlay(label))
        .collect();
    // `webview_windows()` returns a HashMap, so the order is arbitrary; sort by
    // the numeric suffix to restore monitor order.
    found.sort_by_key(|(label, _)| {
        label[LABEL_PREFIX.len()..].parse::<usize>().unwrap_or(usize::MAX)
    });
    found.into_iter().map(|(_, window)| window).collect()
}

/// Creates one overlay per connected display, replacing any that exist.
pub fn rebuild(app: &AppHandle) -> tauri::Result<()> {
    for window in windows(app) {
        let _ = window.destroy();
    }

    let monitors = app.available_monitors()?;
    if monitors.is_empty() {
        eprintln!("[Overlay] No monitors reported; no overlays created.");
        return Ok(());
    }

    for (index, monitor) in monitors.iter().enumerate() {
        let position = *monitor.position();
        let size = *monitor.size();

        let window = WebviewWindowBuilder::new(
            app,
            label_for(index),
            WebviewUrl::App("index.html".into()),
        )
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        // The overlay must never take focus: stealing it is the exact
        // interruption the product exists to avoid.
        .focused(false)
        .shadow(false)
        .visible(true)
        // Physical pixels: monitor geometry is reported in physical units, and
        // mixing in logical ones misplaces the window on a scaled display.
        .position(position.x as f64, position.y as f64)
        .inner_size(size.width as f64, size.height as f64)
        // Standing state must arrive *after* the page has listeners, and again
        // on every rebuild — otherwise a display change silently drops a
        // blocked agent off the screen. This is the Tauri equivalent of
        // Electron's `did-finish-load`.
        .on_page_load(|window, _| on_page_load(&window))
        .build()?;

        // Tauri's builder has no physical-position setter, so the values above
        // are re-applied as physical to survive a non-100% scale factor.
        let _ = window.set_position(position);
        let _ = window.set_size(size);
        let _ = window.set_ignore_cursor_events(true);

        // The overlay is click-through, so devtools cannot be opened by hand.
        // PERIPHERY_DEVTOOLS=1 opens them on the first overlay, which is the
        // only practical way to see a renderer error in a window you cannot
        // click on. Debug builds only.
        #[cfg(debug_assertions)]
        if index == 0 && std::env::var("PERIPHERY_DEVTOOLS").as_deref() == Ok("1") {
            window.open_devtools();
        }

    }

    Ok(())
}

/// Runs once the overlay document is ready.
fn on_page_load(window: &tauri::WebviewWindow) {
    // PERIPHERY_SELFTEST=1 paints a marker directly into the overlay,
    // bypassing the event system. It separates "the webview is not painting"
    // from "the cue never arrived" — two failures that look identical from the
    // outside, because both show nothing.
    #[cfg(debug_assertions)]
    if std::env::var("PERIPHERY_SELFTEST").as_deref() == Ok("1") {
        let _ = window.eval(
            "document.body.insertAdjacentHTML('beforeend',
               '<div style=\"position:fixed;left:0;top:0;width:900px;\
                  background:#000;color:#0f0;font:15px monospace;\
                  z-index:99999;padding:12px\">SELFTEST paints ok<br>periphery=' \
               + (typeof window.periphery) + '<br>bridge=' + (window.__peripheryBridge || 'never ran') \
               + '<br>__TAURI__ keys=' + (window.__TAURI__ ? Object.keys(window.__TAURI__).join(',') : 'none') \
               + '</div>')",
        );
    }

    let _ = window.emit_to(window.label(), "set-theme", theme_payload());
}

/// Presentation hints the overlay needs before it can draw anything: the OS
/// accent colour, and whether to use the low-power animation profile.
///
/// The accent is still hardcoded to Periphery's signal blue — reading the live
/// Windows accent is a Win32 call that is not wired up yet, and guessing would
/// be worse than a consistent default.
fn theme_payload() -> serde_json::Value {
    serde_json::json!({ "accent": "#38c5ff", "eco": false })
}

/// A fingerprint of the current display arrangement.
///
/// Tauri exposes no display-changed event on Windows (`RunEvent::Reopen` is
/// macOS-only), so the shell polls this instead and re-syncs when it moves.
/// Comparing a signature rather than re-applying geometry every tick keeps the
/// common case — nothing changed — free of window-manager calls.
pub fn signature(app: &AppHandle) -> String {
    match app.available_monitors() {
        Ok(monitors) => monitors
            .iter()
            .map(|m| {
                let p = m.position();
                let s = m.size();
                format!("{},{},{}x{}@{}", p.x, p.y, s.width, s.height, m.scale_factor())
            })
            .collect::<Vec<_>>()
            .join(";"),
        // An error must not read as "no displays", or every tick would try to
        // rebuild against an empty set.
        Err(_) => "unknown".to_string(),
    }
}

/// Brings overlays in line with the current display set.
///
/// A pure metrics change — scale factor, resolution, work area — only moves the
/// existing windows. A full teardown would respawn every webview for what is
/// really just a resize, and would drop any standing state cue on the way.
pub fn sync(app: &AppHandle) -> tauri::Result<()> {
    let monitors = app.available_monitors()?;
    let existing = windows(app);

    if existing.len() != monitors.len() {
        return rebuild(app);
    }

    for (window, monitor) in existing.iter().zip(monitors.iter()) {
        let _ = window.set_position(*monitor.position());
        let _ = window.set_size(*monitor.size());
    }
    Ok(())
}

/// Lets the pointer interact with the overlay again — used only while the
/// digest panel is open, which is the one interactive thing it ever draws.
pub fn set_interactive(app: &AppHandle, interactive: bool) {
    for window in windows(app) {
        let _ = window.set_ignore_cursor_events(!interactive);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_round_trip_and_are_recognised() {
        assert_eq!(label_for(0), "overlay-0");
        assert!(is_overlay(&label_for(3)));
        assert!(!is_overlay("settings"));
        assert!(!is_overlay("onboarding"));
    }

    #[test]
    fn the_label_prefix_matches_the_capability_allowlist() {
        // capabilities/default.json allowlists "overlay-*". If the prefix here
        // changed, overlays would silently lose permission to receive cues.
        let capability = include_str!("../capabilities/default.json");
        assert!(
            capability.contains(&format!("{LABEL_PREFIX}*")),
            "capability window allowlist must cover the overlay label prefix"
        );
    }
}

//! The Tauri application shell: state, tray, timers, and IPC.
//!
//! This is the Rust counterpart to `main.js`'s wiring — the part that owns the
//! long-lived objects and connects the pure logic to the operating system.
//! Everything with a decision in it lives in [`crate::delivery`] and
//! [`crate::tray`], which is why this module is mostly plumbing.

use crate::clock::{Clock, IdleSource, SystemClock, SystemIdle};
use crate::cue::ResolveRequest;
use crate::delivery::{Outbound, Pipeline, Shared};
use crate::focus::FocusMonitor;
use crate::overlay;
use crate::store::{ConfigStore, SecureStore};
use crate::tray::{Badge, HealthIssue, tray_state};
use crate::webhook::{self, WebhookHandlers};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

/// How often the tide, blocked escalation, and focus state are re-examined.
/// One second is comfortably finer than any threshold they use and costs
/// nothing measurable.
const TICK: Duration = Duration::from_secs(1);

/// How often the display arrangement is checked for changes.
const DISPLAY_POLL: Duration = Duration::from_secs(2);

/// Display events arrive in bursts while a resolution or DPI change settles,
/// so overlays are re-synced once the burst stops rather than per event.
const DISPLAY_SETTLE: Duration = Duration::from_millis(600);

pub struct AppState {
    pub pipeline: Shared,
    pub secrets: Mutex<SecureStore>,
    pub focus_monitor: Mutex<FocusMonitor>,
    pub health: Mutex<Vec<HealthIssue>>,
    pub tray: Mutex<Option<TrayIcon>>,
    /// The unbadged tray icon's pixels, kept so a badge is always composited
    /// onto a clean base rather than onto a previous badge.
    ///
    /// Stored as raw RGBA rather than an `Image`, which borrows from the app
    /// handle and so cannot live in long-lived state.
    pub tray_base: Mutex<Option<TrayBase>>,
    pub tray_badge: Mutex<Option<Badge>>,
}

pub struct TrayBase {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

impl TrayBase {
    fn image(&self) -> Image<'_> {
        Image::new(&self.rgba, self.width, self.height)
    }
}

impl AppState {
    fn config<T>(&self, read: impl FnOnce(&ConfigStore) -> T) -> T {
        let pipeline = self.pipeline.lock().expect("pipeline lock");
        read(&pipeline.config)
    }
}

/// Fans an outbound message to every overlay.
///
/// Overlays are decorative and interchangeable, so all of them get everything
/// — except the digest panel, which is interactive and would otherwise appear
/// once per monitor.
pub fn dispatch(app: &AppHandle, messages: Vec<Outbound>) {
    if !messages.is_empty() {
        // A cue that reaches zero overlays is indistinguishable from no cue at
        // all, and that is exactly the failure the user would report as
        // "nothing happens". Make it visible in the log instead.
        let count = overlay::windows(app).len();
        if count == 0 {
            eprintln!("[Shell] {} message(s) had no overlay to draw on.", messages.len());
        }
    }

    for message in messages {
        let (channel, payload) = match &message {
            Outbound::TriggerCue(p) => ("trigger-cue", p),
            Outbound::Constellation(p) => ("constellation", p),
            Outbound::BlockedAgents(p) => ("blocked-agents", p),
            Outbound::Digest(p) => ("digest", p),
        };

        if matches!(message, Outbound::Digest(_)) {
            if let Some(primary) = overlay::windows(app).into_iter().next() {
                let _ = primary.emit(channel, payload);
            }
            continue;
        }

        for window in overlay::windows(app) {
            let _ = window.emit(channel, payload);
        }
    }
    refresh_tray(app);
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let focus = CheckMenuItem::with_id(app, "focus", "Focus mode", true, false, None::<&str>)?;
    let test = MenuItem::with_id(app, "test", "Send a test cue", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Periphery", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &settings,
            &focus,
            &test,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?;

    let base = TrayBase {
        rgba: icon.rgba().to_vec(),
        width: icon.width(),
        height: icon.height(),
    };

    let tray = TrayIconBuilder::with_id("periphery")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_tray_menu(app, event.id.as_ref()))
        .build(app)?;

    let state = app.state::<AppState>();
    *state.tray_base.lock().expect("tray base lock") = Some(base);
    *state.tray.lock().expect("tray lock") = Some(tray);
    refresh_tray(app);
    Ok(())
}

fn on_tray_menu(app: &AppHandle, id: &str) {
    match id {
        "settings" => open_settings(app),
        "focus" => toggle_focus(app),
        "test" => {
            let messages = {
                let state = app.state::<AppState>();
                let mut pipeline = state.pipeline.lock().expect("pipeline lock");
                pipeline.deliver(&serde_json::json!({
                    "cue": "glow-pulse",
                    "msg": "Periphery is watching",
                    "icon": "alert",
                }))
            };
            dispatch(app, messages);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn toggle_focus(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (now_focused, messages) = {
        let mut pipeline = state.pipeline.lock().expect("pipeline lock");
        pipeline.focus.manual = !pipeline.focus.manual;
        let focused = pipeline.focus.manual;
        // Leaving focus mode is what dissolves the constellation into a digest;
        // entering it just starts holding.
        let messages = if focused { Vec::new() } else { pipeline.end_focus() };
        (focused, messages)
    };
    println!("[Focus] manual focus mode {}", if now_focused { "on" } else { "off" });
    dispatch(app, messages);
}

/// Recomputes the tooltip and badge. Cheap enough to call after anything.
pub fn refresh_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (focused, held, blocked, health_enabled) = {
        let pipeline = state.pipeline.lock().expect("pipeline lock");
        (
            pipeline.is_focused(),
            pipeline.held_count(),
            pipeline.blocked.count(),
            pipeline.config.get_bool("healthBadgeEnabled", true),
        )
    };
    let health = state.health.lock().expect("health lock").clone();
    let desired = tray_state(focused, held, blocked, &health, health_enabled);

    let guard = state.tray.lock().expect("tray lock");
    let Some(tray) = guard.as_ref() else {
        return;
    };
    let _ = tray.set_tooltip(Some(&desired.tooltip));

    // Re-compositing on every tick would be wasteful and would flicker, so the
    // image is only touched when the badge actually changes.
    let mut current = state.tray_badge.lock().expect("badge lock");
    if *current == desired.badge {
        return;
    }
    *current = desired.badge;

    let base = state.tray_base.lock().expect("tray base lock");
    let Some(base) = base.as_ref() else {
        return;
    };

    match desired.badge {
        None => {
            let _ = tray.set_icon(Some(base.image()));
        }
        Some(badge) => {
            // The accent colour is a Windows nicety; a fixed signal blue is a
            // reasonable stand-in until it is wired up.
            let color = badge.color((56, 197, 255));
            match crate::tray::draw_badge_dot(&base.rgba, base.width, base.height, color) {
                Some(pixels) => {
                    let image = Image::new_owned(pixels, base.width, base.height);
                    let _ = tray.set_icon(Some(image));
                }
                None => {
                    // Decoration must never take the tray icon down with it.
                    eprintln!("[Tray] Could not composite the badge dot; showing the plain icon.");
                    let _ = tray.set_icon(Some(base.image()));
                    *current = None;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

fn open_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let built = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Periphery Settings")
    .inner_size(560.0, 760.0)
    .resizable(true)
    .build();

    if let Err(err) = built {
        eprintln!("[Shell] Could not open Settings: {err}");
    }
}

// ---------------------------------------------------------------------------
// Commands (the replacement for the Electron preload bridges)
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config(state: tauri::State<'_, AppState>) -> Value {
    Value::Object(state.config(|config| config.all()))
}

#[tauri::command]
fn save_config(app: AppHandle, state: tauri::State<'_, AppState>, config: Value) -> bool {
    let Some(map) = config.as_object() else {
        return false;
    };
    {
        let mut pipeline = state.pipeline.lock().expect("pipeline lock");
        pipeline
            .config
            .set_many(map.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    refresh_tray(&app);
    true
}

/// Asks the overlay to accept real mouse events. Only the digest panel needs
/// this; everything else must stay click-through.
#[tauri::command]
fn set_digest_interactive(app: AppHandle, interactive: bool) {
    overlay::set_interactive(&app, interactive);
}

#[tauri::command]
fn send_test_cue(app: AppHandle, state: tauri::State<'_, AppState>, cue: String) -> bool {
    let messages = {
        let mut pipeline = state.pipeline.lock().expect("pipeline lock");
        pipeline.deliver(&serde_json::json!({ "cue": cue, "msg": "Test cue" }))
    };
    let delivered = !messages.is_empty();
    dispatch(&app, messages);
    delivered
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

fn store_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

fn spawn_ticker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(TICK);
        loop {
            ticker.tick().await;
            let messages = {
                let state = app.state::<AppState>();

                // Focus Assist is polled here rather than on its own timer:
                // one loop is easier to reason about than three.
                let detected = state
                    .focus_monitor
                    .lock()
                    .expect("focus lock")
                    .poll();

                let mut pipeline = state.pipeline.lock().expect("pipeline lock");
                let mut out = Vec::new();
                if let Some(dnd) = detected {
                    let was_focused = pipeline.is_focused();
                    pipeline.focus.detected_dnd = dnd;
                    // Focus ending is what releases everything that was held.
                    if was_focused && !pipeline.is_focused() {
                        out.extend(pipeline.end_focus());
                    }
                }
                out.extend(pipeline.tick());
                out
            };
            if !messages.is_empty() {
                dispatch(&app, messages);
            }
        }
    });
}

fn spawn_webhook(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let for_cue = app.clone();
        let for_resolve = app.clone();

        let handlers = Arc::new(WebhookHandlers {
            on_cue: Box::new(move |payload| {
                let messages = {
                    let state = for_cue.state::<AppState>();
                    let mut pipeline = state.pipeline.lock().expect("pipeline lock");
                    // The payload is already validated; re-serialising keeps
                    // one entry point into the pipeline rather than two.
                    pipeline.deliver(&serde_json::to_value(&payload).unwrap_or_default())
                };
                dispatch(&for_cue, messages);
            }),
            on_resolve: Box::new(move |request: ResolveRequest| {
                let (cleared, messages) = {
                    let state = for_resolve.state::<AppState>();
                    let mut pipeline = state.pipeline.lock().expect("pipeline lock");
                    pipeline.resolve(&request)
                };
                dispatch(&for_resolve, messages);
                cleared
            }),
        });

        match webhook::bind(webhook::DEFAULT_PORT).await {
            Ok(listener) => {
                if let Err(err) = webhook::serve(listener, handlers).await {
                    eprintln!("[Webhook] Server stopped: {err}");
                }
            }
            Err(err) => {
                // Almost always the other edition already running. Both bind
                // 49123 on purpose — see ai-native/versioning.md — so this is
                // an expected condition, not a crash.
                eprintln!(
                    "[Webhook] Port {} is already in use ({err}). Another Periphery edition is \
                     probably running; only one may hold the cue contract at a time.",
                    webhook::DEFAULT_PORT
                );
            }
        }
    });
}

/// Builds and runs the application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // The updater plugin is deliberately NOT registered yet. It refuses to
        // initialise without `plugins.updater.pubkey` in tauri.conf.json, and
        // that key does not exist until the build is signed. Registering it
        // with a placeholder would turn a missing feature into a startup
        // panic, or worse, an updater that looks configured and is not.
        // Tracked as the auto-update item in ai-native/versioning.md.
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            set_digest_interactive,
            send_test_cue,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = store_dir(&handle);

            let clock: Arc<dyn Clock> = Arc::new(SystemClock);
            let idle: Arc<dyn IdleSource> = Arc::new(SystemIdle);

            let config = ConfigStore::new(dir.join("periphery-config.json"));
            let secrets = SecureStore::new(
                dir.join("periphery-secrets.json"),
                crate::crypto::default_crypto(),
            );

            handle.manage(AppState {
                pipeline: Arc::new(Mutex::new(Pipeline::new(config, clock, idle))),
                secrets: Mutex::new(secrets),
                focus_monitor: Mutex::new(FocusMonitor::new()),
                health: Mutex::new(Vec::new()),
                tray: Mutex::new(None),
                tray_base: Mutex::new(None),
                tray_badge: Mutex::new(None),
            });

            overlay::rebuild(&handle)?;
            println!(
                "[Shell] {} overlay window(s) ready across {} display(s).",
                overlay::windows(&handle).len(),
                handle.available_monitors().map(|m| m.len()).unwrap_or(0)
            );
            build_tray(&handle)?;
            spawn_webhook(handle.clone());
            spawn_display_watch(handle.clone());
            spawn_ticker(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing Settings must not close the app: Periphery lives in the
            // tray, and quitting is an explicit menu choice.
            if let WindowEvent::CloseRequested { api, .. } = event
                && !overlay::is_overlay(window.label())
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Periphery")
        .run(|_app, event| {
            // Periphery is a tray app: it must outlive every window, including
            // the last one. Quitting is only ever an explicit menu choice.
            if let RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}

/// Watches for display changes and re-syncs the overlays.
///
/// Tauri surfaces no display-changed event on Windows, so this polls a cheap
/// geometry fingerprint. Changes arrive in bursts while a resolution or DPI
/// change settles, so a change is confirmed stable before acting — otherwise
/// overlays would be rebuilt several times mid-transition.
fn spawn_display_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut known = overlay::signature(&app);
        let mut ticker = tokio::time::interval(DISPLAY_POLL);
        loop {
            ticker.tick().await;
            let current = overlay::signature(&app);
            if current == known {
                continue;
            }

            tokio::time::sleep(DISPLAY_SETTLE).await;
            let settled = overlay::signature(&app);
            if settled != current {
                // Still moving; pick it up on the next pass.
                continue;
            }

            known = settled;
            println!("[Overlay] Display arrangement changed; re-syncing overlays.");
            if let Err(err) = overlay::sync(&app) {
                eprintln!("[Overlay] Could not re-sync displays: {err}");
            }
        }
    });
}

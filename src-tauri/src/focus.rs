//! Focus Assist / Do Not Disturb detection.
//!
//! This is the payoff promised in ADR 2. The Electron build could not call
//! `SHQueryUserNotificationState` without a native module, so it spawned a
//! long-lived `powershell.exe` that P/Invoked the API every 45 seconds and
//! printed an integer. That whole bridge is gone: here it is one direct call
//! into shell32, so the poll is a bare syscall, detection latency drops from
//! 45 s to whatever interval we choose, and there is no child process, no
//! Add-Type compile, and nothing to respawn when it dies.
//!
//! The state *mapping* ports across unchanged, and is still the part worth
//! unit-testing — it is pure and platform-independent.

/// `SHQueryUserNotificationState` value meaning "Windows would show a toast".
/// Every other documented state (busy, D3D full screen, presentation mode,
/// quiet time, Focus Assist / Do Not Disturb) means the OS itself would
/// suppress or queue a notification, so Periphery holds its cues too.
pub const QUNS_ACCEPTS_NOTIFICATIONS: i32 = 5;
const QUNS_MIN: i32 = 1;
const QUNS_MAX: i32 = 7;

/// Maps a raw `SHQueryUserNotificationState` value to "should cues be held".
/// An out-of-range value means the API told us something we do not understand,
/// which must never be read as "do not disturb" — cue delivery fails open.
pub fn is_do_not_disturb(state: i32) -> bool {
    (QUNS_MIN..=QUNS_MAX).contains(&state) && state != QUNS_ACCEPTS_NOTIFICATIONS
}

/// Reads the current notification state. `None` when the query failed, which
/// callers treat as "keep the last known state" rather than as a change.
#[cfg(target_os = "windows")]
pub fn query_state() -> Option<i32> {
    use windows::Win32::UI::Shell::SHQueryUserNotificationState;
    // SAFETY: the call takes no arguments and writes an enum out-param that
    // the binding owns; failure surfaces as an Err rather than a bad value.
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => Some(state.0),
        Err(err) => {
            eprintln!("[Focus] SHQueryUserNotificationState failed: {err}");
            None
        }
    }
}

/// Non-Windows builds never report DND; the manual tray toggle still works.
#[cfg(not(target_os = "windows"))]
pub fn query_state() -> Option<i32> {
    None
}

/// Tracks the last known state so callers only react to transitions.
#[derive(Default)]
pub struct FocusMonitor {
    dnd: bool,
}

impl FocusMonitor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_dnd(&self) -> bool {
        self.dnd
    }

    /// Polls once. Returns `Some(dnd)` only on a transition, so the caller can
    /// flush held cues exactly when focus actually ends.
    pub fn poll(&mut self) -> Option<bool> {
        let state = query_state()?;
        self.apply(is_do_not_disturb(state))
    }

    /// The transition-detection half, separated so it is testable without the
    /// OS in the loop.
    pub fn apply(&mut self, dnd: bool) -> Option<bool> {
        if dnd == self.dnd {
            return None;
        }
        self.dnd = dnd;
        Some(dnd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_accepts_notifications_means_not_disturbed() {
        assert!(!is_do_not_disturb(QUNS_ACCEPTS_NOTIFICATIONS));
    }

    #[test]
    fn every_other_documented_state_holds_cues() {
        // 1 NOT_PRESENT, 2 BUSY, 3 D3D_FULL_SCREEN, 4 PRESENTATION_MODE,
        // 6 QUIET_TIME (Focus Assist), 7 APP (a full-screen app).
        for state in [1, 2, 3, 4, 6, 7] {
            assert!(is_do_not_disturb(state), "state {state} should hold cues");
        }
    }

    #[test]
    fn unknown_states_fail_open() {
        for state in [0, -1, 8, 99, i32::MAX, i32::MIN] {
            assert!(
                !is_do_not_disturb(state),
                "state {state} is unknown and must not mute cues"
            );
        }
    }

    #[test]
    fn transitions_are_reported_once() {
        let mut monitor = FocusMonitor::new();
        assert!(!monitor.is_dnd());

        assert_eq!(monitor.apply(true), Some(true));
        assert_eq!(monitor.apply(true), None, "no change, no report");
        assert_eq!(monitor.apply(false), Some(false));
        assert_eq!(monitor.apply(false), None);
        assert!(!monitor.is_dnd());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_real_api_returns_a_documented_state() {
        // Proves the binding and linkage work on the machine running the
        // tests — the thing the PowerShell bridge existed to avoid needing.
        let state = query_state().expect("SHQueryUserNotificationState should succeed");
        assert!(
            (QUNS_MIN..=QUNS_MAX).contains(&state),
            "got undocumented state {state}"
        );
    }
}

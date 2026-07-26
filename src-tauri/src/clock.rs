//! Injectable clock and input-idle source.
//!
//! The JS original passed `now` and `getIdleSeconds` as callbacks so the
//! timing logic could be unit-tested; these traits are the Rust equivalent.
//! Everything that escalates, defers, or expires depends on these rather than
//! on wall-clock time directly.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

/// Wall-clock milliseconds since the epoch.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// Seconds since the last keyboard or mouse input. Not keylogging — just
/// "how long since anything happened", which is all the tide and the beacon
/// acknowledgment need.
pub trait IdleSource: Send + Sync {
    fn idle_seconds(&self) -> u64;
}

/// The real thing: `GetLastInputInfo`, which is what Electron's
/// `powerMonitor.getSystemIdleTime()` wrapped anyway.
///
/// It reports the tick of the last input event, session-wide — no hooks, no
/// keystroke content, nothing that could observe *what* was typed. That
/// distinction is the whole reason the Slack Tide is defensible.
pub struct SystemIdle;

impl IdleSource for SystemIdle {
    #[cfg(target_os = "windows")]
    fn idle_seconds(&self) -> u64 {
        use windows::Win32::System::SystemInformation::GetTickCount64;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };

        // A failure here must read as "the user is active": treating it as
        // idle would release held cues into the middle of a keystroke burst.
        if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            let now = unsafe { GetTickCount64() };
            // dwTime is a 32-bit tick count and wraps every ~49 days, while
            // GetTickCount64 does not. Comparing them directly would produce a
            // wildly wrong idle time after a wrap, so truncate to 32 bits and
            // let the subtraction wrap with it.
            let elapsed_ms = (now as u32).wrapping_sub(info.dwTime);
            u64::from(elapsed_ms) / 1000
        } else {
            0
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn idle_seconds(&self) -> u64 {
        // No backend yet. Reporting 0 means "active", which keeps the tide
        // holding cues rather than releasing them at the wrong moment.
        0
    }
}

/// A hand-driven clock for tests.
#[derive(Clone, Default)]
pub struct TestClock {
    millis: Arc<AtomicU64>,
}

impl TestClock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, millis: u64) {
        self.millis.store(millis, Ordering::SeqCst);
    }

    pub fn advance(&self, millis: u64) {
        self.millis.fetch_add(millis, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.millis.load(Ordering::SeqCst)
    }
}

/// A hand-driven idle source for tests.
#[derive(Clone, Default)]
pub struct TestIdle {
    seconds: Arc<AtomicU64>,
}

impl TestIdle {
    pub fn new(seconds: u64) -> Self {
        let idle = Self::default();
        idle.set(seconds);
        idle
    }

    pub fn set(&self, seconds: u64) {
        self.seconds.store(seconds, Ordering::SeqCst);
    }
}

impl IdleSource for TestIdle {
    fn idle_seconds(&self) -> u64 {
        self.seconds.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_test_clock_is_hand_driven() {
        let clock = TestClock::new();
        assert_eq!(clock.now_ms(), 0);
        clock.set(1_000);
        assert_eq!(clock.now_ms(), 1_000);
        clock.advance(500);
        assert_eq!(clock.now_ms(), 1_500);
    }

    #[test]
    fn the_system_clock_moves_forward() {
        let clock = SystemClock;
        assert!(clock.now_ms() > 1_700_000_000_000, "epoch millis, not seconds");
    }
}

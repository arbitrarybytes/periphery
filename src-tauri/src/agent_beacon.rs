//! Acknowledgment watcher for persistent agent completion cues
//! (`glow-agent`). Port of `utils/agentBeacon.js`.
//!
//! The beacon exists so a coding agent's "task complete" is known even when
//! the dev misses the moment it fired: it keeps breathing in the corner until
//! someone is demonstrably back at the keyboard. A beacon is acknowledged when
//! it has been visible for at least `min_visible_ms` AND the user is active
//! right now, or unconditionally after `max_linger_ms` (an OLED-burn-in
//! guard). A dev who is away for hours keeps the beacon for hours.
//!
//! Contrast `blocked.rs`, where returning to the keyboard is deliberately
//! *not* enough: presence is not approval.

use crate::clock::{Clock, IdleSource};
use std::sync::Arc;

/// Minimum time a beacon stays up, even with the user at the keyboard.
pub const MIN_VISIBLE_MS: u64 = 45_000;
/// Input idle below this means "someone is at the keyboard right now".
pub const ACTIVE_IDLE_SECONDS: u64 = 5;
/// Absolute cap, only to spare the panel a day-long standing animation.
pub const MAX_LINGER_MS: u64 = 2 * 60 * 60_000;

pub struct AgentAckWatcher {
    clock: Arc<dyn Clock>,
    idle: Arc<dyn IdleSource>,
    pending: usize,
    /// When the oldest unacknowledged beacon was delivered.
    oldest_at: u64,
    min_visible_ms: u64,
    active_idle_seconds: u64,
    max_linger_ms: u64,
}

impl AgentAckWatcher {
    pub fn new(clock: Arc<dyn Clock>, idle: Arc<dyn IdleSource>) -> Self {
        Self {
            clock,
            idle,
            pending: 0,
            oldest_at: 0,
            min_visible_ms: MIN_VISIBLE_MS,
            active_idle_seconds: ACTIVE_IDLE_SECONDS,
            max_linger_ms: MAX_LINGER_MS,
        }
    }

    #[cfg(test)]
    pub fn with_thresholds(mut self, min_visible_ms: u64, max_linger_ms: u64) -> Self {
        self.min_visible_ms = min_visible_ms;
        self.max_linger_ms = max_linger_ms;
        self
    }

    /// Call when a `glow-agent` cue is broadcast to the overlay.
    pub fn notify_delivered(&mut self) {
        if self.pending == 0 {
            self.oldest_at = self.clock.now_ms();
        }
        self.pending += 1;
    }

    pub fn pending(&self) -> usize {
        self.pending
    }

    /// One acknowledgment check. Returns true when every pending beacon should
    /// fade (and replay its message once).
    pub fn check(&mut self) -> bool {
        if self.pending == 0 {
            return false;
        }
        let elapsed = self.clock.now_ms().saturating_sub(self.oldest_at);
        let user_is_back =
            elapsed >= self.min_visible_ms && self.idle.idle_seconds() < self.active_idle_seconds;
        if user_is_back || elapsed >= self.max_linger_ms {
            self.pending = 0;
            return true;
        }
        false
    }

    /// Drops pending state without acknowledging (shutdown).
    pub fn clear(&mut self) {
        self.pending = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{TestClock, TestIdle};

    fn watcher(idle_seconds: u64) -> (AgentAckWatcher, TestClock, TestIdle) {
        let clock = TestClock::new();
        let idle = TestIdle::new(idle_seconds);
        let watcher = AgentAckWatcher::new(Arc::new(clock.clone()), Arc::new(idle.clone()))
            .with_thresholds(1_000, 100_000);
        (watcher, clock, idle)
    }

    #[test]
    fn an_active_user_still_gets_the_minimum_visible_time() {
        let (mut watcher, clock, _idle) = watcher(0);
        watcher.notify_delivered();

        assert!(!watcher.check(), "no ack before min_visible_ms");
        clock.set(1_000);
        assert!(watcher.check(), "active user + minimum time = acknowledged");
    }

    #[test]
    fn an_absent_user_keeps_the_beacon_however_long() {
        let (mut watcher, clock, idle) = watcher(3_600);
        watcher.notify_delivered();

        clock.set(40_000);
        assert!(!watcher.check(), "no keyboard, no ack");

        idle.set(1); // they are back
        assert!(watcher.check());
    }

    #[test]
    fn the_linger_cap_acknowledges_even_without_input() {
        let (mut watcher, clock, _idle) = watcher(3_600);
        watcher.notify_delivered();

        clock.set(100_000);
        assert!(watcher.check(), "burn-in guard");
    }

    #[test]
    fn a_batch_is_acknowledged_once_timed_from_the_oldest() {
        let (mut watcher, clock, _idle) = watcher(0);
        watcher.notify_delivered();
        clock.set(900);
        watcher.notify_delivered(); // a second agent finishes just before the ack
        clock.set(1_000);

        assert!(watcher.check(), "one ack fades every pending beacon");
        assert_eq!(watcher.pending(), 0);
        assert!(!watcher.check(), "nothing pending, nothing acknowledged");

        // The next delivery starts a fresh clock.
        watcher.notify_delivered();
        assert!(!watcher.check(), "the new beacon gets its own minimum time");
        clock.set(2_000);
        assert!(watcher.check());
    }

    #[test]
    fn clear_drops_pending_beacons_without_acknowledging() {
        let (mut watcher, clock, _idle) = watcher(0);
        watcher.notify_delivered();
        watcher.clear();
        clock.set(5_000);
        assert!(!watcher.check());
    }
}

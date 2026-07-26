//! Blocked-agent tracking with age-based escalation. Port of
//! `utils/blockedAgents.js`.
//!
//! An agent waiting for approval is the most expensive kind of stall. A
//! *finished* task merely waits to be noticed — the cost of missing it is
//! bounded. A *blocked* task burns wall-clock for work already in flight, and
//! that cost compounds every second. So the cue's insistence compounds too.
//!
//! Escalation is deliberately bounded at level 2: brighter, larger, and more
//! rhythmic, but never a comet and never a sound.
//!
//! The critical difference from the completion beacon: returning to the
//! keyboard does NOT clear a blocked cue. Presence is not approval.

use crate::clock::Clock;
use crate::cue::CuePayload;
use indexmap::IndexMap;
use serde::Serialize;
use std::sync::Arc;

/// Age at which the cue moves from "subtle" to "noticeable".
pub const LEVEL_1_MS: u64 = 60_000;
/// Age at which it becomes insistent — real time is now being wasted.
pub const LEVEL_2_MS: u64 = 4 * 60_000;
/// Safety valve: an agent this stale is presumed dead, not waiting.
pub const MAX_AGE_MS: u64 = 60 * 60_000;
/// Bound on tracked entries; a fleet larger than this collapses into a count.
pub const MAX_ENTRIES: usize = 12;

#[derive(Debug, Clone, Serialize)]
pub struct BlockedEntry {
    pub r#ref: String,
    pub msg: Option<String>,
    pub color: Option<String>,
    pub at: u64,
}

/// What the overlay and tray render from.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BlockedState {
    pub count: usize,
    pub level: u8,
    pub entries: Vec<BlockedEntryView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BlockedEntryView {
    pub r#ref: String,
    pub msg: Option<String>,
    pub color: Option<String>,
    pub at: u64,
}

pub struct BlockedTracker {
    clock: Arc<dyn Clock>,
    /// Insertion-ordered so "oldest" and "newest" are meaningful.
    entries: IndexMap<String, BlockedEntry>,
    level_1_ms: u64,
    level_2_ms: u64,
    max_age_ms: u64,
    auto_ref: u64,
    last_level: u8,
}

impl BlockedTracker {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            entries: IndexMap::new(),
            level_1_ms: LEVEL_1_MS,
            level_2_ms: LEVEL_2_MS,
            max_age_ms: MAX_AGE_MS,
            auto_ref: 0,
            last_level: 0,
        }
    }

    #[cfg(test)]
    pub fn with_thresholds(mut self, level_1_ms: u64, level_2_ms: u64, max_age_ms: u64) -> Self {
        self.level_1_ms = level_1_ms;
        self.level_2_ms = level_2_ms;
        self.max_age_ms = max_age_ms;
        self
    }

    /// Registers a blocked agent, or refreshes one already tracked.
    /// Returns the ref, so a caller can resolve it later.
    pub fn block(&mut self, payload: &CuePayload) -> String {
        let r#ref = match payload.r#ref.clone() {
            Some(r) if !r.is_empty() => r,
            _ => {
                self.auto_ref += 1;
                format!("auto-{}", self.auto_ref)
            }
        };

        if let Some(existing) = self.entries.get_mut(&r#ref) {
            // A re-ping of the same block is the *same* stall: refresh the
            // wording, never reset the clock, or an agent that repeats itself
            // would escalate forever without ever getting more urgent.
            if payload.msg.is_some() {
                existing.msg = payload.msg.clone();
            }
            return r#ref;
        }

        if self.entries.len() >= MAX_ENTRIES {
            // Drop the newest-but-one rather than the oldest: escalation is
            // driven by the oldest entry, which is the one costing time.
            if let Some(newest) = self.entries.keys().last().cloned() {
                self.entries.shift_remove(&newest);
            }
        }

        self.entries.insert(
            r#ref.clone(),
            BlockedEntry {
                r#ref: r#ref.clone(),
                msg: payload.msg.clone(),
                color: payload.color.clone(),
                at: self.clock.now_ms(),
            },
        );
        self.last_level = self.level();
        r#ref
    }

    /// Returns whether something was actually cleared.
    pub fn resolve(&mut self, r#ref: &str) -> bool {
        let removed = self.entries.shift_remove(r#ref).is_some();
        if removed {
            self.last_level = self.level();
        }
        removed
    }

    /// Clears everything (agent said "all clear", or the user dismissed).
    pub fn resolve_all(&mut self) -> usize {
        let count = self.entries.len();
        self.entries.clear();
        self.last_level = 0;
        count
    }

    pub fn count(&self) -> usize {
        self.entries.len()
    }

    /// 0 (subtle) | 1 (noticeable) | 2 (insistent)
    pub fn level(&self) -> u8 {
        let Some(oldest) = self.oldest_at() else {
            return 0;
        };
        let age = self.clock.now_ms().saturating_sub(oldest);
        if age >= self.level_2_ms {
            2
        } else if age >= self.level_1_ms {
            1
        } else {
            0
        }
    }

    pub fn state(&self) -> BlockedState {
        BlockedState {
            count: self.entries.len(),
            level: self.level(),
            entries: self
                .entries
                .values()
                .map(|e| BlockedEntryView {
                    r#ref: e.r#ref.clone(),
                    msg: e.msg.clone(),
                    color: e.color.clone(),
                    at: e.at,
                })
                .collect(),
        }
    }

    /// One escalation tick: drops abandoned entries, reports whether the
    /// overlay needs to be told anything (an expiry or a level change).
    pub fn tick(&mut self) -> bool {
        let now = self.clock.now_ms();
        let before = self.entries.len();
        // Compare age rather than a cutoff timestamp: a `now - max_age` cutoff
        // saturates to 0 early in the process's life and would expire entries
        // stamped at 0 on their very first tick.
        self.entries
            .retain(|_, e| now.saturating_sub(e.at) <= self.max_age_ms);
        if self.entries.len() != before {
            self.last_level = self.level();
            return true;
        }
        if self.entries.is_empty() {
            return false;
        }
        let level = self.level();
        if level != self.last_level {
            self.last_level = level;
            return true;
        }
        false
    }

    fn oldest_at(&self) -> Option<u64> {
        self.entries.values().map(|e| e.at).min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::TestClock;

    fn tracker() -> (BlockedTracker, TestClock) {
        let clock = TestClock::new();
        let tracker =
            BlockedTracker::new(Arc::new(clock.clone())).with_thresholds(1_000, 4_000, 60_000);
        (tracker, clock)
    }

    fn blocked_cue(r#ref: Option<&str>, msg: Option<&str>) -> CuePayload {
        let mut payload = CuePayload::new("glow-blocked");
        payload.r#ref = r#ref.map(str::to_string);
        payload.msg = msg.map(str::to_string);
        payload
    }

    #[test]
    fn escalates_through_the_three_levels_with_age_and_stops_there() {
        let (mut tracker, clock) = tracker();
        tracker.block(&blocked_cue(Some("a"), Some("Approve deleting 3 files?")));

        assert_eq!(tracker.level(), 0, "a fresh block is quiet");
        clock.set(999);
        assert_eq!(tracker.level(), 0);
        clock.set(1_000);
        assert_eq!(tracker.level(), 1);
        clock.set(4_000);
        assert_eq!(tracker.level(), 2);
        clock.set(60 * 60 * 1000);
        assert_eq!(tracker.level(), 2, "escalation is bounded");
    }

    #[test]
    fn a_re_ping_does_not_reset_the_escalation_clock() {
        let (mut tracker, clock) = tracker();
        tracker.block(&blocked_cue(Some("a"), Some("first")));
        clock.set(3_000);
        tracker.block(&blocked_cue(Some("a"), Some("still waiting")));

        assert_eq!(tracker.count(), 1, "the same ref is the same stall");
        clock.set(4_000);
        assert_eq!(tracker.level(), 2, "a chatty agent cannot stay quiet");
        assert_eq!(
            tracker.state().entries[0].msg.as_deref(),
            Some("still waiting"),
            "but the wording refreshes"
        );
    }

    #[test]
    fn escalation_follows_the_oldest_block() {
        let (mut tracker, clock) = tracker();
        tracker.block(&blocked_cue(Some("old"), None));
        clock.set(4_000);
        tracker.block(&blocked_cue(Some("new"), None));

        assert_eq!(tracker.count(), 2);
        assert_eq!(tracker.level(), 2, "the oldest stall is the one costing time");

        tracker.resolve("old");
        assert_eq!(tracker.level(), 0, "clearing it de-escalates");
    }

    #[test]
    fn resolve_clears_exactly_one_and_reports_honestly() {
        let (mut tracker, _clock) = tracker();
        tracker.block(&blocked_cue(Some("a"), None));
        tracker.block(&blocked_cue(Some("b"), None));

        assert!(tracker.resolve("a"));
        assert_eq!(tracker.count(), 1);
        assert!(!tracker.resolve("a"), "clearing twice is harmless and honest");
        assert!(!tracker.resolve("nonexistent"));
    }

    #[test]
    fn resolve_all_is_idempotent() {
        let (mut tracker, _clock) = tracker();
        tracker.block(&blocked_cue(Some("a"), None));
        tracker.block(&blocked_cue(Some("b"), None));

        assert_eq!(tracker.resolve_all(), 2);
        assert_eq!(tracker.count(), 0);
        assert_eq!(tracker.resolve_all(), 0);
    }

    #[test]
    fn blocks_without_a_ref_get_unique_auto_refs() {
        let (mut tracker, _clock) = tracker();
        let first = tracker.block(&blocked_cue(None, Some("one")));
        let second = tracker.block(&blocked_cue(None, Some("two")));
        assert_ne!(first, second, "auto refs must not collide");
        assert_eq!(tracker.count(), 2);
    }

    #[test]
    fn an_abandoned_block_eventually_expires() {
        let (mut tracker, clock) = tracker();
        tracker.block(&blocked_cue(Some("a"), None));

        clock.set(59_999);
        tracker.tick();
        assert_eq!(tracker.count(), 1, "still plausibly waiting");

        clock.set(60_001);
        assert!(tracker.tick(), "expiry must be announced");
        assert_eq!(tracker.count(), 0, "an agent this stale is dead, not waiting");
    }

    #[test]
    fn tick_announces_only_on_a_level_change() {
        let (mut tracker, clock) = tracker();
        tracker.block(&blocked_cue(Some("a"), None));

        assert!(!tracker.tick(), "no change, no announcement");
        clock.set(1_000);
        assert!(tracker.tick(), "level 0 -> 1 must be announced");
        assert!(!tracker.tick(), "and not repeated");
    }

    #[test]
    fn the_entry_cap_keeps_the_oldest() {
        let (mut tracker, clock) = tracker();
        for i in 0..MAX_ENTRIES {
            clock.set(i as u64);
            tracker.block(&blocked_cue(Some(&format!("r{i}")), None));
        }
        assert_eq!(tracker.count(), MAX_ENTRIES);

        clock.set(9_999);
        tracker.block(&blocked_cue(Some("overflow"), None));
        assert_eq!(tracker.count(), MAX_ENTRIES, "the cap holds");
        assert!(
            tracker.entries.contains_key("r0"),
            "the oldest — the one costing time — must survive"
        );
    }

    #[test]
    fn state_carries_what_the_overlay_and_tray_need() {
        let (mut tracker, _clock) = tracker();
        let mut payload = blocked_cue(Some("a"), Some("Approve?"));
        payload.color = Some("rgba(255, 122, 89, 0.9)".into());
        tracker.block(&payload);

        let state = tracker.state();
        assert_eq!(state.count, 1);
        assert_eq!(state.level, 0);
        assert_eq!(state.entries[0].r#ref, "a");
        assert_eq!(state.entries[0].msg.as_deref(), Some("Approve?"));
        assert_eq!(state.entries[0].at, 0);
    }
}

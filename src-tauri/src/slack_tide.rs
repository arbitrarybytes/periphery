//! Slack-tide delivery. Port of `utils/slackTide.js`.
//!
//! Ambient (tier 2-3) cues are held while the user is in a burst of keyboard
//! activity and released in the next natural micro-pause, so a notification
//! lands exactly when attention is already loose. Named for the moment
//! between tides when the water goes still.
//!
//! Unlike the JS original this returns what to deliver instead of invoking a
//! callback — the caller owns delivery (and the stagger between released
//! pills), which keeps this module pure and synchronously testable.

use crate::clock::{Clock, IdleSource};
use crate::cue::CuePayload;
use std::collections::VecDeque;
use std::sync::Arc;

/// Idle gap that counts as a natural pause worth delivering into.
pub const PAUSE_SECONDS: u64 = 6;
/// Never hold a cue longer than this, pause or no pause.
pub const MAX_HOLD_MS: u64 = 90_000;
/// Gap between cues released from the same pause, so pills don't pile up.
pub const STAGGER_MS: u64 = 1_500;
pub const MAX_QUEUE: usize = 12;

pub struct SlackTide {
    clock: Arc<dyn Clock>,
    idle: Arc<dyn IdleSource>,
    queue: VecDeque<(CuePayload, u64)>,
    /// Cues dropped once the queue is full, reported as one "+N more".
    overflow: usize,
    pause_seconds: u64,
    max_hold_ms: u64,
    max_queue: usize,
}

impl SlackTide {
    pub fn new(clock: Arc<dyn Clock>, idle: Arc<dyn IdleSource>) -> Self {
        Self {
            clock,
            idle,
            queue: VecDeque::new(),
            overflow: 0,
            pause_seconds: PAUSE_SECONDS,
            max_hold_ms: MAX_HOLD_MS,
            max_queue: MAX_QUEUE,
        }
    }

    pub fn size(&self) -> usize {
        self.queue.len() + self.overflow
    }

    /// Routes one cue. Returns `Some(payload)` to deliver immediately (the
    /// user is already pausing), or `None` when it was held for the next pause.
    pub fn push(&mut self, payload: CuePayload) -> Option<CuePayload> {
        if self.idle.idle_seconds() >= self.pause_seconds {
            return Some(payload);
        }
        if self.queue.len() >= self.max_queue {
            self.overflow += 1;
        } else {
            self.queue.push_back((payload, self.clock.now_ms()));
        }
        None
    }

    /// Called on a timer. Returns the cues to release now, oldest first —
    /// empty while the user is still typing and nothing is overdue.
    pub fn tick(&mut self) -> Vec<CuePayload> {
        if self.size() == 0 {
            return Vec::new();
        }
        let oldest = self.queue.front().map(|(_, at)| *at).unwrap_or_else(|| self.clock.now_ms());
        let overdue = self.clock.now_ms().saturating_sub(oldest) >= self.max_hold_ms;
        if overdue || self.idle.idle_seconds() >= self.pause_seconds {
            return self.flush();
        }
        Vec::new()
    }

    /// Releases everything, oldest first. The caller spaces them by
    /// `STAGGER_MS`.
    pub fn flush(&mut self) -> Vec<CuePayload> {
        let mut out: Vec<CuePayload> = self.queue.drain(..).map(|(p, _)| p).collect();
        if self.overflow > 0 {
            // No colour: the frontend falls back to the OS accent.
            let plural = if self.overflow == 1 { "" } else { "s" };
            out.push(
                CuePayload::new("glow-bottom")
                    .msg(format!("+{} more update{}", self.overflow, plural)),
            );
            self.overflow = 0;
        }
        out
    }

    /// Drops everything without delivering (shutdown).
    pub fn clear(&mut self) {
        self.queue.clear();
        self.overflow = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{TestClock, TestIdle};

    fn tide(idle_seconds: u64) -> (SlackTide, TestClock, TestIdle) {
        let clock = TestClock::new();
        let idle = TestIdle::new(idle_seconds);
        let tide = SlackTide::new(Arc::new(clock.clone()), Arc::new(idle.clone()));
        (tide, clock, idle)
    }

    #[test]
    fn a_user_already_pausing_gets_the_cue_immediately() {
        let (mut tide, _clock, _idle) = tide(10);
        let delivered = tide.push(CuePayload::new("glow"));
        assert!(delivered.is_some());
        assert_eq!(tide.size(), 0, "nothing was held");
    }

    #[test]
    fn a_cue_arriving_mid_burst_is_held_until_the_next_pause() {
        let (mut tide, _clock, idle) = tide(0);
        assert!(tide.push(CuePayload::new("glow")).is_none());
        assert_eq!(tide.size(), 1);

        assert!(tide.tick().is_empty(), "still typing, still holding");

        idle.set(PAUSE_SECONDS);
        let released = tide.tick();
        assert_eq!(released.len(), 1);
        assert_eq!(tide.size(), 0);
    }

    #[test]
    fn nothing_is_held_longer_than_the_cap_even_while_typing() {
        let (mut tide, clock, _idle) = tide(0);
        tide.push(CuePayload::new("glow"));

        clock.set(MAX_HOLD_MS - 1);
        assert!(tide.tick().is_empty());

        clock.set(MAX_HOLD_MS);
        assert_eq!(tide.tick().len(), 1, "the 90s cap always wins");
    }

    #[test]
    fn a_burst_larger_than_the_queue_collapses_into_one_more_cue() {
        let (mut tide, _clock, idle) = tide(0);
        for _ in 0..(MAX_QUEUE + 3) {
            tide.push(CuePayload::new("glow"));
        }
        assert_eq!(tide.size(), MAX_QUEUE + 3);

        idle.set(PAUSE_SECONDS);
        let released = tide.tick();
        assert_eq!(released.len(), MAX_QUEUE + 1, "the overflow becomes one cue");
        let last = released.last().unwrap();
        assert_eq!(last.msg.as_deref(), Some("+3 more updates"));
    }

    #[test]
    fn the_overflow_cue_is_singular_for_one() {
        let (mut tide, _clock, _idle) = tide(0);
        for _ in 0..(MAX_QUEUE + 1) {
            tide.push(CuePayload::new("glow"));
        }
        let released = tide.flush();
        assert_eq!(released.last().unwrap().msg.as_deref(), Some("+1 more update"));
    }

    #[test]
    fn cues_are_released_oldest_first() {
        let (mut tide, _clock, _idle) = tide(0);
        tide.push(CuePayload::new("glow").msg("first"));
        tide.push(CuePayload::new("glow").msg("second"));

        let released = tide.flush();
        assert_eq!(released[0].msg.as_deref(), Some("first"));
        assert_eq!(released[1].msg.as_deref(), Some("second"));
    }

    #[test]
    fn ticking_an_empty_queue_is_a_no_op() {
        let (mut tide, _clock, _idle) = tide(0);
        assert!(tide.tick().is_empty());
    }

    #[test]
    fn clear_drops_everything_without_delivering() {
        let (mut tide, _clock, _idle) = tide(0);
        tide.push(CuePayload::new("glow"));
        tide.clear();
        assert_eq!(tide.size(), 0);
        assert!(tide.flush().is_empty());
    }
}

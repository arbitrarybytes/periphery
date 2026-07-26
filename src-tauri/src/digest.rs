//! Digest bookkeeping: what arrived while the user was focused (end-of-focus
//! digest) or locked ("while you were away"). Port of `utils/digest.js`.

use crate::clock::Clock;
use crate::cue::CuePayload;
use serde::Serialize;
use std::sync::Arc;

/// Most entries a digest keeps; beyond this the oldest are dropped but counted.
pub const DIGEST_MAX_ENTRIES: usize = 50;
/// A lock shorter than this is a coffee refill, not an absence worth a summary.
pub const AWAY_THRESHOLD_MS: u64 = 30 * 60_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DigestEntry {
    pub msg: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Digest {
    pub entries: Vec<DigestEntry>,
    pub total: usize,
}

pub struct DigestLog {
    clock: Arc<dyn Clock>,
    entries: Vec<DigestEntry>,
    /// Entries dropped once full; still reported in the total.
    dropped: usize,
    max_entries: usize,
}

impl DigestLog {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            entries: Vec::new(),
            dropped: 0,
            max_entries: DIGEST_MAX_ENTRIES,
        }
    }

    #[cfg(test)]
    pub fn with_max(mut self, max_entries: usize) -> Self {
        self.max_entries = max_entries;
        self
    }

    /// Records one delivered-or-held cue. Payloads are already validated, so
    /// the fields are trusted here.
    pub fn add(&mut self, payload: &CuePayload) {
        if self.entries.len() >= self.max_entries {
            self.entries.remove(0);
            self.dropped += 1;
        }
        self.entries.push(DigestEntry {
            msg: payload.msg.clone(),
            icon: payload.icon.clone(),
            color: payload.color.clone(),
            at: self.clock.now_ms(),
        });
    }

    pub fn size(&self) -> usize {
        self.entries.len() + self.dropped
    }

    /// Returns everything recorded and resets the log.
    pub fn drain(&mut self) -> Digest {
        let total = self.size();
        let entries = std::mem::take(&mut self.entries);
        self.dropped = 0;
        Digest { entries, total }
    }
}

/// Tracks screen locks so an unlock after a long absence can be greeted with a
/// "while you were away" digest instead of nothing.
pub struct AwayTracker {
    clock: Arc<dyn Clock>,
    locked_at: Option<u64>,
    threshold_ms: u64,
}

/// Whether a lock was long enough to count as an absence.
#[derive(Debug, PartialEq)]
pub struct Absence {
    pub away: bool,
    pub away_ms: u64,
}

impl AwayTracker {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            locked_at: None,
            threshold_ms: AWAY_THRESHOLD_MS,
        }
    }

    #[cfg(test)]
    pub fn with_threshold(mut self, threshold_ms: u64) -> Self {
        self.threshold_ms = threshold_ms;
        self
    }

    pub fn lock(&mut self) {
        // A second lock event without an unlock keeps the original timestamp.
        if self.locked_at.is_none() {
            self.locked_at = Some(self.clock.now_ms());
        }
    }

    pub fn is_locked(&self) -> bool {
        self.locked_at.is_some()
    }

    pub fn unlock(&mut self) -> Absence {
        let Some(locked_at) = self.locked_at.take() else {
            return Absence {
                away: false,
                away_ms: 0,
            };
        };
        let away_ms = self.clock.now_ms().saturating_sub(locked_at);
        Absence {
            away: away_ms >= self.threshold_ms,
            away_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::TestClock;

    #[test]
    fn records_message_icon_colour_and_time_then_drain_resets() {
        let clock = TestClock::new();
        let mut log = DigestLog::new(Arc::new(clock.clone()));

        clock.set(1_000);
        log.add(
            &CuePayload::new("glow")
                .msg("Pipeline passed")
                .icon("gitlab")
                .color("red"),
        );
        clock.set(2_000);
        log.add(&CuePayload::new("glow")); // a cue with no message still counts

        let digest = log.drain();
        assert_eq!(digest.total, 2);
        assert_eq!(
            digest.entries[0],
            DigestEntry {
                msg: Some("Pipeline passed".into()),
                icon: Some("gitlab".into()),
                color: Some("red".into()),
                at: 1_000,
            }
        );
        assert_eq!(digest.entries[1].msg, None);

        assert_eq!(log.size(), 0, "drain must reset the log");
        assert_eq!(log.drain().total, 0);
    }

    #[test]
    fn caps_entries_but_keeps_counting_what_was_dropped() {
        let clock = TestClock::new();
        let mut log = DigestLog::new(Arc::new(clock)).with_max(3);
        for i in 0..5 {
            log.add(&CuePayload::new("glow").msg(format!("update {i}")));
        }

        assert_eq!(log.size(), 5);
        let digest = log.drain();
        assert_eq!(digest.total, 5, "the total includes dropped entries");
        assert_eq!(digest.entries.len(), 3);
        assert_eq!(
            digest.entries[0].msg.as_deref(),
            Some("update 2"),
            "the oldest entries are the ones dropped"
        );
    }

    #[test]
    fn a_short_lock_is_not_an_absence() {
        let clock = TestClock::new();
        let mut tracker = AwayTracker::new(Arc::new(clock.clone())).with_threshold(1_000);

        tracker.lock();
        clock.set(999);
        assert_eq!(
            tracker.unlock(),
            Absence {
                away: false,
                away_ms: 999
            }
        );
    }

    #[test]
    fn a_long_lock_is_an_absence_and_unlock_resets() {
        let clock = TestClock::new();
        let mut tracker = AwayTracker::new(Arc::new(clock.clone())).with_threshold(1_000);

        tracker.lock();
        assert!(tracker.is_locked());
        clock.set(5_000);
        assert_eq!(
            tracker.unlock(),
            Absence {
                away: true,
                away_ms: 5_000
            }
        );
        assert!(!tracker.is_locked());
        assert_eq!(
            tracker.unlock(),
            Absence {
                away: false,
                away_ms: 0
            },
            "a stray unlock event is harmless"
        );
    }

    #[test]
    fn a_duplicate_lock_event_keeps_the_original_timestamp() {
        let clock = TestClock::new();
        let mut tracker = AwayTracker::new(Arc::new(clock.clone())).with_threshold(1_000);

        tracker.lock();
        clock.set(900);
        tracker.lock();
        clock.set(1_100);
        assert!(
            tracker.unlock().away,
            "the absence is measured from the first lock"
        );
    }
}

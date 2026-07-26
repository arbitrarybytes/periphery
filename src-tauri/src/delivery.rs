//! The attention-aware delivery pipeline. Port of the routing half of `main.js`.
//!
//! Every cue, from any source, passes through the same gauntlet:
//!
//! ```text
//! validate → blocked? → focus hold (constellation) → slack tide → broadcast
//! ```
//!
//! Only tier 1 goes straight through. The ordering is the product: a cue that
//! skipped the focus check would interrupt exactly when the user asked not to
//! be, and one that skipped the tide would land mid-keystroke.
//!
//! Validation happens here, once, so every source — webhook, connector, CLI,
//! MCP — is equally safe.

use crate::blocked::BlockedTracker;
use crate::clock::{Clock, IdleSource};
use crate::cue::{CuePayload, ResolveRequest, clamp_repeats, glow_speed_factor, sanitize_cue_payload};
use crate::digest::{AwayTracker, DigestLog};
use crate::slack_tide::SlackTide;
use crate::store::ConfigStore;
use crate::tiers::{HeldCue, cue_tier, should_defer};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// How many stars the constellation shows before the oldest rolls off.
pub const CONSTELLATION_MAX: usize = 24;

/// Everything the overlay is told about, in one place. The shell turns these
/// into Tauri events; keeping them as data makes the pipeline testable without
/// a running app.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "channel", content = "payload", rename_all = "kebab-case")]
pub enum Outbound {
    /// Draw a cue. Enriched with the user's display preferences.
    TriggerCue(Value),
    /// The held-cue starfield. An empty list fades the stars out.
    Constellation(Value),
    /// Blocked-agent state: count and escalation level. Zero fades it out.
    BlockedAgents(Value),
    /// End-of-focus or "while you were away" panel content.
    Digest(Value),
}

/// Focus state, from the three independent sources that can assert it.
#[derive(Debug, Default, Clone, Copy)]
pub struct FocusState {
    /// The user flipped focus mode on from the tray.
    pub manual: bool,
    /// Windows reports Do Not Disturb / presentation / full-screen.
    pub detected_dnd: bool,
    /// Teams presence says in-a-call, presenting, or DND.
    pub teams_dnd: bool,
}

pub struct Pipeline {
    pub config: ConfigStore,
    pub blocked: BlockedTracker,
    pub tide: SlackTide,
    pub focus_digest: DigestLog,
    pub away_log: DigestLog,
    pub away: AwayTracker,
    pub focus: FocusState,
    held: Vec<HeldCue>,
    held_total: usize,
}

impl Pipeline {
    pub fn new(config: ConfigStore, clock: Arc<dyn Clock>, idle: Arc<dyn IdleSource>) -> Self {
        Self {
            config,
            blocked: BlockedTracker::new(Arc::clone(&clock)),
            tide: SlackTide::new(Arc::clone(&clock), idle),
            focus_digest: DigestLog::new(Arc::clone(&clock)),
            away_log: DigestLog::new(Arc::clone(&clock)),
            away: AwayTracker::new(clock),
            focus: FocusState::default(),
            held: Vec::new(),
            held_total: 0,
        }
    }

    /// Whether cues below tier 1 should be held right now.
    ///
    /// Each source is gated by its own toggle, so a user who never opted into
    /// Teams presence cannot have it silently hold their cues.
    pub fn is_focused(&self) -> bool {
        self.focus.manual
            || (self.config.get_bool("respectFocusAssist", true) && self.focus.detected_dnd)
            || (self.config.get_bool("teamsPresenceEnabled", false) && self.focus.teams_dnd)
    }

    pub fn constellation(&self) -> Value {
        json!({ "stars": self.held, "total": self.held_total })
    }

    pub fn held_count(&self) -> usize {
        self.held_total
    }

    /// Routes a cue from any source. Returns whatever the overlay must be told.
    pub fn deliver(&mut self, raw: &Value) -> Vec<Outbound> {
        let Some(payload) = sanitize_cue_payload(raw) else {
            return Vec::new();
        };

        if payload.cue == "glow-blocked" {
            return self.deliver_blocked(payload);
        }

        let held_by_focus = should_defer(&payload, self.is_focused());
        // Agent beacons skip the tide: they persist until acknowledged, so
        // waiting for a typing pause adds delay without reducing interruption.
        if !held_by_focus
            && cue_tier(&payload) >= 2
            && payload.cue != "glow-agent"
            && self.config.get_bool("slackTideEnabled", true)
        {
            // push() returns Some only when the user is already pausing.
            return match self.tide.push(payload) {
                Some(ready) => self.deliver_final(ready),
                None => Vec::new(),
            };
        }
        self.deliver_final(payload)
    }

    /// Releases anything the tide has been holding. Called on a timer.
    pub fn tick(&mut self) -> Vec<Outbound> {
        let mut out = Vec::new();
        for payload in self.tide.tick() {
            out.extend(self.deliver_final(payload));
        }
        // Escalation and expiry are age-driven, so they need a tick too.
        if self.blocked.tick() {
            out.push(Outbound::BlockedAgents(
                serde_json::to_value(self.blocked.state()).unwrap_or(Value::Null),
            ));
        }
        out
    }

    /// Final delivery: hold for the constellation while focused, broadcast
    /// otherwise. Also the tide's release path, so focus is re-checked for a
    /// cue that was queued before focus mode began.
    fn deliver_final(&mut self, payload: CuePayload) -> Vec<Outbound> {
        // While the screen is locked, remember what went by for the away
        // summary. The cue still broadcasts — a locked screen just can't show it.
        if self.away.is_locked() && self.config.get_bool("awaySummaryEnabled", true) {
            self.away_log.add(&payload);
        }

        if should_defer(&payload, self.is_focused()) {
            self.hold_for_constellation(payload)
        } else {
            vec![self.broadcast(payload)]
        }
    }

    /// Held cues do not vanish into a counter: each leaves a dim star, so a
    /// glance shows *how much* accumulated without showing *what*, which is
    /// the part that would break flow.
    fn hold_for_constellation(&mut self, payload: CuePayload) -> Vec<Outbound> {
        self.held_total += 1;
        self.held.push(HeldCue {
            color: payload.color.clone(),
            icon: payload.icon.clone(),
        });
        if self.held.len() > CONSTELLATION_MAX {
            self.held.remove(0);
        }
        self.focus_digest.add(&payload);
        vec![Outbound::Constellation(self.constellation())]
    }

    /// Enriches a cue with display preferences and hands it to the overlay.
    fn broadcast(&mut self, payload: CuePayload) -> Outbound {
        let mut out = payload;
        if out.cue == "glow-agent" && !self.config.get_bool("agentCuesEnabled", true) {
            // Toggle off: agent cues downgrade to a plain edge glow rather than
            // disappearing. The notification still happens, just unstickied.
            out.cue = "glow".to_string();
        }

        let mut value = serde_json::to_value(&out).unwrap_or_else(|_| json!({}));
        if let Some(map) = value.as_object_mut() {
            map.insert(
                "repeats".into(),
                json!(clamp_repeats(self.config.get("glowRepeats"))),
            );
            map.insert(
                "speedFactor".into(),
                json!(glow_speed_factor(self.config.get("glowSpeed"))),
            );
            map.insert(
                "verbose".into(),
                json!(self.config.get_bool("verboseMode", true)),
            );
        }
        Outbound::TriggerCue(value)
    }

    /// A blocked agent is a *state*, not an event: it persists until resolved
    /// and gets more insistent with age. It also bypasses the constellation —
    /// holding it would defeat the point of a cue that exists to be noticed.
    fn deliver_blocked(&mut self, payload: CuePayload) -> Vec<Outbound> {
        if !self.config.get_bool("blockedCuesEnabled", true) {
            // Toggle off: fall back to a one-shot edge glow so the information
            // is not lost, just not made persistent.
            let mut downgraded = payload;
            downgraded.cue = "glow".to_string();
            return vec![self.broadcast(downgraded)];
        }

        // A blocked agent is wasting time right now, so by default it is the
        // one thing allowed through focus mode.
        if self.is_focused() && !self.config.get_bool("blockedPiercesFocus", true) {
            return self.hold_for_constellation(payload);
        }

        self.blocked.block(&payload);
        vec![Outbound::BlockedAgents(
            serde_json::to_value(self.blocked.state()).unwrap_or(Value::Null),
        )]
    }

    /// Clears one blocked agent or all of them. Returns how many were cleared
    /// alongside the overlay update.
    pub fn resolve(&mut self, request: &ResolveRequest) -> (usize, Vec<Outbound>) {
        let cleared = if request.all {
            self.blocked.resolve_all()
        } else {
            match request.r#ref.as_deref() {
                Some(r) if self.blocked.resolve(r) => 1,
                _ => 0,
            }
        };

        let out = vec![Outbound::BlockedAgents(
            serde_json::to_value(self.blocked.state()).unwrap_or(Value::Null),
        )];
        (cleared, out)
    }

    /// Focus mode ended: dissolve the stars into one quiet summary.
    pub fn end_focus(&mut self) -> Vec<Outbound> {
        let mut out = vec![Outbound::Constellation(json!({ "stars": [], "total": 0 }))];
        let digest = self.focus_digest.drain();
        self.held.clear();
        self.held_total = 0;

        if self.config.get_bool("digestEnabled", true) && digest.total > 0 {
            out.push(Outbound::Digest(
                serde_json::to_value(&digest).unwrap_or(Value::Null),
            ));
        }
        // Anything the tide was holding is released rather than stranded.
        for payload in self.tide.flush() {
            out.extend(self.deliver_final(payload));
        }
        out
    }
}

/// Shared handle. A single lock guards the whole pipeline: the stages are
/// ordered and interdependent, so finer-grained locking would buy nothing but
/// a chance to interleave them wrongly.
pub type Shared = Arc<Mutex<Pipeline>>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{TestClock, TestIdle};

    fn pipeline() -> (Pipeline, TestClock, TestIdle) {
        let clock = TestClock::new();
        // Idle enough that the slack tide releases immediately unless a test
        // says otherwise; the tide's own behaviour is covered in its module.
        let idle = TestIdle::new(30);
        let dir = std::env::temp_dir().join(format!(
            "periphery-pipe-{}",
            format!("{:?}", std::thread::current().id())
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .collect::<String>()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let config = ConfigStore::new(dir.join("config.json"));
        let p = Pipeline::new(
            config,
            Arc::new(clock.clone()),
            Arc::new(idle.clone()),
        );
        (p, clock, idle)
    }

    fn cue(name: &str) -> Value {
        json!({ "cue": name, "msg": "hello" })
    }

    fn is_trigger(o: &Outbound) -> bool {
        matches!(o, Outbound::TriggerCue(_))
    }

    #[test]
    fn a_valid_cue_reaches_the_overlay_with_display_preferences_attached() {
        let (mut p, _, _) = pipeline();
        let out = p.deliver(&cue("glow"));

        assert_eq!(out.len(), 1);
        let Outbound::TriggerCue(value) = &out[0] else {
            panic!("expected a cue");
        };
        assert_eq!(value["cue"], json!("glow"));
        assert_eq!(value["repeats"], json!(3));
        assert_eq!(value["verbose"], json!(true));
        assert!(value["speedFactor"].as_f64().is_some());
    }

    #[test]
    fn an_invalid_payload_produces_nothing_at_all() {
        let (mut p, _, _) = pipeline();
        assert!(p.deliver(&json!({ "cue": "nuclear-siren" })).is_empty());
        assert!(p.deliver(&json!({ "msg": "no cue field" })).is_empty());
    }

    #[test]
    fn focus_holds_tier_2_as_a_star_but_lets_tier_1_through() {
        let (mut p, _, _) = pipeline();
        p.focus.manual = true;

        let held = p.deliver(&cue("glow"));
        assert!(matches!(held[0], Outbound::Constellation(_)));
        assert_eq!(p.constellation()["total"], json!(1));

        let urgent = p.deliver(&json!({ "cue": "comet", "msg": "sev-1" }));
        assert!(is_trigger(&urgent[0]), "tier 1 outranks focus mode");
    }

    #[test]
    fn detected_dnd_only_holds_cues_while_the_toggle_allows_it() {
        let (mut p, _, _) = pipeline();
        p.focus.detected_dnd = true;
        assert!(p.is_focused());

        p.config.set("respectFocusAssist", json!(false));
        assert!(!p.is_focused(), "the user opted out of Focus Assist");
    }

    #[test]
    fn teams_presence_cannot_hold_cues_unless_it_was_opted_into() {
        let (mut p, _, _) = pipeline();
        p.focus.teams_dnd = true;
        assert!(
            !p.is_focused(),
            "teamsPresenceEnabled defaults off, so presence must not gate cues"
        );

        p.config.set("teamsPresenceEnabled", json!(true));
        assert!(p.is_focused());
    }

    #[test]
    fn the_constellation_is_capped_but_the_total_keeps_counting() {
        let (mut p, _, _) = pipeline();
        p.focus.manual = true;
        for _ in 0..CONSTELLATION_MAX + 5 {
            p.deliver(&cue("glow"));
        }

        let state = p.constellation();
        assert_eq!(state["stars"].as_array().unwrap().len(), CONSTELLATION_MAX);
        assert_eq!(state["total"], json!(CONSTELLATION_MAX + 5));
    }

    #[test]
    fn ending_focus_clears_the_stars_and_emits_one_digest() {
        let (mut p, _, _) = pipeline();
        p.focus.manual = true;
        p.deliver(&cue("glow"));
        p.deliver(&cue("glow-bottom"));

        p.focus.manual = false;
        let out = p.end_focus();

        assert!(matches!(out[0], Outbound::Constellation(_)));
        assert_eq!(p.constellation()["total"], json!(0), "stars are dissolved");
        let digest = out.iter().find(|o| matches!(o, Outbound::Digest(_)));
        let Some(Outbound::Digest(value)) = digest else {
            panic!("focus ending must summarise what was held");
        };
        assert_eq!(value["total"], json!(2));
    }

    #[test]
    fn ending_focus_with_nothing_held_does_not_open_a_panel() {
        let (mut p, _, _) = pipeline();
        let out = p.end_focus();
        assert!(
            !out.iter().any(|o| matches!(o, Outbound::Digest(_))),
            "an empty digest would be a popup about nothing"
        );
    }

    #[test]
    fn a_blocked_agent_becomes_state_rather_than_a_one_shot_cue() {
        let (mut p, _, _) = pipeline();
        let out = p.deliver(&json!({
            "cue": "glow-blocked", "ref": "deploy-42", "msg": "Approve?"
        }));

        let Outbound::BlockedAgents(state) = &out[0] else {
            panic!("expected blocked state");
        };
        assert_eq!(state["count"], json!(1));
        assert_eq!(state["level"], json!(0), "it starts quiet and escalates");
    }

    #[test]
    fn a_blocked_agent_pierces_focus_because_it_is_burning_time_now() {
        let (mut p, _, _) = pipeline();
        p.focus.manual = true;
        let out = p.deliver(&json!({ "cue": "glow-blocked", "ref": "a" }));

        assert!(
            matches!(out[0], Outbound::BlockedAgents(_)),
            "waiting on approval outranks focus mode by default"
        );
    }

    #[test]
    fn blocked_cues_respect_the_pierce_toggle() {
        let (mut p, _, _) = pipeline();
        p.focus.manual = true;
        p.config.set("blockedPiercesFocus", json!(false));

        let out = p.deliver(&json!({ "cue": "glow-blocked", "ref": "a" }));
        assert!(
            matches!(out[0], Outbound::Constellation(_)),
            "the user asked for nothing to pierce focus"
        );
    }

    #[test]
    fn disabling_blocked_cues_downgrades_rather_than_discards() {
        let (mut p, _, _) = pipeline();
        p.config.set("blockedCuesEnabled", json!(false));

        let out = p.deliver(&json!({ "cue": "glow-blocked", "ref": "a", "msg": "Approve?" }));
        let Outbound::TriggerCue(value) = &out[0] else {
            panic!("expected a downgraded cue, not silence");
        };
        assert_eq!(value["cue"], json!("glow"));
        assert_eq!(p.blocked.count(), 0, "and nothing is tracked as state");
    }

    #[test]
    fn disabling_agent_cues_downgrades_the_beacon_to_a_plain_glow() {
        let (mut p, _, _) = pipeline();
        p.config.set("agentCuesEnabled", json!(false));

        let out = p.deliver(&json!({ "cue": "glow-agent", "msg": "build done" }));
        let Outbound::TriggerCue(value) = &out[0] else {
            panic!("expected a cue");
        };
        assert_eq!(value["cue"], json!("glow"));
    }

    #[test]
    fn resolving_reports_how_many_were_cleared_and_updates_the_overlay() {
        let (mut p, _, _) = pipeline();
        p.deliver(&json!({ "cue": "glow-blocked", "ref": "a" }));
        p.deliver(&json!({ "cue": "glow-blocked", "ref": "b" }));

        let (cleared, out) = p.resolve(&ResolveRequest {
            r#ref: Some("a".into()),
            all: false,
        });
        assert_eq!(cleared, 1);
        let Outbound::BlockedAgents(state) = &out[0] else {
            panic!("expected blocked state");
        };
        assert_eq!(state["count"], json!(1));

        let (cleared_all, _) = p.resolve(&ResolveRequest {
            r#ref: None,
            all: true,
        });
        assert_eq!(cleared_all, 1);
    }

    #[test]
    fn resolving_something_that_was_never_blocked_is_honest() {
        let (mut p, _, _) = pipeline();
        let (cleared, _) = p.resolve(&ResolveRequest {
            r#ref: Some("ghost".into()),
            all: false,
        });
        assert_eq!(cleared, 0);
    }

    #[test]
    fn a_cue_arriving_mid_burst_is_held_by_the_tide_then_released_on_tick() {
        let clock = TestClock::new();
        let idle = TestIdle::new(0); // actively typing
        let dir = std::env::temp_dir().join("periphery-pipe-tide");
        let _ = std::fs::remove_dir_all(&dir);
        let mut p = Pipeline::new(
            ConfigStore::new(dir.join("config.json")),
            Arc::new(clock.clone()),
            Arc::new(idle.clone()),
        );

        assert!(p.deliver(&cue("glow")).is_empty(), "held mid-keystroke");

        idle.set(10); // the user pauses
        clock.advance(1_000);
        let out = p.tick();
        assert!(is_trigger(&out[0]), "released in the next natural pause");
    }

    #[test]
    fn the_tide_is_bypassed_when_the_user_switched_it_off() {
        let clock = TestClock::new();
        let idle = TestIdle::new(0);
        let dir = std::env::temp_dir().join("periphery-pipe-notide");
        let _ = std::fs::remove_dir_all(&dir);
        let mut config = ConfigStore::new(dir.join("config.json"));
        config.set("slackTideEnabled", json!(false));
        let mut p = Pipeline::new(config, Arc::new(clock), Arc::new(idle));

        let out = p.deliver(&cue("glow"));
        assert!(is_trigger(&out[0]), "no holding when the tide is off");
    }

    #[test]
    fn cues_that_arrive_while_locked_are_remembered_for_the_away_summary() {
        let (mut p, clock, _) = pipeline();
        p.away.lock();
        p.deliver(&cue("glow"));

        // Long enough to count as a real absence rather than a screen blank.
        clock.advance(31 * 60_000);
        let absence = p.away.unlock();
        assert!(absence.away, "a 31-minute lock is an absence");
        assert_eq!(p.away_log.size(), 1, "and the cue was logged for the summary");
    }
}

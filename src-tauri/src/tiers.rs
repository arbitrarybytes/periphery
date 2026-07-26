//! The Attention Hierarchy: which cues break flow, which are held, and what
//! the end-of-focus summary says. Port of `utils/win11.js` (the accent-colour
//! helpers live in `theme.rs`, the DND probe in `focus.rs`).

use crate::cue::{CuePayload, MSG_MAX_LENGTH};
use std::collections::BTreeMap;

/// Attention tier per cue, mirroring the README's Attention Hierarchy.
/// Tier 1 breaks through focus mode; tiers 2-3 are deferred while focused.
pub fn cue_tier(payload: &CuePayload) -> u8 {
    // `urgent` is the explicit, validated escalation knob (time-critical cues
    // like meeting reminders); it outranks whatever the cue name implies.
    if payload.urgent {
        return 1;
    }
    match payload.cue.as_str() {
        "comet" => 1,
        "glow-pulse" | "glow" => 2,
        // Agent completions are awareness-class; persistence, not urgency, is
        // what makes them hard to miss.
        "glow-agent" => 2,
        // A blocked agent earns its insistence by *aging*, not by arriving.
        "glow-blocked" => 2,
        "glow-bottom" => 3,
        _ => 2,
    }
}

/// Whether the cue should be held until focus ends.
pub fn should_defer(payload: &CuePayload, focused: bool) -> bool {
    focused && cue_tier(payload) >= 2
}

/// Tallies held cues by their source icon for the flush summary.
pub fn count_held_icons(held: &[HeldCue]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for cue in held {
        let key = cue.icon.clone().unwrap_or_else(|| "other".to_string());
        *counts.entry(key).or_insert(0) += 1;
    }
    counts
}

/// One cue held during focus, rendered as a constellation star.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HeldCue {
    pub color: Option<String>,
    pub icon: Option<String>,
}

/// The single ambient cue flushed when focus ends and cues were held.
pub fn deferred_summary_cue(
    count: usize,
    color: &str,
    icon_counts: Option<&BTreeMap<String, usize>>,
) -> CuePayload {
    let mut msg = if count == 1 {
        "1 update arrived while you were focused".to_string()
    } else {
        format!("{count} updates arrived while you were focused")
    };

    if let Some(counts) = icon_counts {
        let parts: Vec<String> = counts
            .iter()
            .filter(|(_, n)| **n > 0)
            .map(|(icon, n)| format!("{icon} {n}"))
            .collect();
        if !parts.is_empty() {
            msg.push_str(&format!(" — {}", parts.join(", ")));
        }
    }

    let msg: String = msg.chars().take(MSG_MAX_LENGTH).collect();
    CuePayload::new("glow-bottom").color(color).msg(msg).icon("alert")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cue::sanitize_cue_payload;
    use serde_json::json;

    fn cue(name: &str) -> CuePayload {
        CuePayload::new(name)
    }

    #[test]
    fn tiers_match_the_attention_hierarchy() {
        assert_eq!(cue_tier(&cue("comet")), 1);
        assert_eq!(cue_tier(&cue("glow")), 2);
        assert_eq!(cue_tier(&cue("glow-pulse")), 2);
        assert_eq!(cue_tier(&cue("glow-agent")), 2);
        assert_eq!(cue_tier(&cue("glow-blocked")), 2);
        assert_eq!(cue_tier(&cue("glow-bottom")), 3);
    }

    #[test]
    fn urgent_outranks_the_cue_name() {
        assert_eq!(cue_tier(&cue("glow-bottom").urgent()), 1);
        assert!(!should_defer(&cue("glow-bottom").urgent(), true));
    }

    #[test]
    fn only_tier_1_survives_focus_mode() {
        assert!(!should_defer(&cue("comet"), true));
        assert!(should_defer(&cue("glow"), true));
        assert!(should_defer(&cue("glow-bottom"), true));
        // Nothing is deferred when focus is off.
        assert!(!should_defer(&cue("glow-bottom"), false));
    }

    #[test]
    fn held_icons_are_tallied_with_an_other_bucket() {
        let held = vec![
            HeldCue { color: None, icon: Some("gitlab".into()) },
            HeldCue { color: None, icon: Some("gitlab".into()) },
            HeldCue { color: None, icon: Some("outlook".into()) },
            HeldCue { color: None, icon: None },
        ];
        let counts = count_held_icons(&held);
        assert_eq!(counts.get("gitlab"), Some(&2));
        assert_eq!(counts.get("outlook"), Some(&1));
        assert_eq!(counts.get("other"), Some(&1));
    }

    #[test]
    fn the_summary_is_a_valid_payload_with_correct_pluralisation() {
        let one = deferred_summary_cue(1, "rgba(0, 103, 192, 0.7)", None);
        assert!(one.msg.as_ref().unwrap().starts_with("1 update arrived"));

        let many = deferred_summary_cue(5, "rgba(0, 103, 192, 0.7)", None);
        assert!(many.msg.as_ref().unwrap().starts_with("5 updates arrived"));

        // It must survive the same validator every untrusted cue faces.
        let json = serde_json::to_value(&many).unwrap();
        assert!(sanitize_cue_payload(&json).is_some());
    }

    #[test]
    fn the_summary_includes_a_per_source_breakdown_and_stays_within_the_cap() {
        let mut counts = BTreeMap::new();
        counts.insert("gitlab".to_string(), 3usize);
        counts.insert("outlook".to_string(), 2usize);
        let summary = deferred_summary_cue(5, "rgba(0, 103, 192, 0.7)", Some(&counts));
        let msg = summary.msg.as_ref().unwrap();
        assert!(msg.contains("gitlab 3"));
        assert!(msg.contains("outlook 2"));

        let mut huge = BTreeMap::new();
        for i in 0..40 {
            huge.insert(format!("source{i}"), 1usize);
        }
        let big = deferred_summary_cue(40, "rgba(0, 103, 192, 0.7)", Some(&huge));
        assert!(big.msg.unwrap().chars().count() <= MSG_MAX_LENGTH);
    }

    #[test]
    fn a_validated_urgent_payload_keeps_its_tier_through_serialisation() {
        let payload =
            sanitize_cue_payload(&json!({"cue": "glow-pulse", "urgent": true})).unwrap();
        assert_eq!(cue_tier(&payload), 1);
    }
}

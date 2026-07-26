//! Validation for cue payloads arriving from untrusted sources (the local
//! webhook receiver). Port of `utils/cuePayload.js`.
//!
//! The frontend builds CSS values and image sources out of these fields, so
//! every one of them is checked against an allowlist rather than sanitised.
//! Nothing here touches Tauri, so it stays unit-testable in isolation.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Cue names accepted by the frontend. `cue-<name>` must exist in styles.css.
pub const CUE_NAMES: &[&str] = &[
    "glow",
    "glow-bottom",
    "glow-pulse",
    "glow-agent",
    "glow-blocked",
    "comet",
];

/// Cues that carry *state* rather than announcing an event: they are set by a
/// source and cleared by it (or by the user), instead of expiring on a timer.
pub const STATE_CUES: &[&str] = &["glow-blocked"];

/// Bundled icons, resolved by the frontend to `assets/icons/<name>.svg`.
/// An allowlist of local files means a payload can never point at a remote URL.
pub const ICON_NAMES: &[&str] = &[
    "gitlab", "github", "outlook", "calendar", "pomodoro", "alert", "agent", "blocked",
];

pub const MSG_MAX_LENGTH: usize = 160;
pub const REF_MAX_LENGTH: usize = 64;

pub const REPEATS_MIN: i64 = 1;
pub const REPEATS_MAX: i64 = 10;
pub const REPEATS_DEFAULT: i64 = 3;

/// Glow-speed setting: 1 (tortoise) .. 5 (hare).
pub const GLOW_SPEED_MIN: i64 = 1;
pub const GLOW_SPEED_MAX: i64 = 5;
pub const GLOW_SPEED_DEFAULT: i64 = 3;
/// Animation-duration multiplier per speed level. Index = level - 1.
const GLOW_SPEED_FACTORS: [f64; 5] = [2.0, 1.4, 1.0, 0.7, 0.45];

const NAMED_COLORS: &[&str] = &[
    "red", "green", "blue", "orange", "yellow", "purple", "cyan", "magenta", "white", "black",
    "gray", "grey", "teal", "pink", "lime", "gold", "silver",
];

/// A validated cue, safe to hand to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CuePayload {
    pub cue: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Highest attention tier: pierces focus mode and skips the typing-pause hold.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub urgent: bool,
    /// Correlation id for state cues, so the source can clear what it set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
}

impl CuePayload {
    /// A cue built in-process (connectors, summaries), bypassing validation
    /// because the fields are ours rather than an untrusted caller's.
    pub fn new(cue: &str) -> Self {
        Self {
            cue: cue.to_string(),
            ..Default::default()
        }
    }

    pub fn color(mut self, color: &str) -> Self {
        self.color = Some(color.to_string());
        self
    }

    pub fn msg(mut self, msg: impl Into<String>) -> Self {
        self.msg = Some(msg.into());
        self
    }

    pub fn icon(mut self, icon: &str) -> Self {
        self.icon = Some(icon.to_string());
        self
    }

    pub fn urgent(mut self) -> Self {
        self.urgent = true;
        self
    }

    pub fn is_state_cue(&self) -> bool {
        STATE_CUES.contains(&self.cue.as_str())
    }
}

/// A request to clear a state cue.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolveRequest {
    pub r#ref: Option<String>,
    pub all: bool,
}

/// A colour is only accepted if it parses as an exact hex / rgb() / rgba()
/// literal or a known keyword. Anything else could smuggle extra declarations
/// into the inline style the frontend builds (e.g. a `url()` that phones home).
pub fn is_valid_color(value: &str) -> bool {
    let color = value.trim();
    if color.is_empty() || color.len() > 32 {
        return false;
    }
    if is_hex_color(color) {
        return true;
    }
    if NAMED_COLORS.contains(&color.to_ascii_lowercase().as_str()) {
        return true;
    }
    is_rgb_color(color)
}

fn is_hex_color(color: &str) -> bool {
    let Some(digits) = color.strip_prefix('#') else {
        return false;
    };
    matches!(digits.len(), 3 | 4 | 6 | 8) && digits.chars().all(|c| c.is_ascii_hexdigit())
}

/// Parses `rgb(r, g, b)` / `rgba(r, g, b, a)` with the same bounds as the JS
/// original: channels 0-255, alpha 0-1.
fn is_rgb_color(color: &str) -> bool {
    let lower = color.to_ascii_lowercase();
    let body = match (lower.strip_prefix("rgba("), lower.strip_prefix("rgb(")) {
        (Some(rest), _) => rest,
        (None, Some(rest)) => rest,
        _ => return false,
    };
    let Some(body) = body.strip_suffix(')') else {
        return false;
    };

    let parts: Vec<&str> = body.split(',').map(str::trim).collect();
    if parts.len() != 3 && parts.len() != 4 {
        return false;
    }
    // rgb() with an alpha, or rgba() without one, are both malformed.
    if (parts.len() == 4) != lower.starts_with("rgba(") {
        return false;
    }

    for channel in &parts[..3] {
        if channel.is_empty() || channel.len() > 3 || !channel.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        match channel.parse::<u32>() {
            Ok(n) if n <= 255 => {}
            _ => return false,
        }
    }

    if parts.len() == 4 {
        let alpha = parts[3];
        if alpha.is_empty()
            || !alpha
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.')
        {
            return false;
        }
        match alpha.parse::<f64>() {
            Ok(a) if (0.0..=1.0).contains(&a) => {}
            _ => return false,
        }
    }
    true
}

/// Control characters become spaces so a message cannot break the single-line
/// layout of the kinetic-typography pill.
pub fn sanitize_message(value: &str) -> Option<String> {
    let cleaned: String = value
        .chars()
        .map(|c| if c.is_control() || c == '\u{7f}' { ' ' } else { c })
        .collect();
    // Cap by characters, not bytes: slicing UTF-8 mid-codepoint would panic.
    let msg: String = cleaned.trim().chars().take(MSG_MAX_LENGTH).collect();
    let msg = msg.trim_end().to_string();
    if msg.is_empty() { None } else { Some(msg) }
}

/// Correlation ids are opaque printable tokens: used as map keys and echoed
/// back in payloads, never interpolated into markup or CSS.
pub fn is_valid_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= REF_MAX_LENGTH
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// Coerces untrusted input into a usable integer inside [min, max].
/// An absent or blank value means "use the default" — never let a null or an
/// empty string coerce to zero.
pub fn clamp_number(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    let num = match value {
        None | Some(Value::Null) => return fallback,
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.is_finite() => f,
            _ => return fallback,
        },
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return fallback;
            }
            match trimmed.parse::<f64>() {
                Ok(f) if f.is_finite() => f,
                _ => return fallback,
            }
        }
        _ => return fallback,
    };
    (num.round() as i64).clamp(min, max)
}

pub fn clamp_repeats(value: Option<&Value>) -> i64 {
    clamp_number(value, REPEATS_MIN, REPEATS_MAX, REPEATS_DEFAULT)
}

/// Maps a stored glow-speed level to its duration multiplier, clamping
/// garbage to Medium (1x).
pub fn glow_speed_factor(level: Option<&Value>) -> f64 {
    let clamped = clamp_number(level, GLOW_SPEED_MIN, GLOW_SPEED_MAX, GLOW_SPEED_DEFAULT);
    GLOW_SPEED_FACTORS[(clamped - 1) as usize]
}

/// Validates an inbound cue payload. Returns `None` when the payload is
/// unusable and the request should be rejected.
pub fn sanitize_cue_payload(raw: &Value) -> Option<CuePayload> {
    let obj = raw.as_object()?;

    let cue = obj.get("cue")?.as_str()?;
    if !CUE_NAMES.contains(&cue) {
        return None;
    }

    let mut payload = CuePayload::new(cue);

    if let Some(color) = obj.get("color").and_then(Value::as_str)
        && is_valid_color(color)
    {
        payload.color = Some(color.trim().to_string());
    }

    if let Some(msg) = obj.get("msg").and_then(Value::as_str) {
        payload.msg = sanitize_message(msg);
    }

    if let Some(icon) = obj.get("icon").and_then(Value::as_str)
        && ICON_NAMES.contains(&icon)
    {
        payload.icon = Some(icon.to_string());
    }

    // Urgency is an explicit, validated flag. Only the literal `true` counts.
    payload.urgent = obj.get("urgent") == Some(&Value::Bool(true));

    if let Some(r) = obj.get("ref").and_then(Value::as_str)
        && is_valid_ref(r)
    {
        payload.r#ref = Some(r.to_string());
    }

    Some(payload)
}

/// Validates a resolve request (clearing a state cue).
pub fn sanitize_resolve_payload(raw: &Value) -> Option<ResolveRequest> {
    let obj = raw.as_object()?;
    if obj.get("all") == Some(&Value::Bool(true)) {
        return Some(ResolveRequest {
            r#ref: None,
            all: true,
        });
    }
    let r = obj.get("ref")?.as_str()?;
    if !is_valid_ref(r) {
        return None;
    }
    Some(ResolveRequest {
        r#ref: Some(r.to_string()),
        all: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_a_well_formed_payload() {
        let payload = sanitize_cue_payload(&json!({
            "cue": "comet", "color": "rgba(0, 150, 255, 0.9)", "msg": "Hi", "icon": "gitlab"
        }))
        .unwrap();
        assert_eq!(payload.cue, "comet");
        assert_eq!(payload.color.as_deref(), Some("rgba(0, 150, 255, 0.9)"));
        assert_eq!(payload.msg.as_deref(), Some("Hi"));
        assert_eq!(payload.icon.as_deref(), Some("gitlab"));
        assert!(!payload.urgent);
    }

    #[test]
    fn rejects_payloads_without_a_known_cue() {
        assert!(sanitize_cue_payload(&json!({"cue": "nope"})).is_none());
        assert!(
            sanitize_cue_payload(&json!({"cue": "cue-glow"})).is_none(),
            "the cue- prefix is added by the frontend"
        );
        assert!(sanitize_cue_payload(&json!({})).is_none());
        assert!(sanitize_cue_payload(&Value::Null).is_none());
        assert!(sanitize_cue_payload(&json!("comet")).is_none());
    }

    #[test]
    fn strips_a_css_injecting_color() {
        let payload = sanitize_cue_payload(&json!({
            "cue": "comet", "color": "red; background: url(https://attacker.example/leak)"
        }))
        .unwrap();
        assert_eq!(payload.color, None);
    }

    #[test]
    fn strips_a_remote_icon_url() {
        let payload = sanitize_cue_payload(&json!({
            "cue": "comet", "icon": "https://attacker.example/pixel.png"
        }))
        .unwrap();
        assert_eq!(payload.icon, None);
    }

    #[test]
    fn accepts_the_colour_forms_the_app_actually_emits() {
        for color in [
            "#fff",
            "#ffffff",
            "#ffffffcc",
            "rgb(1, 2, 3)",
            "rgba(255, 122, 89, 0.9)",
            "rgba(0,150,255,.6)",
            "red",
            "TEAL",
        ] {
            assert!(is_valid_color(color), "{color} should be valid");
        }
    }

    #[test]
    fn rejects_malformed_colours() {
        for color in [
            "",
            "#ff",
            "#gggggg",
            "rgb(1, 2)",
            "rgb(1, 2, 3, 0.5)",
            "rgba(1, 2, 3)",
            "rgb(256, 0, 0)",
            "rgba(0, 0, 0, 2)",
            "url(x)",
            "rgb(1,2,3) ; color: red",
            "chartreuse",
        ] {
            assert!(!is_valid_color(color), "{color} should be rejected");
        }
    }

    #[test]
    fn messages_are_flattened_trimmed_and_capped() {
        assert_eq!(
            sanitize_message("  hello\nworld  ").as_deref(),
            Some("hello world")
        );
        assert_eq!(sanitize_message("   ").as_deref(), None);
        let long = "x".repeat(MSG_MAX_LENGTH + 40);
        assert_eq!(sanitize_message(&long).unwrap().chars().count(), MSG_MAX_LENGTH);
    }

    #[test]
    fn multibyte_messages_are_capped_without_panicking() {
        // Slicing UTF-8 by byte offset would panic mid-codepoint here.
        let long = "é".repeat(MSG_MAX_LENGTH + 20);
        assert_eq!(sanitize_message(&long).unwrap().chars().count(), MSG_MAX_LENGTH);
    }

    #[test]
    fn urgent_only_accepts_the_literal_true() {
        let urgent = sanitize_cue_payload(&json!({"cue": "glow", "urgent": true})).unwrap();
        assert!(urgent.urgent);
        for value in [json!("true"), json!(1), json!(Value::Null)] {
            let payload =
                sanitize_cue_payload(&json!({"cue": "glow", "urgent": value})).unwrap();
            assert!(!payload.urgent, "{value} must not escalate a cue");
        }
    }

    #[test]
    fn ref_accepts_opaque_tokens_and_rejects_anything_injectable() {
        assert!(is_valid_ref("agent-1"));
        assert!(is_valid_ref("claude:session.42_a"));
        assert!(!is_valid_ref(""));
        assert!(!is_valid_ref("has space"));
        assert!(!is_valid_ref("<script>"));
        assert!(!is_valid_ref(&"a".repeat(REF_MAX_LENGTH + 1)));
    }

    #[test]
    fn a_bad_ref_is_dropped_but_the_cue_still_shows() {
        let payload = sanitize_cue_payload(&json!({
            "cue": "glow-blocked", "ref": "no spaces allowed", "msg": "Approve?"
        }))
        .unwrap();
        assert_eq!(payload.r#ref, None);
        assert_eq!(payload.msg.as_deref(), Some("Approve?"));
    }

    #[test]
    fn resolve_payloads_accept_a_ref_or_all_and_nothing_else() {
        assert_eq!(
            sanitize_resolve_payload(&json!({"ref": "a"})),
            Some(ResolveRequest {
                r#ref: Some("a".into()),
                all: false
            })
        );
        assert_eq!(
            sanitize_resolve_payload(&json!({"all": true})),
            Some(ResolveRequest {
                r#ref: None,
                all: true
            })
        );
        assert!(sanitize_resolve_payload(&json!({})).is_none());
        assert!(
            sanitize_resolve_payload(&json!({"all": "yes"})).is_none(),
            "only the literal true counts"
        );
        assert!(sanitize_resolve_payload(&json!({"ref": "bad ref"})).is_none());
    }

    #[test]
    fn clamping_treats_blank_as_default_not_zero() {
        assert_eq!(clamp_repeats(None), REPEATS_DEFAULT);
        assert_eq!(clamp_repeats(Some(&json!(""))), REPEATS_DEFAULT);
        assert_eq!(clamp_repeats(Some(&Value::Null)), REPEATS_DEFAULT);
        assert_eq!(clamp_repeats(Some(&json!("nonsense"))), REPEATS_DEFAULT);
        assert_eq!(clamp_repeats(Some(&json!(0))), REPEATS_MIN);
        assert_eq!(clamp_repeats(Some(&json!(999))), REPEATS_MAX);
        assert_eq!(clamp_repeats(Some(&json!("4"))), 4);
    }

    #[test]
    fn glow_speed_maps_levels_to_multipliers() {
        assert_eq!(glow_speed_factor(Some(&json!(1))), 2.0);
        assert_eq!(glow_speed_factor(Some(&json!(3))), 1.0);
        assert_eq!(glow_speed_factor(Some(&json!(5))), 0.45);
        assert_eq!(glow_speed_factor(Some(&json!(99))), 0.45, "clamped");
        assert_eq!(glow_speed_factor(None), 1.0, "default is medium");
    }

    #[test]
    fn state_cues_are_declared_and_recognised() {
        assert_eq!(STATE_CUES, &["glow-blocked"]);
        assert!(CuePayload::new("glow-blocked").is_state_cue());
        assert!(!CuePayload::new("glow-agent").is_state_cue());
    }
}

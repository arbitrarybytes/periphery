//! The tray icon — which is the entire UI when nothing is happening.
//!
//! Port of the tray half of `main.js` plus `utils/trayBadge.js`.
//!
//! The tray has one job: be truthful at a glance. A tooltip that says what
//! Periphery is doing, and a status dot when something needs attention. The
//! badge priority is the interesting part and is deliberately ordered:
//!
//! > blocked > health > held
//!
//! A blocked agent is burning wall-clock time *now*. A broken poller means cues
//! are being **missed**, not merely deferred — so it outranks held cues, which
//! are working exactly as designed.

use serde::Serialize;

/// Dot diameter as a fraction of the icon's smaller side.
const DOT_SCALE: f64 = 0.5;

/// What the badge is telling the user, in priority order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Badge {
    /// An agent is waiting on approval. Coral.
    Blocked,
    /// A connector is failing — auth expired, rate limited. Amber.
    Health,
    /// Cues are being held by focus mode. The user's accent colour.
    Held,
}

impl Badge {
    /// RGB for the dot. `Held` has no fixed colour: it borrows the OS accent,
    /// so the affordance matches the cue it stands for.
    pub fn color(self, accent: (u8, u8, u8)) -> (u8, u8, u8) {
        match self {
            Badge::Blocked => (255, 122, 89),
            Badge::Health => (255, 176, 32),
            Badge::Held => accent,
        }
    }
}

/// What the tray should currently show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayState {
    pub tooltip: String,
    pub badge: Option<Badge>,
}

/// A failing connector, as the tray needs to describe it.
#[derive(Debug, Clone)]
pub struct HealthIssue {
    pub name: String,
    pub detail: Option<String>,
}

/// Computes tooltip and badge from the app's current state.
///
/// Pure, so the priority rules are testable without a tray — which matters
/// because getting them wrong is silent: the user simply never learns that
/// their token expired.
pub fn tray_state(
    focused: bool,
    held: usize,
    blocked: usize,
    health: &[HealthIssue],
    health_badge_enabled: bool,
) -> TrayState {
    let mut tooltip = if focused {
        if held > 0 {
            format!(
                "Periphery — focus mode, {held} update{} held",
                plural(held)
            )
        } else {
            "Periphery — focus mode".to_string()
        }
    } else {
        "Periphery — watching".to_string()
    };

    if blocked > 0 {
        tooltip.push_str(&format!(
            "\n{blocked} agent{} waiting for your approval",
            if blocked == 1 { " is" } else { "s are" }
        ));
    }

    let show_health = health_badge_enabled && !health.is_empty();
    if show_health {
        tooltip.push('\n');
        if health.len() == 1 {
            let issue = &health[0];
            tooltip.push_str(
                issue
                    .detail
                    .clone()
                    .unwrap_or_else(|| format!("{} needs attention", issue.name))
                    .as_str(),
            );
        } else {
            tooltip.push_str(&format!("{} connectors need attention", health.len()));
        }
    }

    let badge = if blocked > 0 {
        Some(Badge::Blocked)
    } else if show_health {
        Some(Badge::Health)
    } else if held > 0 {
        Some(Badge::Held)
    } else {
        None
    };

    TrayState { tooltip, badge }
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// Composites an opaque status dot into the bottom-right of an RGBA icon.
///
/// Port of `utils/trayBadge.js`. That version worked in the BGRA byte order
/// Electron hands back on Windows; Tauri's `Image` is RGBA, so the channel
/// order here is the natural one and the comment about swapped channels no
/// longer applies.
///
/// Returns `None` rather than panicking if the buffer does not match the given
/// dimensions: the badge is decoration, and must never be able to take the
/// tray icon down with it.
pub fn draw_badge_dot(
    rgba: &[u8],
    width: u32,
    height: u32,
    color: (u8, u8, u8),
) -> Option<Vec<u8>> {
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() != expected || width == 0 || height == 0 {
        return None;
    }

    let mut out = rgba.to_vec();
    let radius = (width.min(height) as f64 * DOT_SCALE) / 2.0;
    let cx = width as f64 - radius;
    let cy = height as f64 - radius;
    let (r, g, b) = color;

    for y in 0..height {
        for x in 0..width {
            let dx = x as f64 + 0.5 - cx;
            let dy = y as f64 + 0.5 - cy;
            let dist = dx.hypot(dy);
            if dist >= radius {
                continue;
            }

            // Feather the outer pixel, or the dot is visibly jagged at 16px.
            let cover = (radius - dist).min(1.0);
            let keep = 1.0 - cover;
            let i = ((y as usize * width as usize) + x as usize) * 4;
            let blend = |channel: u8, value: u8| -> u8 {
                (value as f64 * cover + channel as f64 * keep).round() as u8
            };
            out[i] = blend(out[i], r);
            out[i + 1] = blend(out[i + 1], g);
            out[i + 2] = blend(out[i + 2], b);
            out[i + 3] = blend(out[i + 3], 255);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(name: &str) -> HealthIssue {
        HealthIssue {
            name: name.into(),
            detail: None,
        }
    }

    #[test]
    fn an_idle_tray_says_so_and_shows_no_badge() {
        let state = tray_state(false, 0, 0, &[], true);
        assert_eq!(state.tooltip, "Periphery — watching");
        assert_eq!(state.badge, None);
    }

    #[test]
    fn focus_mode_reports_how_much_is_being_held() {
        assert_eq!(
            tray_state(true, 1, 0, &[], true).tooltip,
            "Periphery — focus mode, 1 update held"
        );
        assert_eq!(
            tray_state(true, 4, 0, &[], true).tooltip,
            "Periphery — focus mode, 4 updates held"
        );
        assert_eq!(
            tray_state(true, 0, 0, &[], true).tooltip,
            "Periphery — focus mode",
            "no count when nothing is held"
        );
    }

    #[test]
    fn held_cues_earn_the_accent_badge() {
        assert_eq!(tray_state(true, 3, 0, &[], true).badge, Some(Badge::Held));
    }

    #[test]
    fn a_failing_connector_outranks_held_cues() {
        // Held cues are the system working; a dead poller means cues are being
        // missed entirely, which the user cannot otherwise discover.
        let state = tray_state(true, 5, 0, &[issue("gitlab")], true);
        assert_eq!(state.badge, Some(Badge::Health));
        assert!(state.tooltip.contains("gitlab needs attention"));
    }

    #[test]
    fn a_blocked_agent_outranks_everything() {
        let state = tray_state(true, 5, 2, &[issue("gitlab")], true);
        assert_eq!(state.badge, Some(Badge::Blocked));
        assert!(state.tooltip.contains("2 agents are waiting for your approval"));
        assert!(
            state.tooltip.contains("gitlab"),
            "the tooltip still reports everything, only the dot is exclusive"
        );
    }

    #[test]
    fn one_blocked_agent_reads_as_singular() {
        let state = tray_state(false, 0, 1, &[], true);
        assert!(state.tooltip.contains("1 agent is waiting"));
    }

    #[test]
    fn a_connector_detail_is_preferred_over_a_generic_line() {
        let health = [HealthIssue {
            name: "github".into(),
            detail: Some("GitHub token expired".into()),
        }];
        assert!(
            tray_state(false, 0, 0, &health, true)
                .tooltip
                .contains("GitHub token expired")
        );
    }

    #[test]
    fn several_failing_connectors_collapse_to_a_count() {
        let health = [issue("gitlab"), issue("github"), issue("outlook")];
        let state = tray_state(false, 0, 0, &health, true);
        assert!(state.tooltip.contains("3 connectors need attention"));
    }

    #[test]
    fn disabling_the_health_badge_silences_the_dot_and_the_tooltip_line() {
        let state = tray_state(false, 0, 0, &[issue("gitlab")], false);
        assert_eq!(state.badge, None);
        assert!(
            !state.tooltip.contains("gitlab"),
            "the toggle must silence the whole affordance, not just the dot"
        );
    }

    #[test]
    fn the_badge_dot_lands_in_the_bottom_right_and_leaves_the_rest_alone() {
        let (w, h) = (16u32, 16u32);
        let base = vec![0u8; (w * h * 4) as usize];
        let out = draw_badge_dot(&base, w, h, (255, 122, 89)).expect("composite");

        let at = |x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            (out[i], out[i + 1], out[i + 2], out[i + 3])
        };
        // Centre of the dot: fully opaque, in the requested colour.
        let (r, g, b, a) = at(w - 4, h - 4);
        assert_eq!((r, g, b), (255, 122, 89));
        assert_eq!(a, 255);
        // The opposite corner must be untouched.
        assert_eq!(at(0, 0), (0, 0, 0, 0));
    }

    #[test]
    fn a_mismatched_buffer_is_refused_rather_than_panicking() {
        // The badge is decoration; a bad buffer must not take the tray down.
        assert!(draw_badge_dot(&[0u8; 10], 16, 16, (255, 0, 0)).is_none());
        assert!(draw_badge_dot(&[], 0, 0, (255, 0, 0)).is_none());
    }

    #[test]
    fn held_borrows_the_accent_while_the_others_are_fixed() {
        let accent = (56, 197, 255);
        assert_eq!(Badge::Held.color(accent), accent);
        assert_eq!(Badge::Blocked.color(accent), (255, 122, 89));
        assert_eq!(Badge::Health.color(accent), (255, 176, 32));
    }
}

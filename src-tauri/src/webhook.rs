//! The local cue receiver. Port of `server/webhookServer.js` from Express to
//! axum.
//!
//! Threat model, unchanged by the port: this listener is **unauthenticated by
//! design** so a shell script can fire a cue with one line of `curl`. That is
//! only safe because it is unreachable from anywhere but this machine. Three
//! things enforce that, and none of them may be relaxed:
//!
//! 1. It binds `127.0.0.1` — never `0.0.0.0`, so nothing off-box can connect.
//! 2. It rejects a non-loopback `Host` header, which blocks DNS rebinding
//!    (a page resolving `attacker.example` to 127.0.0.1 and posting here).
//! 3. It rejects any request carrying `Origin`, because local tooling never
//!    sends one and a browser always does.
//!
//! There is deliberately no CORS layer. The legitimate clients — scripts, the
//! CLI, coding agents — are unaffected by CORS; adding it would instead let any
//! page the user visits drive the overlay.

use crate::cue::{
    CUE_NAMES, CuePayload, ICON_NAMES, ResolveRequest, STATE_CUES, sanitize_cue_payload,
    sanitize_resolve_payload,
};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

pub const DEFAULT_PORT: u16 = 49123;
/// Loopback only. Never widen this: the receiver is unauthenticated by design.
pub const HOST: Ipv4Addr = Ipv4Addr::LOCALHOST;
/// A cue is a handful of short fields; anything larger is not one.
pub const BODY_LIMIT: usize = 8 * 1024;
/// Which shell is answering. See `ai-native/versioning.md`.
pub const EDITION: &str = "tauri";

/// Hostnames a genuine loopback client will send. Only the host is checked, not
/// the port: the request already arrived on our socket, so the port carries no
/// information.
const LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "[::1]", "::1"];

/// What the shell plugs into the receiver.
pub struct WebhookHandlers {
    /// Called with an already-validated payload.
    pub on_cue: Box<dyn Fn(CuePayload) + Send + Sync>,
    /// Clears a state cue (see [`STATE_CUES`]); returns how many were cleared.
    pub on_resolve: Box<dyn Fn(ResolveRequest) -> usize + Send + Sync>,
}

fn is_loopback_host(header: Option<&str>) -> bool {
    let Some(raw) = header else {
        return false;
    };
    let host = raw.trim().to_ascii_lowercase();
    // Strip the port, taking care not to split an IPv6 literal on its colons.
    let hostname = if host.starts_with('[') {
        match host.find(']') {
            Some(end) => &host[..=end],
            None => return false,
        }
    } else if host.matches(':').count() > 1 {
        // An unbracketed address with several colons can only be a bare IPv6
        // literal — a port would require brackets — so there is nothing to
        // strip. Splitting it on ':' would yield an empty hostname instead.
        host.as_str()
    } else {
        host.split(':').next().unwrap_or("")
    };
    LOOPBACK_HOSTS.contains(&hostname)
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "success": false, "error": message }))).into_response()
}

/// Runs before every route. Returns `Some(rejection)` when the request did not
/// come from this machine's own tooling.
fn reject_non_local(headers: &HeaderMap) -> Option<Response> {
    let host = headers.get("host").and_then(|v| v.to_str().ok());
    if !is_loopback_host(host) {
        return Some(error(StatusCode::FORBIDDEN, "Forbidden host"));
    }
    if headers.contains_key("origin") {
        return Some(error(
            StatusCode::FORBIDDEN,
            "Browser origins are not accepted",
        ));
    }
    None
}

/// Parses the body ourselves rather than using the `Json` extractor, so that
/// malformed JSON produces the same `{success, error}` shape as every other
/// failure instead of axum's plain-text rejection.
fn parse_body(body: &Bytes) -> Option<Value> {
    if body.is_empty() {
        // An empty body is "no fields", which the sanitisers reject with the
        // helpful per-route message.
        return Some(Value::Object(Default::default()));
    }
    serde_json::from_slice(body).ok()
}

async fn health(headers: HeaderMap) -> Response {
    if let Some(rejection) = reject_non_local(&headers) {
        return rejection;
    }
    Json(json!({
        "success": true,
        // Both editions answer on the same port and behave alike, so a client,
        // hook, or bug report needs a way to say which one replied.
        "version": env!("CARGO_PKG_VERSION"),
        "edition": EDITION,
        "cues": CUE_NAMES,
        "stateCues": STATE_CUES,
        "icons": ICON_NAMES,
    }))
    .into_response()
}

async fn notify(
    State(handlers): State<Arc<WebhookHandlers>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(rejection) = reject_non_local(&headers) {
        return rejection;
    }

    let invalid = || {
        error(
            StatusCode::BAD_REQUEST,
            &format!(
                "\"cue\" is required and must be one of: {}",
                CUE_NAMES.join(", ")
            ),
        )
    };

    let Some(raw) = parse_body(&body) else {
        return invalid();
    };
    let Some(payload) = sanitize_cue_payload(&raw) else {
        return invalid();
    };

    let cue = payload.cue.clone();
    (handlers.on_cue)(payload);
    Json(json!({ "success": true, "message": format!("Triggered {cue}") })).into_response()
}

/// Clears a state cue. `{"ref": "..."}` clears one, `{"all": true}` clears
/// every one — the counterpart to posting a `glow-blocked` cue.
async fn resolve(
    State(handlers): State<Arc<WebhookHandlers>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(rejection) = reject_non_local(&headers) {
        return rejection;
    }

    let invalid = || {
        error(
            StatusCode::BAD_REQUEST,
            "Send {\"ref\": \"<id>\"} or {\"all\": true}",
        )
    };

    let Some(raw) = parse_body(&body) else {
        return invalid();
    };
    let Some(request) = sanitize_resolve_payload(&raw) else {
        return invalid();
    };

    let cleared = (handlers.on_resolve)(request);
    let message = if cleared > 0 {
        format!(
            "Cleared {cleared} blocked agent{}",
            if cleared == 1 { "" } else { "s" }
        )
    } else {
        "Nothing was waiting".to_string()
    };
    Json(json!({ "success": true, "cleared": cleared, "message": message })).into_response()
}

pub fn router(handlers: Arc<WebhookHandlers>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/notify", post(notify))
        .route("/resolve", post(resolve))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(handlers)
}

/// Binds the receiver and serves until the process ends.
///
/// Binding is separated from serving so a port clash — a second instance, or
/// another app on 49123 — surfaces as an `Err` the caller can report, rather
/// than a panic inside a spawned task.
pub async fn bind(port: u16) -> std::io::Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind(SocketAddr::from((HOST, port))).await
}

pub async fn serve(
    listener: tokio::net::TcpListener,
    handlers: Arc<WebhookHandlers>,
) -> std::io::Result<()> {
    println!(
        "Periphery local hook listening on http://{}",
        listener.local_addr()?
    );
    axum::serve(listener, router(handlers)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::sync::Mutex;
    use tower::ServiceExt;

    #[derive(Default)]
    struct Spy {
        cues: Mutex<Vec<CuePayload>>,
        resolves: Mutex<Vec<ResolveRequest>>,
    }

    fn app(spy: Arc<Spy>, cleared: usize) -> Router {
        let for_cue = Arc::clone(&spy);
        let for_resolve = Arc::clone(&spy);
        router(Arc::new(WebhookHandlers {
            on_cue: Box::new(move |p| for_cue.cues.lock().unwrap().push(p)),
            on_resolve: Box::new(move |r| {
                for_resolve.resolves.lock().unwrap().push(r);
                cleared
            }),
        }))
    }

    /// A request as local tooling sends it: loopback Host, no Origin.
    fn local_post(path: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(path)
            .header("host", "127.0.0.1:49123")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn send(router: Router, request: Request<Body>) -> (StatusCode, Value) {
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn a_valid_cue_is_delivered_and_acknowledged() {
        let spy = Arc::new(Spy::default());
        let (status, body) = send(
            app(Arc::clone(&spy), 0),
            local_post("/notify", r#"{"cue":"glow","msg":"Build done","icon":"gitlab"}"#),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], json!(true));
        assert_eq!(body["message"], json!("Triggered glow"));

        let cues = spy.cues.lock().unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].msg.as_deref(), Some("Build done"));
    }

    #[tokio::test]
    async fn an_unknown_cue_is_rejected_with_the_list_of_valid_ones() {
        let spy = Arc::new(Spy::default());
        let (status, body) = send(
            app(Arc::clone(&spy), 0),
            local_post("/notify", r#"{"cue":"nuclear-siren"}"#),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("glow-blocked"));
        assert!(spy.cues.lock().unwrap().is_empty(), "nothing reaches the overlay");
    }

    #[tokio::test]
    async fn malformed_json_fails_in_the_same_shape_as_everything_else() {
        let spy = Arc::new(Spy::default());
        let (status, body) = send(
            app(Arc::clone(&spy), 0),
            local_post("/notify", "{ not json"),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["success"], json!(false));
        assert!(body["error"].is_string(), "and not axum's plain-text rejection");
    }

    #[tokio::test]
    async fn a_dangerous_payload_is_stripped_rather_than_passed_through() {
        let spy = Arc::new(Spy::default());
        let (status, _) = send(
            app(Arc::clone(&spy), 0),
            local_post(
                "/notify",
                r#"{"cue":"glow","color":"red;background:url(http://evil)","icon":"http://evil/x.svg"}"#,
            ),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "the cue still shows");
        let cues = spy.cues.lock().unwrap();
        assert_eq!(cues[0].color, None, "the CSS-injecting colour is dropped");
        assert_eq!(cues[0].icon, None, "the remote icon is dropped");
    }

    #[tokio::test]
    async fn a_rebound_dns_name_cannot_reach_the_receiver() {
        let spy = Arc::new(Spy::default());
        let request = Request::builder()
            .method("POST")
            .uri("/notify")
            .header("host", "attacker.example")
            .body(Body::from(r#"{"cue":"comet"}"#))
            .unwrap();

        let (status, body) = send(app(Arc::clone(&spy), 0), request).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], json!("Forbidden host"));
        assert!(spy.cues.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_request_from_a_web_page_is_refused_even_on_a_loopback_host() {
        let spy = Arc::new(Spy::default());
        let request = Request::builder()
            .method("POST")
            .uri("/notify")
            .header("host", "127.0.0.1:49123")
            .header("origin", "https://example.com")
            .body(Body::from(r#"{"cue":"comet"}"#))
            .unwrap();

        let (status, body) = send(app(Arc::clone(&spy), 0), request).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], json!("Browser origins are not accepted"));
        assert!(spy.cues.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_oversized_body_is_refused_before_it_is_parsed() {
        let spy = Arc::new(Spy::default());
        let huge = format!(r#"{{"cue":"glow","msg":"{}"}}"#, "a".repeat(BODY_LIMIT));
        let (status, _) = send(app(Arc::clone(&spy), 0), local_post("/notify", &huge)).await;

        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(spy.cues.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn resolve_clears_by_ref_and_reports_the_count() {
        let spy = Arc::new(Spy::default());
        let (status, body) = send(
            app(Arc::clone(&spy), 1),
            local_post("/resolve", r#"{"ref":"deploy-42"}"#),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["cleared"], json!(1));
        assert_eq!(body["message"], json!("Cleared 1 blocked agent"));
        assert_eq!(
            spy.resolves.lock().unwrap()[0].r#ref.as_deref(),
            Some("deploy-42")
        );
    }

    #[tokio::test]
    async fn resolve_all_pluralises_and_says_so_when_nothing_was_waiting() {
        let spy = Arc::new(Spy::default());
        let (_, many) = send(
            app(Arc::clone(&spy), 3),
            local_post("/resolve", r#"{"all":true}"#),
        )
        .await;
        assert_eq!(many["message"], json!("Cleared 3 blocked agents"));

        let (_, none) = send(
            app(Arc::clone(&spy), 0),
            local_post("/resolve", r#"{"all":true}"#),
        )
        .await;
        assert_eq!(none["message"], json!("Nothing was waiting"));
        assert!(spy.resolves.lock().unwrap()[1].all);
    }

    #[tokio::test]
    async fn resolve_without_a_ref_or_all_is_rejected() {
        let spy = Arc::new(Spy::default());
        let (status, body) = send(
            app(Arc::clone(&spy), 0),
            local_post("/resolve", r#"{"everything":true}"#),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("all"));
        assert!(spy.resolves.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn health_advertises_the_vocabulary_a_client_may_use() {
        let request = Request::builder()
            .uri("/health")
            .header("host", "localhost:49123")
            .body(Body::empty())
            .unwrap();

        let (status, body) = send(app(Arc::new(Spy::default()), 0), request).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["edition"], json!("tauri"), "so a client knows which shell replied");
        assert_eq!(body["version"], json!(env!("CARGO_PKG_VERSION")));
        assert!(body["cues"].as_array().unwrap().contains(&json!("comet")));
        assert_eq!(body["stateCues"], json!(["glow-blocked"]));
        assert!(body["icons"].as_array().unwrap().contains(&json!("blocked")));
    }

    #[test]
    fn loopback_host_matching_covers_the_forms_a_real_client_sends() {
        assert!(is_loopback_host(Some("127.0.0.1:49123")));
        assert!(is_loopback_host(Some("localhost")));
        assert!(is_loopback_host(Some("LOCALHOST:49123")));
        assert!(is_loopback_host(Some("[::1]:49123")), "IPv6 literal with a port");
        assert!(is_loopback_host(Some("::1")), "bare IPv6 loopback");

        assert!(!is_loopback_host(None));
        assert!(!is_loopback_host(Some("example.com")));
        assert!(
            !is_loopback_host(Some("localhost.evil.com")),
            "a suffix must not match"
        );
        assert!(
            !is_loopback_host(Some("[::1")),
            "an unterminated literal is not a host"
        );
    }

    #[tokio::test]
    async fn the_receiver_binds_loopback_only() {
        // Port 0 lets the OS pick, so the test cannot collide with a running
        // instance on 49123.
        let listener = bind(0).await.expect("bind");
        assert_eq!(
            listener.local_addr().unwrap().ip(),
            std::net::IpAddr::V4(Ipv4Addr::LOCALHOST),
            "binding anything but loopback would expose an unauthenticated receiver"
        );
    }
}

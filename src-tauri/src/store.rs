//! JSON-file persistence for settings and secrets. Port of
//! `utils/stores/{JsonFileStore,configStore,secureStore}.js`.
//!
//! Two stores, deliberately separate files: settings are boring and readable,
//! secrets are encrypted and written owner-only. Keeping them apart means the
//! user can inspect or hand-edit their config without ever being tempted to
//! open the file holding their tokens.

use crate::crypto::Crypto;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Minimal JSON-object persistence shared by both stores.
pub struct JsonFileStore {
    path: PathBuf,
    store: Map<String, Value>,
}

impl JsonFileStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let store = Self::load(&path);
        Self { path, store }
    }

    /// Adopts a store file left behind by an earlier app name (FlowState →
    /// Periphery), so a rebrand does not silently discard settings and tokens.
    /// No-op unless the old file exists and the new one does not.
    pub fn adopt_legacy_file(legacy: &Path, current: &Path) {
        if !legacy.exists() || current.exists() {
            return;
        }
        if let Some(parent) = current.parent()
            && let Err(err) = std::fs::create_dir_all(parent)
        {
            eprintln!("[Store] Could not prepare {}: {err}", parent.display());
            return;
        }
        match std::fs::rename(legacy, current) {
            Ok(()) => println!("[Store] Migrated {} -> {}", legacy.display(), current.display()),
            Err(err) => eprintln!("[Store] Could not migrate {}: {err}", legacy.display()),
        }
    }

    fn load(path: &Path) -> Map<String, Value> {
        let Ok(text) = std::fs::read_to_string(path) else {
            // A missing file is the normal first-run case, not an error.
            return Map::new();
        };
        match serde_json::from_str::<Value>(&text) {
            // Anything that is not a JSON object (an array, a bare string, a
            // truncated write) is ignored rather than partially adopted.
            Ok(Value::Object(map)) => map,
            Ok(_) => {
                eprintln!("[Store] {} is not a JSON object, ignoring it.", path.display());
                Map::new()
            }
            Err(err) => {
                eprintln!("[Store] Failed to parse {}: {err}", path.display());
                Map::new()
            }
        }
    }

    /// Writes via a temp file + rename so a crash mid-write cannot leave a
    /// truncated store behind — which previously meant silent token loss.
    fn save(&self) {
        let tmp = self.path.with_extension("tmp");
        if let Some(parent) = self.path.parent()
            && let Err(err) = std::fs::create_dir_all(parent)
        {
            eprintln!("[Store] Failed to create {}: {err}", parent.display());
            return;
        }

        let body = match serde_json::to_string_pretty(&Value::Object(self.store.clone())) {
            Ok(body) => body,
            Err(err) => {
                eprintln!("[Store] Failed to serialise {}: {err}", self.path.display());
                return;
            }
        };

        if let Err(err) = std::fs::write(&tmp, body) {
            eprintln!("[Store] Failed to write {}: {err}", tmp.display());
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        if let Err(err) = std::fs::rename(&tmp, &self.path) {
            eprintln!("[Store] Failed to commit {}: {err}", self.path.display());
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// Tightens permissions to owner-only. Unix-only; on Windows the file
    /// inherits the user profile's ACL, which is already user-scoped.
    fn restrict_permissions(&self) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if self.path.exists()
                && let Err(err) =
                    std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
            {
                eprintln!("[Store] Could not restrict {}: {err}", self.path.display());
            }
        }
    }
}

/// Every non-secret setting, with the value used when the key is absent.
///
/// Merged *under* the loaded file rather than used only on first run, so a key
/// added in a later release still has a value for users who already have a
/// config on disk.
pub fn defaults() -> BTreeMap<&'static str, Value> {
    BTreeMap::from([
        // Cue rendering
        ("glowRepeats", json!(3)),
        ("glowSpeed", json!(3)), // 1 (tortoise) .. 5 (hare)
        ("verboseMode", json!(true)),
        // Attention-aware delivery
        ("respectFocusAssist", json!(true)),
        ("slackTideEnabled", json!(true)),
        ("digestEnabled", json!(true)),
        ("awaySummaryEnabled", json!(true)),
        // Agent cues
        ("agentCuesEnabled", json!(true)),
        ("blockedCuesEnabled", json!(true)),
        // A blocked agent is wasting time right now, so by default it is the
        // one thing allowed through Focus Assist.
        ("blockedPiercesFocus", json!(true)),
        // Connectors
        ("gitlabEnabled", json!(true)),
        ("gitlabProjectId", json!("")),
        ("githubEnabled", json!(true)),
        ("githubRepo", json!("")),
        ("outlookEnabled", json!(true)),
        ("outlookEmail", json!("")),
        // Folders the user has pointed Periphery at (wizard or Settings).
        // Hook status is always re-detected from disk; only paths are stored.
        ("projectFolders", json!([])),
        // Off by default: needs a work/school account, which most users
        // signing in with a personal address will not have.
        ("teamsPresenceEnabled", json!(false)),
        ("pomodoroEnabled", json!(true)),
        ("pomodoroMinutes", json!(25)),
        // Shell
        ("healthBadgeEnabled", json!(true)),
        ("autoUpdateEnabled", json!(true)),
        // Opt-in: silently adding a startup entry would be a hostile default.
        ("startAtLogin", json!(false)),
        ("onboardingDone", json!(false)),
    ])
}

pub struct ConfigStore {
    inner: JsonFileStore,
}

impl ConfigStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let mut inner = JsonFileStore::new(path);
        for (key, value) in defaults() {
            inner.store.entry(key.to_string()).or_insert(value);
        }
        Self { inner }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.inner.store.get(key)
    }

    /// Feature toggles are read on nearly every cue, so this is the hot path.
    /// A key holding a non-boolean falls back rather than coercing.
    pub fn get_bool(&self, key: &str, fallback: bool) -> bool {
        self.get(key).and_then(Value::as_bool).unwrap_or(fallback)
    }

    pub fn get_i64(&self, key: &str, fallback: i64) -> i64 {
        self.get(key).and_then(Value::as_i64).unwrap_or(fallback)
    }

    pub fn get_str(&self, key: &str) -> &str {
        self.get(key).and_then(Value::as_str).unwrap_or("")
    }

    pub fn set(&mut self, key: &str, value: Value) {
        self.inner.store.insert(key.to_string(), value);
        self.inner.save();
    }

    /// Applies several keys with a single write — the Settings window saves
    /// everything at once, and one write keeps that atomic.
    pub fn set_many(&mut self, values: impl IntoIterator<Item = (String, Value)>) {
        for (key, value) in values {
            self.inner.store.insert(key, value);
        }
        self.inner.save();
    }

    pub fn all(&self) -> Map<String, Value> {
        self.inner.store.clone()
    }
}

/// Encrypted-at-rest secret storage.
///
/// Each entry records whether it was actually encrypted, so a store written
/// while OS encryption was unavailable stays readable later. Without that
/// discriminator the plaintext would be handed to the decrypt path, which
/// fails and silently drops the token.
pub struct SecureStore {
    inner: JsonFileStore,
    crypto: Box<dyn Crypto>,
}

impl SecureStore {
    pub fn new(path: impl Into<PathBuf>, crypto: Box<dyn Crypto>) -> Self {
        let inner = JsonFileStore::new(path);
        inner.restrict_permissions();
        Self { inner, crypto }
    }

    /// Returns whether the value was stored encrypted.
    pub fn set_secret(&mut self, key: &str, value: &str) -> bool {
        let entry = match self.crypto.is_available().then(|| self.crypto.encrypt(value)) {
            Some(Ok(cipher)) => {
                use base64::Engine as _;
                json!({
                    "encrypted": true,
                    "value": base64::engine::general_purpose::STANDARD.encode(cipher),
                })
            }
            other => {
                if let Some(Err(err)) = other {
                    eprintln!("[SecureStore] Encryption failed for \"{key}\": {err}");
                }
                eprintln!(
                    "[SecureStore] OS encryption unavailable; storing \"{key}\" in plaintext (NOT SECURE)."
                );
                json!({ "encrypted": false, "value": value })
            }
        };

        let encrypted = entry["encrypted"].as_bool().unwrap_or(false);
        self.inner.store.insert(key.to_string(), entry);
        self.inner.save();
        self.inner.restrict_permissions();
        encrypted
    }

    pub fn get_secret(&self, key: &str) -> Option<String> {
        let entry = self.inner.store.get(key)?;

        // Entries written before the encrypted/plaintext discriminator existed
        // were bare strings; treat them as legacy and refuse to guess.
        if entry.is_string() {
            eprintln!("[SecureStore] Legacy entry for \"{key}\"; re-enter it in Settings.");
            return None;
        }

        let value = entry.get("value")?.as_str()?;
        if entry.get("encrypted").and_then(Value::as_bool) != Some(true) {
            return Some(value.to_string());
        }

        use base64::Engine as _;
        let cipher = base64::engine::general_purpose::STANDARD
            .decode(value)
            .map_err(|e| format!("not valid base64: {e}"))
            .and_then(|bytes| self.crypto.decrypt(&bytes));

        match cipher {
            Ok(plain) => Some(plain),
            Err(err) => {
                eprintln!("[SecureStore] Failed to decrypt \"{key}\": {err}");
                None
            }
        }
    }

    pub fn has_secret(&self, key: &str) -> bool {
        self.inner.store.get(key).is_some_and(|v| !v.is_null())
    }

    /// Removes a stored secret, so disabling a connector can also drop its
    /// credential rather than leaving it on disk forever.
    pub fn delete_secret(&mut self, key: &str) -> bool {
        let removed = self.inner.store.remove(key).is_some();
        if removed {
            self.inner.save();
        }
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::test_support::FakeCrypto;

    /// A unique temp directory per test, cleaned up on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            // Tests run in parallel threads, so the thread id keeps paths
            // distinct without needing a clock or RNG.
            let id = format!("{:?}", std::thread::current().id());
            let sanitised: String = id.chars().filter(char::is_ascii_alphanumeric).collect();
            let dir = std::env::temp_dir().join(format!("periphery-test-{tag}-{sanitised}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn secure(path: PathBuf, available: bool) -> SecureStore {
        SecureStore::new(path, Box::new(FakeCrypto { available }))
    }

    #[test]
    fn defaults_apply_when_no_file_exists() {
        let dir = TempDir::new("defaults");
        let config = ConfigStore::new(dir.join("config.json"));

        assert!(config.get_bool("verboseMode", false));
        assert_eq!(config.get_i64("glowSpeed", 0), 3);
        assert_eq!(config.get_str("githubRepo"), "");
        assert!(
            !config.get_bool("startAtLogin", true),
            "autostart must be opt-in"
        );
        assert!(
            !config.get_bool("teamsPresenceEnabled", true),
            "Teams presence needs a work account, so it is off by default"
        );
    }

    #[test]
    fn a_stored_value_wins_over_its_default_but_new_keys_still_get_one() {
        let dir = TempDir::new("merge");
        let path = dir.join("config.json");
        // A config written by an older release: one overridden key, and none
        // of the keys added since.
        std::fs::write(&path, r#"{"glowSpeed": 5}"#).unwrap();

        let config = ConfigStore::new(&path);
        assert_eq!(config.get_i64("glowSpeed", 0), 5, "the user's choice survives");
        assert!(
            config.get_bool("blockedCuesEnabled", false),
            "a key added later still gets its default"
        );
    }

    #[test]
    fn settings_round_trip_through_the_file() {
        let dir = TempDir::new("roundtrip");
        let path = dir.join("config.json");

        let mut config = ConfigStore::new(&path);
        config.set_many([
            ("githubRepo".to_string(), json!("owner/repo")),
            ("slackTideEnabled".to_string(), json!(false)),
        ]);

        let reloaded = ConfigStore::new(&path);
        assert_eq!(reloaded.get_str("githubRepo"), "owner/repo");
        assert!(!reloaded.get_bool("slackTideEnabled", true));
    }

    #[test]
    fn a_corrupt_config_falls_back_to_defaults_instead_of_failing_to_start() {
        let dir = TempDir::new("corrupt");
        let path = dir.join("config.json");
        std::fs::write(&path, "{ this is not json").unwrap();

        let config = ConfigStore::new(&path);
        assert_eq!(config.get_i64("glowSpeed", 0), 3);
    }

    #[test]
    fn a_json_array_is_rejected_rather_than_partially_adopted() {
        let dir = TempDir::new("array");
        let path = dir.join("config.json");
        std::fs::write(&path, "[1, 2, 3]").unwrap();

        assert!(ConfigStore::new(&path).get_bool("verboseMode", false));
    }

    #[test]
    fn a_wrongly_typed_value_falls_back_rather_than_coercing() {
        let dir = TempDir::new("typed");
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"slackTideEnabled": "yes"}"#).unwrap();

        assert!(
            !ConfigStore::new(&path).get_bool("slackTideEnabled", false),
            "a non-boolean must not read as truthy the way JS would"
        );
    }

    #[test]
    fn a_secret_round_trips_and_is_not_written_in_the_clear() {
        let dir = TempDir::new("secret");
        let path = dir.join("secrets.json");

        let mut store = secure(path.clone(), true);
        assert!(store.set_secret("gitlabToken", "glpat-abc123"));
        assert_eq!(store.get_secret("gitlabToken").as_deref(), Some("glpat-abc123"));

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(
            !on_disk.contains("glpat-abc123"),
            "the plaintext token must never reach the file"
        );
        assert!(on_disk.contains("\"encrypted\": true"));
    }

    #[test]
    fn secrets_survive_a_restart() {
        let dir = TempDir::new("persist");
        let path = dir.join("secrets.json");

        secure(path.clone(), true).set_secret("githubToken", "ghp_xyz");
        assert_eq!(
            secure(path, true).get_secret("githubToken").as_deref(),
            Some("ghp_xyz")
        );
    }

    #[test]
    fn without_os_encryption_the_secret_is_kept_but_flagged() {
        let dir = TempDir::new("plain");
        let path = dir.join("secrets.json");

        let mut store = secure(path.clone(), false);
        assert!(!store.set_secret("gitlabToken", "glpat-abc123"), "and says so");
        // Losing the token would be worse than storing it unencrypted, so long
        // as the entry records which it is.
        assert_eq!(store.get_secret("gitlabToken").as_deref(), Some("glpat-abc123"));
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"encrypted\": false"));
    }

    #[test]
    fn a_legacy_bare_string_entry_is_refused_rather_than_guessed_at() {
        let dir = TempDir::new("legacy");
        let path = dir.join("secrets.json");
        std::fs::write(&path, r#"{"gitlabToken": "glpat-old"}"#).unwrap();

        let store = secure(path, true);
        assert!(store.has_secret("gitlabToken"), "the entry is visibly present");
        assert_eq!(
            store.get_secret("gitlabToken"),
            None,
            "but is not decoded by guessing at its format"
        );
    }

    #[test]
    fn undecryptable_ciphertext_reads_as_absent_not_as_garbage() {
        let dir = TempDir::new("undecryptable");
        let path = dir.join("secrets.json");
        // What a store encrypted under a different user account looks like.
        std::fs::write(&path, r#"{"k": {"encrypted": true, "value": "!!!not-base64!!!"}}"#).unwrap();

        assert_eq!(secure(path, true).get_secret("k"), None);
    }

    #[test]
    fn deleting_a_secret_removes_it_from_disk_and_reports_honestly() {
        let dir = TempDir::new("delete");
        let path = dir.join("secrets.json");

        let mut store = secure(path.clone(), true);
        store.set_secret("outlookToken", "token");
        assert!(store.delete_secret("outlookToken"));
        assert!(!store.has_secret("outlookToken"));
        assert!(!store.delete_secret("outlookToken"), "deleting twice is honest");
        assert!(!std::fs::read_to_string(&path).unwrap().contains("outlookToken"));
    }

    #[test]
    fn a_rebrand_adopts_the_old_store_without_overwriting_a_new_one() {
        let dir = TempDir::new("adopt");
        let legacy = dir.join("flowstate-config.json");
        let current = dir.join("config.json");

        std::fs::write(&legacy, r#"{"glowSpeed": 5}"#).unwrap();
        JsonFileStore::adopt_legacy_file(&legacy, &current);
        assert!(!legacy.exists(), "the old file is moved, not copied");
        assert_eq!(ConfigStore::new(&current).get_i64("glowSpeed", 0), 5);

        // A second run must not clobber the migrated file.
        std::fs::write(&legacy, r#"{"glowSpeed": 1}"#).unwrap();
        JsonFileStore::adopt_legacy_file(&legacy, &current);
        assert_eq!(ConfigStore::new(&current).get_i64("glowSpeed", 0), 5);
    }
}

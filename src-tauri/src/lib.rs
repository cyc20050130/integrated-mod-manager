use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir as CapDir, OpenOptions as CapOpenOptions};
use futures_util::StreamExt;
use log as tracing;
use log::LevelFilter;
use md5::{Digest, Md5};
use once_cell::sync::Lazy;
use reqwest::header::{
    ACCEPT, CONTENT_RANGE, CONTENT_TYPE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE, REFERER, USER_AGENT,
};
use reqwest::Client;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::fs::{remove_file, OpenOptions};
use std::io::{BufWriter, Read, Write};
use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy, Target, TargetKind};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout};

mod app_state;
mod hotreload;
mod ini_watcher;
mod logger_utils;
mod managed_fs;
mod managed_junction;
mod managed_text;
mod mod_mutation;
mod nte;
mod nte_wal;
#[cfg(windows)]
mod privileged_helper;
mod remote_media;
#[cfg(windows)]
mod wer_registry;

const PROGRESS_UPDATE_THRESHOLD: u64 = 1024;
const BUFFER_SIZE: usize = 8192;
const MANAGED_SOURCE_DIR: &str = "DISABLED - ALL MODS ARE STORED HERE (Managed by IMM)";
const PREVIEW_CACHE_DIR: &str = "preview-cache";
const PREVIEW_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff"];
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 10;
const DEFAULT_STALL_TIMEOUT_SECS: u64 = 25;
const DEFAULT_REQUEST_RETRIES: u32 = 3;
const DEFAULT_PROGRESS_INTERVAL_MS: u64 = 700;
const DEFAULT_BACKOFF_BASE_MS: u64 = 2000;
const DEFAULT_MAX_CONCURRENT_EXTRACTS: usize = 2;
const PREVIEW_IDLE_WAIT_TIMEOUT_SECS: u64 = 90;
const PREVIEW_IDLE_POLL_MS: u64 = 250;
const DOWNLOAD_USER_AGENT: &str = "IntegratedModManager/3.2";

fn ensure_rustls_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // tauri-plugin-updater uses the same ring provider. A concurrent
        // installer can only make this call fail after setting a valid default.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

#[cfg(test)]
mod tls_provider_tests {
    use super::*;

    #[test]
    fn reqwest_client_build_does_not_panic_after_provider_installation() {
        ensure_rustls_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());

        let build = std::panic::catch_unwind(|| reqwest::Client::builder().build());
        assert!(
            matches!(build, Ok(Ok(_))),
            "reqwest client build panicked or failed after TLS provider installation"
        );
    }
}
const WINDOWS_INSTALL_DIR_NAME: &str = "Integrated Mod Manager (IMM)";
const GAMEBANANA_JSON_LIMIT: usize = 4 * 1024 * 1024;
const GAMEBANANA_REQUEST_ID_LIMIT: usize = 128;
const GAMEBANANA_CANCELLED_REQUEST_LIMIT: usize = 256;
const GAMEBANANA_CANCELLED_MESSAGE: &str = "GameBanana request cancelled";
const INSTALL_PREVIEW_MAX_BYTES: u64 = 20 * 1024 * 1024;
const INSTALL_PREVIEW_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const DOWNLOAD_MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const REGISTERED_GAME_KEYS: &[&str] = &["WW", "ZZ", "GI", "SR", "EF", "NTE"];
const MAX_MOD_PAYLOAD_SCAN_PATHS: usize = 2_048;
const MAX_MOD_PAYLOAD_SCAN_ENTRIES: usize = 100_000;

fn validate_gamebanana_api_url(raw_url: &str) -> Result<reqwest::Url, String> {
    let url =
        reqwest::Url::parse(raw_url).map_err(|err| format!("Invalid GameBanana URL: {err}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "GameBanana URL has no host".to_string())?;
    if url.scheme() != "https"
        || (host != "gamebanana.com" && !host.ends_with(".gamebanana.com"))
        || !url.path().starts_with("/apiv11/")
    {
        return Err("Only HTTPS GameBanana apiv11 URLs are allowed".to_string());
    }
    Ok(url)
}

enum GameBananaRequestEntry {
    Active(oneshot::Sender<()>),
    Cancelled,
}

struct GameBananaHttpState {
    client: Option<Client>,
    initialization_error: Option<String>,
    requests: Mutex<HashMap<String, GameBananaRequestEntry>>,
}

impl GameBananaHttpState {
    fn new() -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let next = attempt.url();
                let host_allowed = next.host_str().is_some_and(|host| {
                    host == "gamebanana.com" || host.ends_with(".gamebanana.com")
                });
                if attempt.previous().len() >= 5 {
                    return attempt.error("too many redirects");
                }
                if next.scheme() != "https" || !host_allowed || !next.path().starts_with("/apiv11/")
                {
                    return attempt.error("redirect left the GameBanana API allowlist");
                }
                attempt.follow()
            }))
            .build();
        match client {
            Ok(client) => Self {
                client: Some(client),
                initialization_error: None,
                requests: Mutex::new(HashMap::new()),
            },
            Err(err) => Self {
                client: None,
                initialization_error: Some(format!("Unable to create GameBanana client: {err}")),
                requests: Mutex::new(HashMap::new()),
            },
        }
    }

    fn client(&self) -> Result<&Client, String> {
        self.client.as_ref().ok_or_else(|| {
            self.initialization_error
                .clone()
                .unwrap_or_else(|| "GameBanana client is unavailable".to_string())
        })
    }

    fn validate_request_id(request_id: &str) -> Result<(), String> {
        if request_id.is_empty()
            || request_id.len() > GAMEBANANA_REQUEST_ID_LIMIT
            || !request_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err("Invalid GameBanana request id".to_string());
        }
        Ok(())
    }

    fn register(&self, request_id: &str) -> Result<oneshot::Receiver<()>, String> {
        Self::validate_request_id(request_id)?;
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "GameBanana request registry lock is poisoned".to_string())?;
        match requests.get(request_id) {
            Some(GameBananaRequestEntry::Cancelled) => {
                requests.remove(request_id);
                return Err(GAMEBANANA_CANCELLED_MESSAGE.to_string());
            }
            Some(GameBananaRequestEntry::Active(_)) => {
                return Err("Duplicate GameBanana request id".to_string());
            }
            None => {}
        }
        let (sender, receiver) = oneshot::channel();
        requests.insert(
            request_id.to_string(),
            GameBananaRequestEntry::Active(sender),
        );
        Ok(receiver)
    }

    fn finish(&self, request_id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(request_id);
        }
    }

    fn cancel(&self, request_id: &str) -> Result<(), String> {
        Self::validate_request_id(request_id)?;
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "GameBanana request registry lock is poisoned".to_string())?;
        if let Some(GameBananaRequestEntry::Active(sender)) = requests.remove(request_id) {
            let _ = sender.send(());
            return Ok(());
        }
        if requests
            .values()
            .filter(|entry| matches!(entry, GameBananaRequestEntry::Cancelled))
            .count()
            >= GAMEBANANA_CANCELLED_REQUEST_LIMIT
        {
            if let Some(oldest_cancelled) = requests.iter().find_map(|(id, entry)| {
                matches!(entry, GameBananaRequestEntry::Cancelled).then(|| id.clone())
            }) {
                requests.remove(&oldest_cancelled);
            }
        }
        requests.insert(request_id.to_string(), GameBananaRequestEntry::Cancelled);
        Ok(())
    }
}

#[cfg(test)]
mod gamebanana_http_state_tests {
    use super::*;

    fn state() -> GameBananaHttpState {
        ensure_rustls_crypto_provider();
        GameBananaHttpState::new()
    }

    #[test]
    fn reuses_one_reqwest_client() {
        let state = state();
        let first = state.client().expect("shared client should initialize") as *const Client;
        let second = state
            .client()
            .expect("shared client should remain available") as *const Client;

        assert_eq!(first, second);
    }

    #[test]
    fn validates_request_ids() {
        assert!(GameBananaHttpState::validate_request_id("renderer-1_valid").is_ok());
        assert!(GameBananaHttpState::validate_request_id("").is_err());
        assert!(GameBananaHttpState::validate_request_id("contains spaces").is_err());
        assert!(GameBananaHttpState::validate_request_id("non-ascii-测试").is_err());
        assert!(GameBananaHttpState::validate_request_id(
            &"a".repeat(GAMEBANANA_REQUEST_ID_LIMIT + 1)
        )
        .is_err());
    }

    #[test]
    fn pre_cancel_is_consumed_by_registration() {
        let state = state();
        state
            .cancel("pre-cancelled")
            .expect("pre-cancel should register");

        assert_eq!(
            state.register("pre-cancelled").unwrap_err(),
            GAMEBANANA_CANCELLED_MESSAGE
        );

        let _receiver = state
            .register("pre-cancelled")
            .expect("consuming a tombstone should allow a later unique request");
        state.finish("pre-cancelled");
    }

    #[test]
    fn cancelling_an_active_request_notifies_its_receiver() {
        let state = state();
        let mut receiver = state
            .register("active-request")
            .expect("request should register");

        state
            .cancel("active-request")
            .expect("active request should cancel");

        assert_eq!(receiver.try_recv(), Ok(()));
        assert!(!state
            .requests
            .lock()
            .expect("registry lock should remain healthy")
            .contains_key("active-request"));
    }

    #[test]
    fn duplicate_active_request_ids_are_rejected() {
        let state = state();
        let _receiver = state
            .register("duplicate")
            .expect("first request should register");

        assert_eq!(
            state.register("duplicate").unwrap_err(),
            "Duplicate GameBanana request id"
        );
        state.finish("duplicate");
    }

    #[test]
    fn pre_cancel_registry_is_bounded() {
        let state = state();
        for index in 0..(GAMEBANANA_CANCELLED_REQUEST_LIMIT + 32) {
            state
                .cancel(&format!("cancelled-{index}"))
                .expect("valid pre-cancel should be recorded");
        }

        let requests = state
            .requests
            .lock()
            .expect("registry lock should remain healthy");
        assert_eq!(requests.len(), GAMEBANANA_CANCELLED_REQUEST_LIMIT);
        assert!(requests
            .values()
            .all(|entry| matches!(entry, GameBananaRequestEntry::Cancelled)));
    }
}

async fn fetch_gamebanana_json_value(
    client: &Client,
    raw_url: String,
) -> Result<serde_json::Value, String> {
    let url = validate_gamebanana_api_url(&raw_url)?;
    let response = client
        .get(url)
        .header("accept", "application/json")
        .header("user-agent", "IntegratedModManager/3.2")
        .send()
        .await
        .map_err(|err| format!("GameBanana request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("GameBanana returned HTTP {}", response.status()));
    }
    if let Some(content_type) = response.headers().get(CONTENT_TYPE) {
        let content_type = content_type
            .to_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !content_type.is_empty() && !content_type.contains("json") {
            return Err("GameBanana response is not JSON".to_string());
        }
    }
    if response
        .content_length()
        .is_some_and(|length| length > GAMEBANANA_JSON_LIMIT as u64)
    {
        return Err("GameBanana response exceeds the 4 MiB limit".to_string());
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("GameBanana response read failed: {err}"))?;
        if body.len().saturating_add(chunk.len()) > GAMEBANANA_JSON_LIMIT {
            return Err("GameBanana response exceeds the 4 MiB limit".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|err| format!("Invalid GameBanana JSON: {err}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadUrlClass {
    GameBananaFile,
    GameBananaPreview,
}

fn request_range_start(url_class: DownloadUrlClass, resume_from: u64) -> Option<u64> {
    if resume_from > 0 || url_class == DownloadUrlClass::GameBananaFile {
        Some(resume_from)
    } else {
        None
    }
}

fn is_gamebanana_file_entry_url(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    let path = url.path();
    let has_file_identity = |prefix: &str| {
        path.strip_prefix(prefix)
            .and_then(|value| value.split('/').next())
            .is_some_and(|value| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()))
    };
    host == "gamebanana.com" && has_file_identity("/dl/")
}

fn is_gamebanana_file_redirect_url(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    let has_cdn_path = url
        .path()
        .strip_prefix("/mods/")
        .is_some_and(|value| !value.is_empty());
    is_gamebanana_file_entry_url(url)
        || (host == "files.gamebanana.com" && has_cdn_path)
        || (host.starts_with("filecache") && host.ends_with(".gamebanana.com") && has_cdn_path)
}

fn is_gamebanana_preview_url(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    url.scheme() == "https"
        && (host == "images.gamebanana.com"
            && (url.path().starts_with("/img/") || url.path().starts_with("/static/")))
}

fn is_private_or_local_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) => {
                ip.is_private()
                    || ip.is_loopback()
                    || ip.is_link_local()
                    || ip.is_broadcast()
                    || ip.is_unspecified()
                    || ip.is_multicast()
            }
            IpAddr::V6(ip) => {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_multicast()
                    || is_ipv6_link_local(ip)
                    || is_ipv6_unique_local(ip)
            }
        };
    }
    let lower = host.trim_end_matches('.').to_ascii_lowercase();
    lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
        || lower == "metadata.google.internal"
        || lower == "metadata"
}

fn is_ipv6_link_local(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xffc0 == 0xfe80
}

fn is_ipv6_unique_local(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xfe00 == 0xfc00
}

fn classify_download_url(
    raw_url: &str,
    preview: bool,
) -> Result<(reqwest::Url, DownloadUrlClass), String> {
    let url = reqwest::Url::parse(raw_url).map_err(|err| format!("Invalid download URL: {err}"))?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Downloads require an HTTPS URL without credentials or fragments".to_string());
    }
    if is_private_or_local_host(&url) {
        return Err("Downloads to local or private network addresses are blocked".to_string());
    }
    if preview && is_gamebanana_preview_url(&url) {
        return Ok((url, DownloadUrlClass::GameBananaPreview));
    }
    if !preview && is_gamebanana_file_entry_url(&url) {
        return Ok((url, DownloadUrlClass::GameBananaFile));
    }
    let _ = preview;
    Err("Only official GameBanana file and preview URLs are allowed".to_string())
}

fn redirect_allowed(url: &reqwest::Url, class: DownloadUrlClass) -> bool {
    if url.scheme() != "https" || is_private_or_local_host(url) {
        return false;
    }
    match class {
        DownloadUrlClass::GameBananaFile => is_gamebanana_file_redirect_url(url),
        DownloadUrlClass::GameBananaPreview => is_gamebanana_preview_url(url),
    }
}

fn validate_download_file_name(file_name: &str) -> Result<(), String> {
    let path = Path::new(file_name);
    if file_name.trim().is_empty()
        || path.components().count() != 1
        || !matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
        || file_name.contains(['/', '\\', ':'])
        || file_name == "."
        || file_name == ".."
    {
        return Err("Invalid download file name".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DownloadResumeMetadata {
    source_url: String,
    response_url: String,
    etag: Option<String>,
    last_modified: Option<String>,
    total_size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedDownloadHash {
    algorithm: String,
    value: String,
}

fn normalized_expected_md5(
    expected: Option<&ExpectedDownloadHash>,
) -> Result<Option<String>, String> {
    let Some(expected) = expected else {
        return Ok(None);
    };
    if !expected.algorithm.eq_ignore_ascii_case("md5")
        || expected.value.len() != 32
        || !expected.value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Unsupported or malformed expected download hash".to_string());
    }
    Ok(Some(expected.value.to_ascii_lowercase()))
}

fn validate_required_gamebanana_integrity(
    expected_size: Option<u64>,
    expected_hash: Option<&ExpectedDownloadHash>,
) -> Result<String, String> {
    let size = expected_size
        .filter(|size| *size > 0)
        .ok_or_else(|| "GameBanana download metadata is missing a positive file size. Remove it and add the file again.".to_string())?;
    if size > DOWNLOAD_MAX_BYTES {
        return Err("Expected download size exceeds the 16 GiB safety limit".to_string());
    }
    normalized_expected_md5(expected_hash)?.ok_or_else(|| {
        "GameBanana download metadata is missing a valid MD5 checksum. Remove it and add the file again.".to_string()
    })
}

fn validate_gamebanana_completed_download(
    completed: &serde_json::Value,
    source: &str,
    expected_size: Option<u64>,
    expected_hash: Option<&ExpectedDownloadHash>,
) -> Result<(), String> {
    let object = completed
        .as_object()
        .ok_or_else(|| "Completed GameBanana download metadata is not an object.".to_string())?;
    let mod_id = object
        .get("gameBananaModId")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "Completed download has no valid GameBanana Mod ID.".to_string())?;
    if app_state::gamebanana_mod_id_from_profile_url(source) != Some(mod_id) {
        return Err("Completed download source does not match its GameBanana Mod ID.".to_string());
    }
    let file_id = object
        .get("gameBananaFileId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 2_048)
        .ok_or_else(|| "Completed download has no valid GameBanana file ID.".to_string())?;
    if !file_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Completed download has an invalid GameBanana file ID.".to_string());
    }

    let recorded_size = object
        .get("expectedSize")
        .and_then(serde_json::Value::as_u64);
    if recorded_size != expected_size || recorded_size.is_none_or(|size| size == 0) {
        return Err("GameBanana download size metadata changed or is missing. Remove it and add the file again.".to_string());
    }
    let recorded_hash = object
        .get("expectedHash")
        .cloned()
        .map(serde_json::from_value::<ExpectedDownloadHash>)
        .transpose()
        .map_err(|error| format!("Invalid GameBanana checksum metadata: {error}"))?;
    let recorded_md5 =
        validate_required_gamebanana_integrity(recorded_size, recorded_hash.as_ref())?;
    let requested_md5 = validate_required_gamebanana_integrity(expected_size, expected_hash)?;
    if recorded_md5 != requested_md5 {
        return Err(
            "GameBanana download checksum metadata changed. Remove it and add the file again."
                .to_string(),
        );
    }
    Ok(())
}

fn verify_download_md5(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|err| format!("Unable to open completed download for verification: {err}"))?;
    let mut digest = Md5::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("Unable to verify completed download: {err}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let actual = format!("{:x}", digest.finalize());
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Downloaded file checksum mismatch (expected {expected}, got {actual})"
        ))
    }
}

fn resume_metadata_path(partial_path: &Path) -> PathBuf {
    partial_path.with_extension(format!(
        "{}.meta.json",
        partial_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("part")
    ))
}

fn read_resume_metadata(path: &Path) -> Option<DownloadResumeMetadata> {
    let payload = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&payload).ok()
}

fn is_strong_etag(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && !trimmed.starts_with("W/")
}

fn write_resume_metadata(path: &Path, metadata: &DownloadResumeMetadata) -> Result<(), String> {
    let payload = serde_json::to_vec(metadata)
        .map_err(|err| format!("Failed to serialize resume metadata: {err}"))?;
    let temp = path.with_extension("meta.json.tmp");
    std::fs::write(&temp, payload)
        .map_err(|err| format!("Failed to write resume metadata: {err}"))?;
    std::fs::rename(&temp, path).map_err(|err| format!("Failed to finalize resume metadata: {err}"))
}

fn parse_content_range_start(header_value: &str) -> Option<u64> {
    let range = header_value.strip_prefix("bytes ")?.split('/').next()?;
    range.split('-').next()?.trim().parse::<u64>().ok()
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    downloaded: f64,
    total: f64,
    speed: String,
    eta: String,
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewCacheRequest {
    key: String,
    relative_path: String,
}

#[derive(Debug, Serialize)]
struct ResolvedPreviewAsset {
    key: String,
    path: String,
}

fn resolve_managed_preview_file(
    managed_root: &Path,
    relative_path: &str,
) -> Result<Option<PathBuf>, String> {
    let separator = std::path::MAIN_SEPARATOR.to_string();
    let normalized = relative_path.replace(['\\', '/'], &separator);
    let relative = PathBuf::from(normalized);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!("Invalid preview path: {relative_path}"));
    }

    let managed_root = managed_root
        .canonicalize()
        .map_err(|err| format!("Unable to resolve managed mod directory: {err}"))?;
    let preview_dir = managed_root
        .join(relative)
        .canonicalize()
        .map_err(|err| format!("Unable to resolve preview directory for {relative_path}: {err}"))?;
    if !preview_dir.starts_with(&managed_root) {
        return Err(format!(
            "Preview path escapes the managed mod directory: {relative_path}"
        ));
    }

    for extension in PREVIEW_EXTENSIONS {
        let candidate = preview_dir.join(format!("preview.{extension}"));
        if candidate.is_file() {
            let resolved = candidate.canonicalize().map_err(|err| {
                format!("Unable to resolve preview file for {relative_path}: {err}")
            })?;
            if resolved.starts_with(&managed_root) {
                return Ok(Some(resolved));
            }
            return Err(format!(
                "Preview file escapes the managed mod directory: {relative_path}"
            ));
        }
    }

    Ok(None)
}

fn copy_preview_to_cache(source: &Path, cache_root: &Path) -> Result<PathBuf, String> {
    let _cache_guard = PREVIEW_CACHE_LOCK
        .lock()
        .map_err(|_| "Preview cache lock is poisoned".to_string())?;
    std::fs::create_dir_all(cache_root)
        .map_err(|err| format!("Unable to create preview cache directory: {err}"))?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| PREVIEW_EXTENSIONS.contains(&value.as_str()))
        .ok_or_else(|| "Unsupported preview image extension".to_string())?;

    let hash_input = if cfg!(target_os = "windows") {
        source.to_string_lossy().to_ascii_lowercase()
    } else {
        source.to_string_lossy().into_owned()
    };
    let legacy_hash = hash_input
        .bytes()
        .fold(0xcbf29ce484222325_u64, |value, byte| {
            value.wrapping_mul(0x100000001b3) ^ u64::from(byte)
        });
    let source_hash = format!("{:x}", Sha256::digest(hash_input.as_bytes()));
    let counter = PREVIEW_CACHE_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    let staging = cache_root.join(format!(".preview-{}-{counter}.tmp", std::process::id()));
    let staged_result = (|| {
        let mut input = OpenOptions::new()
            .read(true)
            .open(source)
            .map_err(|err| format!("Unable to open the preview source: {err}"))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|err| format!("Unable to create the preview cache staging file: {err}"))?;
        let mut content_hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = input
                .read(&mut buffer)
                .map_err(|err| format!("Unable to read the preview source: {err}"))?;
            if read == 0 {
                break;
            }
            content_hasher.update(&buffer[..read]);
            output
                .write_all(&buffer[..read])
                .map_err(|err| format!("Unable to write the preview cache staging file: {err}"))?;
        }
        output
            .sync_all()
            .map_err(|err| format!("Unable to flush the preview cache staging file: {err}"))?;
        Ok::<String, String>(format!("{:x}", content_hasher.finalize()))
    })();
    let content_hash = match staged_result {
        Ok(hash) => hash,
        Err(err) => {
            let _ = std::fs::remove_file(&staging);
            return Err(err);
        }
    };
    let destination = cache_root.join(format!("{source_hash}-{content_hash}.{extension}"));
    if destination.is_file() {
        let _ = std::fs::remove_file(&staging);
    } else if let Err(err) = std::fs::rename(&staging, &destination) {
        let destination_won_race = destination.is_file();
        let _ = std::fs::remove_file(&staging);
        if !destination_won_race {
            return Err(format!("Unable to publish the preview cache file: {err}"));
        }
    }

    if let Ok(entries) = std::fs::read_dir(cache_root) {
        let content_prefix = format!("{source_hash}-");
        for entry in entries.flatten() {
            let stale_path = entry.path();
            if stale_path == destination {
                continue;
            }
            let Some(name) = stale_path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let is_legacy = PREVIEW_EXTENSIONS
                .iter()
                .any(|stale_extension| name == format!("{legacy_hash:016x}.{stale_extension}"));
            if name.starts_with(&content_prefix) || is_legacy {
                if let Err(err) = std::fs::remove_file(&stale_path) {
                    if err.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(
                            "Unable to remove stale preview cache file {:?}: {}",
                            stale_path,
                            err
                        );
                    }
                }
            }
        }
    }

    Ok(destination)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadErrorEvent {
    key: String,
    message: String,
    stage: String,
    attempt: u32,
    max_attempts: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInstallContext {
    current_exe_path: String,
    current_exe_dir: String,
    managed_install_dir: String,
    portable: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadOptions {
    connect_timeout_sec: Option<u64>,
    stall_timeout_sec: Option<u64>,
    request_retries: Option<u32>,
    progress_interval_ms: Option<u64>,
    progress_bytes_threshold: Option<u64>,
    backoff_base_ms: Option<u64>,
    max_concurrent_extracts: Option<usize>,
    wait_for_primary_idle: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GameBananaDownloadState {
    relative_path: String,
    source: String,
    updated_at: u64,
    viewed_at: u64,
    config_updated_at: String,
    completed_download: serde_json::Value,
    #[serde(default)]
    expected_data_entry: Option<serde_json::Value>,
}

#[derive(Debug)]
struct PreparedDownloadStateMutation {
    next_game: serde_json::Value,
    expected_game_revision: u64,
    plan: GenericModMutationStatePlan,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            connect_timeout_sec: Some(DEFAULT_CONNECT_TIMEOUT_SECS),
            stall_timeout_sec: Some(DEFAULT_STALL_TIMEOUT_SECS),
            request_retries: Some(DEFAULT_REQUEST_RETRIES),
            progress_interval_ms: Some(DEFAULT_PROGRESS_INTERVAL_MS),
            progress_bytes_threshold: Some(PROGRESS_UPDATE_THRESHOLD),
            backoff_base_ms: Some(DEFAULT_BACKOFF_BASE_MS),
            max_concurrent_extracts: Some(DEFAULT_MAX_CONCURRENT_EXTRACTS),
            wait_for_primary_idle: Some(true),
        }
    }
}

/// Format bytes into human-readable format (KB, MB, GB)
fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

/// Format speed in bytes per second
fn format_speed(bytes_per_sec: f64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;

    if bytes_per_sec >= GB {
        format!("{:.2} GB/s", bytes_per_sec / GB)
    } else if bytes_per_sec >= MB {
        format!("{:.2} MB/s", bytes_per_sec / MB)
    } else if bytes_per_sec >= KB {
        format!("{:.2} KB/s", bytes_per_sec / KB)
    } else {
        format!("{:.2} B/s", bytes_per_sec)
    }
}

/// Format time duration into human-readable format
fn format_duration(seconds: u64) -> String {
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;

    if hours > 0 {
        format!("{}h {}m {}s", hours, minutes, secs)
    } else if minutes > 0 {
        format!("{}m {}s", minutes, secs)
    } else {
        format!("{}s", secs)
    }
}

fn local_app_data_install_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|base| base.join(WINDOWS_INSTALL_DIR_NAME))
}

fn normalize_compare_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn build_update_install_context_from_exe(exe_path: &Path) -> UpdateInstallContext {
    let exe_dir = exe_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let managed_install_dir = local_app_data_install_dir().unwrap_or_else(|| exe_dir.clone());
    let portable = normalize_compare_path(&exe_dir) != normalize_compare_path(&managed_install_dir);

    UpdateInstallContext {
        current_exe_path: exe_path.to_string_lossy().to_string(),
        current_exe_dir: exe_dir.to_string_lossy().to_string(),
        managed_install_dir: managed_install_dir.to_string_lossy().to_string(),
        portable,
    }
}

async fn download_file_to_path(url: &str, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let response = Client::new()
        .get(url)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Update download failed with HTTP {}",
            response.status()
        ));
    }

    let bytes = response.bytes().await.map_err(|err| err.to_string())?;
    std::fs::write(destination, &bytes).map_err(|err| err.to_string())?;
    Ok(())
}

fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn build_portable_update_script(
    wait_pid: u32,
    installer: &Path,
    target_dir: &Path,
    exe_path: &Path,
) -> String {
    format!(
        "$ErrorActionPreference='SilentlyContinue'\n\
$waitPid = {wait_pid}\n\
$installer = '{installer}'\n\
$targetDir = '{target_dir}'\n\
$exePath = '{exe_path}'\n\
while (Get-Process -Id $waitPid -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 300 }}\n\
Start-Process -FilePath $installer -ArgumentList @('/S', '/D=' + $targetDir) -Wait -WindowStyle Hidden\n\
if (Test-Path $exePath) {{ Start-Process -FilePath $exePath -WorkingDirectory (Split-Path -Parent $exePath) }}\n\
Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue\n\
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue\n",
        wait_pid = wait_pid,
        installer = escape_powershell_single_quoted(&installer.to_string_lossy()),
        target_dir = escape_powershell_single_quoted(&target_dir.to_string_lossy()),
        exe_path = escape_powershell_single_quoted(&exe_path.to_string_lossy())
    )
}

#[cfg(not(target_os = "windows"))]
fn build_portable_update_script(
    _wait_pid: u32,
    _installer: &Path,
    _target_dir: &Path,
    _exe_path: &Path,
) -> String {
    String::new()
}

static SESSION_ID: AtomicU64 = AtomicU64::new(0);
static DOWNLOAD_COUNTS: Lazy<Mutex<HashMap<String, u64>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static CANCELLED_DOWNLOADS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static ACTIVE_EXTRACTIONS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_PREVIEW_DOWNLOADS: AtomicUsize = AtomicUsize::new(0);
static DEPLOYMENT_COUNTER: AtomicU64 = AtomicU64::new(0);
static PREVIEW_CACHE_COUNTER: AtomicU64 = AtomicU64::new(0);
static PREVIEW_CACHE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static MOD_MUTATION_PROCESS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[cfg(test)]
mod preview_cache_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn managed_preview_resolution_returns_the_complete_file_path() {
        let temp = tempdir().expect("tempdir");
        let managed_root = temp.path().join(MANAGED_SOURCE_DIR);
        let mod_dir = managed_root.join("Category").join("Mod Name");
        fs::create_dir_all(&mod_dir).expect("mod dir");
        let preview = mod_dir.join("preview.webp");
        fs::write(&preview, b"preview").expect("preview");

        let resolved = resolve_managed_preview_file(&managed_root, "Category/Mod Name")
            .expect("resolve")
            .expect("preview file");

        assert_eq!(resolved, preview.canonicalize().expect("canonical preview"));
    }

    #[test]
    fn managed_preview_resolution_rejects_parent_escape() {
        let temp = tempdir().expect("tempdir");
        fs::create_dir_all(temp.path().join(MANAGED_SOURCE_DIR)).expect("managed root");

        let result =
            resolve_managed_preview_file(&temp.path().join(MANAGED_SOURCE_DIR), "../outside");

        assert!(result.is_err());
    }

    #[test]
    fn preview_cache_copy_stays_under_the_manager_cache_root() {
        let temp = tempdir().expect("tempdir");
        let source = temp.path().join("preview.png");
        let cache_root = temp.path().join("cache");
        fs::write(&source, b"preview bytes").expect("source");

        let first_cached = copy_preview_to_cache(&source, &cache_root).expect("cache preview");

        assert!(first_cached.is_absolute());
        assert!(first_cached.starts_with(&cache_root));
        assert_eq!(
            first_cached.extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert_eq!(
            fs::read(&first_cached).expect("cached bytes"),
            b"preview bytes"
        );
        let first_name = first_cached
            .file_stem()
            .and_then(|value| value.to_str())
            .expect("content-addressed cache name");
        let (source_hash, content_hash) = first_name.split_once('-').expect("two cache hashes");
        assert_eq!(source_hash.len(), 64);
        assert_eq!(content_hash.len(), 64);

        fs::write(&source, b"updated preview bytes").expect("updated source");
        let second_cached =
            copy_preview_to_cache(&source, &cache_root).expect("updated cache preview");

        assert_ne!(second_cached, first_cached);
        assert!(!first_cached.exists());
        assert_eq!(
            fs::read(&second_cached).expect("updated cached bytes"),
            b"updated preview bytes"
        );
        assert!(fs::read_dir(&cache_root)
            .expect("cache entries")
            .all(|entry| !entry
                .expect("cache entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".preview-")));
    }
}

#[cfg(test)]
mod gamebanana_provider_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn api_url_validation_accepts_only_https_gamebanana_apiv11() {
        assert!(
            validate_gamebanana_api_url("https://gamebanana.com/apiv11/Game/23012/Subfeed").is_ok()
        );
        assert!(validate_gamebanana_api_url(
            "https://files.gamebanana.com/apiv11/Mod/1/ProfilePage"
        )
        .is_ok());
        assert!(
            validate_gamebanana_api_url("http://gamebanana.com/apiv11/Game/23012/Subfeed").is_err()
        );
        assert!(
            validate_gamebanana_api_url("https://example.com/apiv11/Game/23012/Subfeed").is_err()
        );
        assert!(validate_gamebanana_api_url("https://gamebanana.com/mods/23012").is_err());
    }

    #[test]
    fn download_url_validation_locks_gamebanana_to_official_file_routes() {
        let (_, class) = classify_download_url("https://gamebanana.com/dl/1763931", false)
            .expect("official download route");
        assert_eq!(class, DownloadUrlClass::GameBananaFile);
        assert!(redirect_allowed(
            &reqwest::Url::parse("https://files.gamebanana.com/mods/example.zip").unwrap(),
            class
        ));
        assert!(redirect_allowed(
            &reqwest::Url::parse("https://filecache41.gamebanana.com/mods/example.zip").unwrap(),
            class
        ));
        assert!(!redirect_allowed(
            &reqwest::Url::parse("https://images.gamebanana.com/img/ss/mods/example.png").unwrap(),
            class
        ));
        assert!(classify_download_url("https://gamebanana.com/mods/697236", false).is_err());
        assert!(
            classify_download_url("https://evil.gamebanana.com/mods/example.zip", false).is_err()
        );
    }

    #[test]
    fn download_redirect_validation_rejects_non_gamebanana_and_local_network_targets() {
        assert!(classify_download_url("https://example.com/public/example.zip", false).is_err());
        let class = DownloadUrlClass::GameBananaFile;
        assert!(!redirect_allowed(
            &reqwest::Url::parse("http://example.com/example.zip").unwrap(),
            class
        ));
        assert!(!redirect_allowed(
            &reqwest::Url::parse("https://127.0.0.1/example.zip").unwrap(),
            class
        ));
        assert!(!redirect_allowed(
            &reqwest::Url::parse("https://169.254.169.254/latest/meta-data").unwrap(),
            class
        ));
        assert!(!redirect_allowed(
            &reqwest::Url::parse("https://service.internal/example.zip").unwrap(),
            class
        ));
    }

    #[test]
    fn preview_and_resume_metadata_inputs_are_validated() {
        let (_, class) = classify_download_url(
            "https://images.gamebanana.com/img/ss/mods/example.png",
            true,
        )
        .expect("official preview route");
        assert_eq!(class, DownloadUrlClass::GameBananaPreview);
        assert!(classify_download_url("https://gamebanana.com/dl/1763931", true).is_err());
        assert_eq!(
            parse_content_range_start("bytes 4096-8191/16384"),
            Some(4096)
        );
        assert_eq!(parse_content_range_start("bytes */16384"), None);
        assert!(is_strong_etag("\"6a633768-3a95caa\""));
        assert!(!is_strong_etag("W/\"weak\""));
        assert!(validate_download_file_name("preview").is_ok());
        assert!(validate_download_file_name("mod.zip").is_ok());
        assert!(validate_download_file_name("../mod.zip").is_err());
        assert!(validate_download_file_name("C:\\temp\\mod.zip").is_err());
        assert_eq!(
            request_range_start(DownloadUrlClass::GameBananaFile, 0),
            Some(0)
        );
        assert_eq!(
            request_range_start(DownloadUrlClass::GameBananaFile, 4096),
            Some(4096)
        );
        assert_eq!(
            request_range_start(DownloadUrlClass::GameBananaPreview, 0),
            None
        );
        assert_eq!(
            request_range_start(DownloadUrlClass::GameBananaPreview, 4096),
            Some(4096)
        );
    }

    #[test]
    fn provider_md5_is_normalized_and_verified_after_download() {
        let expected = ExpectedDownloadHash {
            algorithm: "MD5".to_string(),
            value: "098F6BCD4621D373CADE4E832627B4F6".to_string(),
        };
        let normalized = normalized_expected_md5(Some(&expected))
            .expect("valid hash")
            .expect("present hash");
        assert_eq!(normalized, "098f6bcd4621d373cade4e832627b4f6");

        let temp = tempdir().expect("tempdir");
        let file = temp.path().join("download.zip.part");
        fs::write(&file, b"test").expect("fixture");
        assert!(verify_download_md5(&file, &normalized).is_ok());
        assert!(verify_download_md5(&file, "00000000000000000000000000000000").is_err());
    }

    #[test]
    fn gamebanana_download_requires_size_hash_and_stable_identity() {
        let hash = ExpectedDownloadHash {
            algorithm: "md5".to_string(),
            value: "d41d8cd98f00b204e9800998ecf8427e".to_string(),
        };
        assert!(validate_required_gamebanana_integrity(None, Some(&hash)).is_err());
        assert!(validate_required_gamebanana_integrity(Some(1200), None).is_err());

        let completed = serde_json::json!({
            "gameBananaModId": 42,
            "gameBananaFileId": "7",
            "expectedSize": 1200,
            "expectedHash": {
                "algorithm": hash.algorithm,
                "value": hash.value,
            },
        });
        assert!(validate_gamebanana_completed_download(
            &completed,
            "https://gamebanana.com/mods/42",
            Some(1200),
            Some(&ExpectedDownloadHash {
                algorithm: "MD5".to_string(),
                value: "D41D8CD98F00B204E9800998ECF8427E".to_string(),
            })
        )
        .is_ok());
        assert!(validate_gamebanana_completed_download(
            &completed,
            "https://gamebanana.com/mods/42",
            None,
            None
        )
        .is_err());
    }
}

#[cfg(test)]
mod zip_extraction_tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::fs;
    use std::io::{Cursor, Write};
    use tempfile::tempdir;
    use zip::write::{FileOptions, ZipWriter};

    #[derive(Clone)]
    struct PreviewTestApp {
        app_local_data: PathBuf,
    }

    impl DownloadAppContext for PreviewTestApp {
        fn app_local_data_dir(&self) -> Result<PathBuf, String> {
            Ok(self.app_local_data.clone())
        }

        fn emit_event<S: Serialize + Clone>(
            &self,
            _event: &str,
            _payload: S,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    fn image_bytes(format: ImageFormat, color: [u8; 3]) -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(4, 4, Rgb(color)));
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, format).unwrap();
        output.into_inner()
    }

    #[test]
    fn zip_extraction_rejects_parent_escape_without_writing_outside_root() {
        let temp = tempdir().expect("tempdir");
        let archive_path = temp.path().join("unsafe.zip");
        let output_root = temp.path().join("output");
        let file = std::fs::File::create(&archive_path).expect("archive");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("../escape.pak", FileOptions::<()>::default())
            .expect("entry");
        writer.write_all(b"unsafe").expect("entry bytes");
        writer.finish().expect("finish");

        assert!(extract_zip_archive(&archive_path, &output_root).is_err());
        assert!(!temp.path().join("escape.pak").exists());
    }

    #[test]
    fn zip_extraction_rejects_extreme_compression_ratio() {
        let temp = tempdir().expect("tempdir");
        let archive_path = temp.path().join("bomb.zip");
        let output_root = temp.path().join("output");
        let file = std::fs::File::create(&archive_path).expect("archive");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("payload.pak", FileOptions::<()>::default())
            .expect("entry");
        writer
            .write_all(&vec![b'a'; 256 * 1024])
            .expect("entry bytes");
        writer.finish().expect("finish");

        assert!(extract_zip_archive(&archive_path, &output_root).is_err());
    }

    #[test]
    fn zip_extraction_writes_a_valid_payload_inside_the_target_root() {
        let temp = tempdir().expect("tempdir");
        let archive_path = temp.path().join("valid.zip");
        let output_root = temp.path().join("output");
        let file = std::fs::File::create(&archive_path).expect("archive");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("Skins/demo.pak", FileOptions::<()>::default())
            .expect("entry");
        writer.write_all(b"pak bytes").expect("entry bytes");
        writer.finish().expect("finish");

        extract_zip_archive(&archive_path, &output_root).expect("extract");
        assert_eq!(
            std::fs::read(output_root.join("Skins/demo.pak")).expect("payload"),
            b"pak bytes"
        );
    }

    #[test]
    fn nte_content_policy_accepts_only_unreal_container_files() {
        let temp = tempdir().expect("tempdir");
        let valid = temp.path().join("valid");
        fs::create_dir_all(&valid).expect("valid dir");
        fs::write(valid.join("demo.pak"), b"pak").expect("pak");
        fs::write(valid.join("demo.utoc"), b"utoc").expect("utoc");
        fs::write(valid.join("demo.ucas"), b"ucas").expect("ucas");
        fs::write(valid.join("preview.jpg"), b"jpeg fixture").expect("preview");
        assert!(validate_nte_staged_content(&valid).is_ok());

        let invalid = temp.path().join("invalid");
        fs::create_dir_all(&invalid).expect("invalid dir");
        fs::write(invalid.join("demo.pak"), b"pak").expect("pak");
        fs::write(invalid.join("installer.exe"), b"exe").expect("exe");
        assert!(validate_nte_staged_content(&invalid).is_err());
    }

    #[test]
    fn selected_preview_file_is_read_through_a_bound_file_handle() {
        let temp = tempdir().expect("tempdir");
        let source = temp.path().join("selected.png");
        let expected = image_bytes(ImageFormat::Png, [12, 34, 56]);
        fs::write(&source, &expected).expect("selected preview");

        let (extension, data) = read_selected_preview_file(&source).expect("read selected preview");

        assert_eq!(extension, "png");
        assert_eq!(data, expected);
    }

    #[test]
    fn managed_preview_data_is_reencoded_to_the_only_preview_jpeg() {
        let temp = tempdir().expect("tempdir");
        let app = PreviewTestApp {
            app_local_data: temp.path().join("app-local"),
        };
        let png = image_bytes(ImageFormat::Png, [90, 120, 150]);

        let (staging, preview) =
            prepare_normalized_preview_data_staging(&app, "managed-preview", "png", &png)
                .expect("normalize managed preview");

        assert_eq!(
            preview.file_name().and_then(|name| name.to_str()),
            Some("preview.jpg")
        );
        let jpeg = fs::read(&preview).expect("normalized preview");
        assert!(jpeg.starts_with(&[0xff, 0xd8, 0xff]));
        let entries = fs::read_dir(&staging.path)
            .expect("read staging")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect staging");
        assert!(entries
            .iter()
            .any(|entry| entry.file_name() == "preview.jpg"));
        assert!(!entries
            .iter()
            .any(|entry| entry.file_name() == "preview.png"));
        staging.cleanup().expect("cleanup staging");
    }

    #[test]
    fn managed_preview_rejects_an_extension_signature_mismatch() {
        let temp = tempdir().expect("tempdir");
        let app = PreviewTestApp {
            app_local_data: temp.path().join("app-local"),
        };
        let png = image_bytes(ImageFormat::Png, [90, 120, 150]);

        let error =
            prepare_normalized_preview_data_staging(&app, "mismatched-preview", "jpg", &png)
                .err()
                .expect("mismatched preview must fail");

        assert!(error.contains("does not match its file extension"));
    }

    #[test]
    fn install_preview_prefers_package_image_and_publishes_only_jpeg() {
        let temp = tempdir().expect("tempdir");
        let staging = temp.path().join("staging");
        let fallback = temp.path().join("fallback.png");
        fs::create_dir(&staging).expect("staging");
        fs::write(staging.join("mod.ini"), b"mod").expect("payload");
        fs::write(
            staging.join("preview.png"),
            image_bytes(ImageFormat::Png, [220, 10, 10]),
        )
        .expect("package preview");
        fs::write(&fallback, image_bytes(ImageFormat::Png, [10, 10, 220]))
            .expect("fallback preview");

        install_required_preview(&staging, &PreparedInstallPreview::Ready(fallback))
            .expect("install preview");

        assert!(!staging.join("preview.png").exists());
        let jpeg = fs::read(staging.join("preview.jpg")).expect("preview.jpg");
        assert!(jpeg.starts_with(&[0xff, 0xd8, 0xff]));
        let decoded = image::load_from_memory_with_format(&jpeg, ImageFormat::Jpeg)
            .expect("decode normalized preview")
            .to_rgb8();
        let pixel = decoded.get_pixel(0, 0).0;
        assert!(
            pixel[0] > pixel[2],
            "package preview must win over fallback"
        );
    }

    #[test]
    fn install_preview_normalizes_a_single_wrapper_before_selection() {
        let temp = tempdir().expect("tempdir");
        let staging = temp.path().join("staging");
        let wrapper = staging.join("Downloaded Mod");
        fs::create_dir_all(&wrapper).expect("wrapper");
        fs::write(wrapper.join("mod.ini"), b"mod").expect("payload");
        fs::write(
            wrapper.join("preview.webp"),
            image_bytes(ImageFormat::WebP, [10, 220, 10]),
        )
        .expect("package preview");

        normalize_staged_mod_root(&staging).expect("normalize wrapper");
        install_required_preview(
            &staging,
            &PreparedInstallPreview::Unavailable("fallback unavailable".to_string()),
        )
        .expect("package preview should be sufficient");

        assert!(!wrapper.exists());
        assert_eq!(fs::read(staging.join("mod.ini")).unwrap(), b"mod");
        assert!(staging.join("preview.jpg").is_file());
        assert!(!staging.join("preview.webp").exists());
    }

    #[test]
    fn missing_required_preview_never_replaces_the_existing_mod() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let archive_path = temp.path().join("update.zip");
        fs::create_dir(&save_path).expect("existing mod");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        let file = fs::File::create(&archive_path).expect("archive");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("new.pak", FileOptions::<()>::default())
            .expect("entry");
        writer.write_all(b"new").expect("payload");
        writer.finish().expect("finish");
        let fallback = PreparedInstallPreview::Unavailable("fallback failed".to_string());

        let error = stage_and_deploy_zip_archive(
            &archive_path,
            &save_path,
            true,
            Some(&fallback),
            ArchiveDeploymentContext {
                is_nte_archive: false,
                trusted_library_root: None,
                journal: None,
                bound_destination: None,
                generic_mutation: None,
            },
        )
        .expect_err("preview is required");

        assert!(error.contains("preview") || error.contains("Preview"));
        assert_eq!(fs::read(save_path.join("old.pak")).unwrap(), b"old");
        assert!(!save_path.join("new.pak").exists());
        assert_eq!(
            fs::read_dir(temp.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains("imm-staging"))
                .count(),
            0
        );
    }

    #[test]
    fn generic_preview_backfill_replaces_only_preview_files_transactionally() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let downloaded = temp.path().join("preview.jpg");
        fs::create_dir(&save_path).expect("existing mod");
        fs::write(save_path.join("payload.ini"), b"keep").expect("payload");
        fs::write(save_path.join("preview.png"), b"old").expect("old preview");
        let jpeg = remote_media::decode_and_reencode_preview_jpeg(&image_bytes(
            ImageFormat::Png,
            [20, 30, 40],
        ))
        .expect("normalized jpeg");
        fs::write(&downloaded, &jpeg).expect("downloaded preview");

        stage_and_deploy_generic_preview(&downloaded, &save_path, None).expect("preview backfill");

        assert_eq!(fs::read(save_path.join("payload.ini")).unwrap(), b"keep");
        assert!(!save_path.join("preview.png").exists());
        assert_eq!(fs::read(save_path.join("preview.jpg")).unwrap(), jpeg);
        let leftovers = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("imm-preview-staging") || name.contains("imm-backup"))
            .collect::<Vec<_>>();
        assert!(
            leftovers.is_empty(),
            "unexpected transaction leftovers: {leftovers:?}"
        );
    }

    #[test]
    fn generic_preview_backfill_uses_global_and_library_wals() {
        let temp = tempdir().expect("tempdir");
        let runtime = temp.path().join("runtime");
        let control = temp.path().join("control");
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let managed_root = source.join(MANAGED_SOURCE_DIR);
        let save_path = managed_root.join("Characters").join("Demo");
        let downloaded = temp.path().join("preview.jpg");
        fs::create_dir_all(&runtime).expect("runtime");
        fs::create_dir_all(&save_path).expect("save path");
        fs::create_dir_all(&target).expect("target");
        fs::create_dir_all(&control).expect("control");
        fs::write(save_path.join("payload.ini"), b"keep").expect("payload");
        fs::write(
            &downloaded,
            remote_media::decode_and_reencode_preview_jpeg(&image_bytes(
                ImageFormat::Png,
                [20, 30, 40],
            ))
            .expect("normalized preview"),
        )
        .expect("downloaded preview");
        fs::write(
            runtime.join("configWW.json"),
            serde_json::to_vec(&serde_json::json!({
                "game": "WW",
                "sourceDir": source,
                "targetDir": target
            }))
            .expect("config"),
        )
        .expect("write config");

        mod_mutation::with_global_lock(&control, |registry| {
            recover_generic_mod_mutation_registry(&runtime, registry)?;
            let trusted_root = persisted_managed_source_root(&runtime, "WW")?;
            stage_and_deploy_generic_preview(
                &downloaded,
                &save_path,
                Some(GenericModMutationContext {
                    operation: "preview_backfill",
                    game: "WW",
                    trusted_root: &trusted_root,
                    registry,
                    state: None,
                }),
            )
        })
        .expect("coordinated preview backfill");

        assert_eq!(fs::read(save_path.join("payload.ini")).unwrap(), b"keep");
        assert!(save_path.join("preview.jpg").is_file());
        assert!(control
            .join("mod-mutations")
            .join("mod-mutation.wal")
            .metadata()
            .is_ok_and(|metadata| metadata.len() > 0));
        assert!(managed_root
            .join(".imm-mod-mutation.wal")
            .metadata()
            .is_ok_and(|metadata| metadata.len() > 0));
    }

    fn generic_registry_fixture(root: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let runtime = root.join("runtime");
        let control = root.join("control");
        let source = root.join("source");
        let target = root.join("target");
        let save_path = source
            .join(MANAGED_SOURCE_DIR)
            .join("Characters")
            .join("Demo");
        fs::create_dir_all(&runtime).expect("runtime");
        fs::create_dir_all(&control).expect("control");
        fs::create_dir_all(&target).expect("target");
        fs::create_dir_all(&save_path).expect("save path");
        fs::write(
            runtime.join("configWW.json"),
            serde_json::to_vec(&serde_json::json!({
                "game": "WW",
                "sourceDir": source,
                "targetDir": target
            }))
            .expect("config"),
        )
        .expect("write config");
        let trusted_root = persisted_managed_source_root(&runtime, "WW").expect("managed root");
        (runtime, control, trusted_root, save_path)
    }

    fn generic_registry_plan(
        trusted_root: &Path,
        before_hash: Option<String>,
        after_hash: String,
    ) -> GenericModMutationRegistryPlan {
        GenericModMutationRegistryPlan {
            schema_version: 1,
            operation: "preview_backfill".to_string(),
            game: "WW".to_string(),
            trusted_root: trusted_root.to_string_lossy().into_owned(),
            destination_relative_path: "Characters/Demo".to_string(),
            before_hash,
            after_hash,
            state: None,
        }
    }

    #[test]
    fn generic_registry_recovers_prepared_transaction_to_before_state() {
        let temp = tempdir().expect("tempdir");
        let (runtime, control, trusted_root, save_path) = generic_registry_fixture(temp.path());
        fs::write(save_path.join("payload.ini"), b"before").expect("before payload");
        let before_hash = optional_deployment_tree_hash(&save_path).expect("before hash");
        let after_tree = temp.path().join("after-tree");
        fs::create_dir(&after_tree).expect("after tree");
        fs::write(after_tree.join("payload.ini"), b"after").expect("after payload");
        let plan = generic_registry_plan(
            &trusted_root,
            before_hash.clone(),
            deployment_tree_hash(&after_tree).expect("after hash"),
        );

        mod_mutation::with_global_lock(&control, |registry| {
            registry.begin(&serde_json::to_vec(&plan).expect("plan"))?;
            Ok(())
        })
        .expect("prepared registry");

        mod_mutation::with_global_lock(&control, |registry| {
            recover_generic_mod_mutation_registry(&runtime, registry)?;
            assert!(registry.incomplete_transaction()?.is_none());
            Ok(())
        })
        .expect("recover before state");
        assert_eq!(
            optional_deployment_tree_hash(&save_path).expect("current hash"),
            before_hash
        );
    }

    #[test]
    fn generic_registry_finishes_cleanup_after_committed_state() {
        let temp = tempdir().expect("tempdir");
        let (runtime, control, trusted_root, save_path) = generic_registry_fixture(temp.path());
        fs::write(save_path.join("payload.ini"), b"before").expect("before payload");
        let before_hash = optional_deployment_tree_hash(&save_path).expect("before hash");
        fs::write(save_path.join("payload.ini"), b"after").expect("after payload");
        let after_hash = deployment_tree_hash(&save_path).expect("after hash");
        let plan = generic_registry_plan(&trusted_root, before_hash, after_hash.clone());

        mod_mutation::with_global_lock(&control, |registry| {
            let transaction_id = registry.begin(&serde_json::to_vec(&plan).expect("plan"))?;
            registry.append(transaction_id, nte_wal::WalState::Committing, b"{}")?;
            registry.append(
                transaction_id,
                nte_wal::WalState::StepReceipt,
                br#"{"step":"filesystem","outcome":"applied"}"#,
            )?;
            registry.append(transaction_id, nte_wal::WalState::CommittedAfter, b"{}")
        })
        .expect("committed registry");

        mod_mutation::with_global_lock(&control, |registry| {
            recover_generic_mod_mutation_registry(&runtime, registry)?;
            assert!(registry.incomplete_transaction()?.is_none());
            Ok(())
        })
        .expect("finish committed cleanup");
        assert_eq!(
            deployment_tree_hash(&save_path).expect("current hash"),
            after_hash
        );
    }

    #[test]
    fn generic_registry_fails_closed_for_ambiguous_target_hash() {
        let temp = tempdir().expect("tempdir");
        let (runtime, control, trusted_root, save_path) = generic_registry_fixture(temp.path());
        fs::write(save_path.join("payload.ini"), b"before").expect("before payload");
        let before_hash = optional_deployment_tree_hash(&save_path).expect("before hash");
        let after_tree = temp.path().join("after-tree");
        fs::create_dir(&after_tree).expect("after tree");
        fs::write(after_tree.join("payload.ini"), b"after").expect("after payload");
        let plan = generic_registry_plan(
            &trusted_root,
            before_hash,
            deployment_tree_hash(&after_tree).expect("after hash"),
        );
        fs::write(save_path.join("payload.ini"), b"ambiguous").expect("ambiguous payload");

        mod_mutation::with_global_lock(&control, |registry| {
            registry.begin(&serde_json::to_vec(&plan).expect("plan"))?;
            Ok(())
        })
        .expect("prepared registry");

        let error = mod_mutation::with_global_lock(&control, |registry| {
            recover_generic_mod_mutation_registry(&runtime, registry)
        })
        .expect_err("ambiguous state must fail closed");
        assert!(error.contains("neither its before nor after state"));
        mod_mutation::with_global_lock(&control, |registry| {
            assert_eq!(
                registry
                    .incomplete_transaction()?
                    .expect("transaction remains incomplete")
                    .state,
                nte_wal::WalState::Committing
            );
            Ok(())
        })
        .expect("inspect unresolved registry");
        assert_eq!(
            fs::read(save_path.join("payload.ini")).unwrap(),
            b"ambiguous"
        );
    }

    fn prepare_incomplete_mod_library_update(
        trusted_root: &Path,
        save_path: &Path,
        suffix: &str,
        deploy_after: bool,
    ) -> (Option<String>, String, PathBuf, PathBuf) {
        let canonical_destination = nte::canonical_nte_library_destination(trusted_root, save_path)
            .expect("canonical destination");
        let destination_relative_path = canonical_destination
            .strip_prefix(trusted_root)
            .expect("relative destination")
            .to_string_lossy()
            .replace('\\', "/");
        let staging_name = format!(".Demo.imm-staging-{suffix}");
        let backup_name = format!(".Demo.imm-backup-{suffix}");
        let staging_path = save_path.parent().unwrap().join(&staging_name);
        let backup_path = save_path.parent().unwrap().join(&backup_name);
        fs::create_dir(&staging_path).expect("staging");
        fs::write(staging_path.join("payload.ini"), b"after").expect("after payload");
        let before_hash = optional_deployment_tree_hash(save_path).expect("before hash");
        let after_hash = deployment_tree_hash(&staging_path).expect("after hash");
        let plan = NteLibraryWalPlan {
            operation: "library_update".to_string(),
            destination_relative_path,
            staging_name,
            backup_name,
            before_hash: before_hash.clone(),
            after_hash: after_hash.clone(),
        };
        let mut journal =
            nte_wal::WalJournal::open_mod_mutation(&trusted_root.join(".imm-mod-mutation.wal"))
                .expect("library journal");
        let transaction_id = journal
            .begin(&serde_json::to_vec(&plan).expect("plan"))
            .expect("prepared");
        journal
            .append(transaction_id, nte_wal::WalState::Committing, b"{}")
            .expect("committing");
        fs::rename(save_path, &backup_path).expect("backup rename");
        journal
            .append(transaction_id, nte_wal::WalState::StepReceipt, b"backup")
            .expect("backup receipt");
        if deploy_after {
            fs::rename(&staging_path, save_path).expect("deploy rename");
            journal
                .append(transaction_id, nte_wal::WalState::StepReceipt, b"deploy")
                .expect("deploy receipt");
        }
        drop(journal);
        (before_hash, after_hash, staging_path, backup_path)
    }

    fn state_aware_registry_plan(
        trusted_root: &Path,
        before_hash: Option<String>,
        after_hash: String,
        before_game_config_hash: String,
        after_game_config_hash: String,
    ) -> GenericModMutationRegistryPlan {
        GenericModMutationRegistryPlan {
            schema_version: 2,
            operation: "gamebanana_binding".to_string(),
            game: "WW".to_string(),
            trusted_root: trusted_root.to_string_lossy().into_owned(),
            destination_relative_path: "Characters/Demo".to_string(),
            before_hash,
            after_hash,
            state: Some(GenericModMutationStatePlan {
                before_game_config_hash,
                after_game_config_hash,
            }),
        }
    }

    #[test]
    fn state_aware_registry_rolls_filesystem_back_when_config_is_before() {
        let temp = tempdir().expect("tempdir");
        let (runtime, control, trusted_root, save_path) = generic_registry_fixture(temp.path());
        fs::write(save_path.join("payload.ini"), b"before").expect("before payload");
        let before_config: serde_json::Value =
            serde_json::from_slice(&fs::read(runtime.join("configWW.json")).unwrap()).unwrap();
        let mut after_config = before_config.clone();
        after_config["data"] =
            serde_json::json!({"Characters/Demo": {"source": "https://gamebanana.com/mods/42"}});
        let (before_hash, after_hash, staging_path, backup_path) =
            prepare_incomplete_mod_library_update(&trusted_root, &save_path, "1-40", true);
        let plan = state_aware_registry_plan(
            &trusted_root,
            before_hash,
            after_hash,
            app_state::stable_json_value_hash(&before_config).unwrap(),
            app_state::stable_json_value_hash(&after_config).unwrap(),
        );
        mod_mutation::with_global_lock(&control, |registry| {
            registry.begin(&serde_json::to_vec(&plan).expect("plan"))?;
            Ok(())
        })
        .expect("central prepared");

        mod_mutation::with_global_lock(&control, |registry| {
            recover_generic_mod_mutation_registry(&runtime, registry)?;
            assert!(registry.incomplete_transaction()?.is_none());
            Ok(())
        })
        .expect("outer rollback");

        assert_eq!(fs::read(save_path.join("payload.ini")).unwrap(), b"before");
        assert!(!staging_path.exists());
        assert!(!backup_path.exists());
        mod_mutation::with_library_lock(&trusted_root, |journal| {
            assert!(journal.incomplete_transaction()?.is_none());
            Ok(())
        })
        .expect("library cleanup complete");
    }

    #[test]
    fn state_aware_registry_rolls_filesystem_forward_when_config_is_after() {
        let temp = tempdir().expect("tempdir");
        let (runtime, control, trusted_root, save_path) = generic_registry_fixture(temp.path());
        fs::write(save_path.join("payload.ini"), b"before").expect("before payload");
        let before_config: serde_json::Value =
            serde_json::from_slice(&fs::read(runtime.join("configWW.json")).unwrap()).unwrap();
        let mut after_config = before_config.clone();
        after_config["data"] =
            serde_json::json!({"Characters/Demo": {"source": "https://gamebanana.com/mods/42"}});
        let (before_hash, after_hash, staging_path, backup_path) =
            prepare_incomplete_mod_library_update(&trusted_root, &save_path, "1-41", false);
        let plan = state_aware_registry_plan(
            &trusted_root,
            before_hash,
            after_hash,
            app_state::stable_json_value_hash(&before_config).unwrap(),
            app_state::stable_json_value_hash(&after_config).unwrap(),
        );
        fs::write(
            runtime.join("configWW.json"),
            serde_json::to_vec(&after_config).unwrap(),
        )
        .expect("publish after config projection");
        mod_mutation::with_global_lock(&control, |registry| {
            registry.begin(&serde_json::to_vec(&plan).expect("plan"))?;
            Ok(())
        })
        .expect("central prepared");

        mod_mutation::with_global_lock(&control, |registry| {
            recover_generic_mod_mutation_registry(&runtime, registry)?;
            assert!(registry.incomplete_transaction()?.is_none());
            Ok(())
        })
        .expect("outer roll-forward");

        assert_eq!(fs::read(save_path.join("payload.ini")).unwrap(), b"after");
        assert!(!staging_path.exists());
        assert!(!backup_path.exists());
        mod_mutation::with_library_lock(&trusted_root, |journal| {
            assert!(journal.incomplete_transaction()?.is_none());
            Ok(())
        })
        .expect("library cleanup complete");
    }

    #[test]
    fn gamebanana_binding_commits_preview_and_metadata_together() {
        let temp = tempdir().expect("tempdir");
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let save_path = source
            .join(MANAGED_SOURCE_DIR)
            .join("Characters")
            .join("Demo");
        fs::create_dir_all(&save_path).expect("save path");
        fs::create_dir_all(&target).expect("target");
        fs::write(save_path.join("payload.ini"), b"keep").expect("payload");
        fs::write(save_path.join("preview.png"), b"old").expect("old preview");
        let downloaded = temp.path().join("downloaded-preview.jpg");
        let jpeg = remote_media::decode_and_reencode_preview_jpeg(&image_bytes(
            ImageFormat::Png,
            [30, 60, 90],
        ))
        .expect("normalized jpeg");
        fs::write(&downloaded, &jpeg).expect("downloaded preview");

        let repository = app_state::AppStateRepository::new(
            temp.path().join("control"),
            temp.path().join("legacy"),
            true,
        );
        assert!(matches!(
            repository.bootstrap(),
            app_state::BootstrapStatus::Ready { .. }
        ));
        let loaded = repository.load_config(Some("WW")).expect("load WW");
        let mut configured_game = loaded.game.expect("WW game");
        configured_game["sourceDir"] =
            serde_json::Value::String(source.to_string_lossy().into_owned());
        configured_game["targetDir"] =
            serde_json::Value::String(target.to_string_lossy().into_owned());
        let configured = repository
            .save_config(None, Some(configured_game), None, loaded.game_revision)
            .expect("configure WW");
        let expected_revision = configured.game_revision.expect("configured revision");
        let mut next_game = configured.game.expect("configured WW");
        next_game["data"] = serde_json::json!({
            "Characters/Demo": {
                "source": "https://gamebanana.com/mods/42",
                "gameBanana": {
                    "provider": "gamebanana",
                    "modId": 42,
                    "profileUrl": "https://gamebanana.com/mods/42",
                    "variant": "primary",
                    "boundAt": 1000,
                    "selectedFile": {
                        "id": "7",
                        "name": "demo.zip",
                        "size": 1200,
                        "updatedAt": 100
                    }
                }
            }
        });

        let control_root = repository.control_root().to_path_buf();
        let runtime_root = repository.runtime_root().to_path_buf();
        let committed = mod_mutation::with_global_lock(&control_root, |registry| {
            recover_generic_mod_mutation_registry(&runtime_root, registry)?;
            let preflight =
                repository.preflight_game_config_update("WW", &next_game, expected_revision)?;
            let state_plan = GenericModMutationStatePlan {
                before_game_config_hash: preflight.before_game_config_hash,
                after_game_config_hash: preflight.after_game_config_hash,
            };
            let trusted_root = persisted_managed_source_root(&runtime_root, "WW")?;
            let mut committed_snapshot = None;
            {
                let snapshot_slot = &mut committed_snapshot;
                let commit_plan = state_plan.clone();
                let commit_config = next_game.clone();
                stage_and_deploy_generic_preview(
                    &downloaded,
                    &save_path,
                    Some(GenericModMutationContext {
                        operation: "gamebanana_binding",
                        game: "WW",
                        trusted_root: &trusted_root,
                        registry,
                        state: Some(GenericStateMutation {
                            plan: state_plan,
                            commit: Box::new(|| {
                                *snapshot_slot = Some(commit_game_config_for_mod_mutation(
                                    &repository,
                                    "WW",
                                    commit_config,
                                    expected_revision,
                                    &commit_plan,
                                )?);
                                Ok(())
                            }),
                        }),
                    }),
                )?;
            }
            assert!(registry.incomplete_transaction()?.is_none());
            committed_snapshot.ok_or_else(|| "missing committed snapshot".to_string())
        })
        .expect("binding transaction");

        assert_eq!(fs::read(save_path.join("payload.ini")).unwrap(), b"keep");
        assert!(!save_path.join("preview.png").exists());
        assert_eq!(fs::read(save_path.join("preview.jpg")).unwrap(), jpeg);
        assert_eq!(
            committed.game.as_ref().unwrap()["data"]["Characters/Demo"]["gameBanana"]["modId"],
            42
        );
        assert_eq!(committed.game_revision, Some(expected_revision + 1));
        let trusted_root = persisted_managed_source_root(&runtime_root, "WW").unwrap();
        mod_mutation::with_library_lock(&trusted_root, |journal| {
            assert!(journal.incomplete_transaction()?.is_none());
            Ok(())
        })
        .expect("library cleanup complete");
    }

    fn gamebanana_download_request(
        expected_data_entry: Option<serde_json::Value>,
    ) -> GameBananaDownloadState {
        GameBananaDownloadState {
            relative_path: "Characters/Demo".to_string(),
            source: "https://gamebanana.com/mods/42".to_string(),
            updated_at: 123_000,
            viewed_at: 456_000,
            config_updated_at: "2026-08-04T00:00:00.000Z".to_string(),
            completed_download: serde_json::json!({
                "status": "extracting",
                "addon": false,
                "preview": "https://images.gamebanana.com/img/ss/mods/demo.png",
                "category": "Characters",
                "source": "https://gamebanana.com/mods/42",
                "file": "https://gamebanana.com/dl/7",
                "updated": 123,
                "name": "Demo",
                "fname": "demo.zip",
                "key": "download-42-7",
                "path": "Characters\\Demo",
                "gameBananaModId": 42,
                "gameBananaFileId": "7",
                "expectedSize": 1200
            }),
            expected_data_entry,
        }
    }

    #[test]
    fn gamebanana_download_commits_payload_preview_metadata_and_history_together() {
        let temp = tempdir().expect("tempdir");
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let managed_root = source.join(MANAGED_SOURCE_DIR);
        let category_root = managed_root.join("Characters");
        let save_path = category_root.join("Demo");
        fs::create_dir_all(&category_root).expect("category root");
        fs::create_dir_all(&target).expect("target");

        let repository = app_state::AppStateRepository::new(
            temp.path().join("control"),
            temp.path().join("legacy"),
            true,
        );
        assert!(matches!(
            repository.bootstrap(),
            app_state::BootstrapStatus::Ready { .. }
        ));
        let loaded = repository.load_config(Some("WW")).expect("load WW");
        let mut configured_game = loaded.game.expect("WW game");
        configured_game["sourceDir"] =
            serde_json::Value::String(source.to_string_lossy().into_owned());
        configured_game["targetDir"] =
            serde_json::Value::String(target.to_string_lossy().into_owned());
        configured_game["downloads"]["downloading"] = serde_json::json!([{
            "status": "downloading",
            "addon": false,
            "preview": "https://images.gamebanana.com/img/ss/mods/demo.png",
            "category": "Characters",
            "source": "https://gamebanana.com/mods/42",
            "file": "https://gamebanana.com/dl/7",
            "updated": 123,
            "name": "Demo",
            "fname": "demo.zip",
            "key": "download-42-7"
        }]);
        let configured = repository
            .save_config(None, Some(configured_game), None, loaded.game_revision)
            .expect("configure WW");
        let configured_revision = configured.game_revision.expect("configured revision");

        let archive_path = temp.path().join("download.zip");
        let file = fs::File::create(&archive_path).expect("archive");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("new.pak", FileOptions::<()>::default())
            .expect("payload entry");
        writer.write_all(b"new payload").expect("payload");
        writer
            .start_file("preview.png", FileOptions::<()>::default())
            .expect("preview entry");
        writer
            .write_all(&image_bytes(ImageFormat::Png, [70, 80, 90]))
            .expect("preview");
        writer.finish().expect("finish archive");

        let request = gamebanana_download_request(None);
        let control_root = repository.control_root().to_path_buf();
        let runtime_root = repository.runtime_root().to_path_buf();
        let fallback = PreparedInstallPreview::Unavailable("fallback unavailable".to_string());
        let trusted_root = persisted_managed_source_root(&runtime_root, "WW").unwrap();
        let mut prepared_archive = prepare_bound_archive_staging(
            &archive_path,
            &save_path,
            true,
            false,
            Some(&fallback),
            &trusted_root,
        )
        .expect("prepare archive outside global lock");
        let committed = mod_mutation::with_global_lock(&control_root, |registry| {
            recover_generic_mod_mutation_registry(&runtime_root, registry)?;
            let prepared =
                prepare_gamebanana_download_state(&repository, "WW", &request, &save_path)?;
            let state_plan = prepared.plan.clone();
            let mut committed_snapshot = None;
            {
                let snapshot_slot = &mut committed_snapshot;
                deploy_prepared_generic_archive(
                    &mut prepared_archive,
                    &save_path,
                    GenericModMutationContext {
                        operation: "gamebanana_download",
                        game: "WW",
                        trusted_root: &trusted_root,
                        registry,
                        state: Some(GenericStateMutation {
                            plan: state_plan,
                            commit: Box::new(|| {
                                *snapshot_slot = Some(commit_game_config_for_mod_mutation(
                                    &repository,
                                    "WW",
                                    prepared.next_game,
                                    prepared.expected_game_revision,
                                    &prepared.plan,
                                )?);
                                Ok(())
                            }),
                        }),
                    },
                )?;
            }
            committed_snapshot.ok_or_else(|| "missing committed snapshot".to_string())
        })
        .expect("download transaction");

        assert_eq!(fs::read(save_path.join("new.pak")).unwrap(), b"new payload");
        assert!(save_path.join("preview.jpg").is_file());
        assert!(!save_path.join("preview.png").exists());
        let game = committed.game.as_ref().expect("committed game");
        assert_eq!(game["data"]["Characters\\Demo"]["gameBanana"]["modId"], 42);
        assert_eq!(
            game["data"]["Characters\\Demo"]["gameBanana"]["selectedFile"]["id"],
            "7"
        );
        assert!(game["downloads"]["downloading"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(game["downloads"]["completed"].as_array().unwrap().len(), 1);
        assert_eq!(committed.game_revision, Some(configured_revision + 1));
    }

    #[test]
    fn stale_gamebanana_download_metadata_is_rejected_without_publishing_files() {
        let temp = tempdir().expect("tempdir");
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let save_path = source
            .join(MANAGED_SOURCE_DIR)
            .join("Characters")
            .join("Demo");
        fs::create_dir_all(&save_path).expect("existing mod");
        fs::create_dir_all(&target).expect("target");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        let repository = app_state::AppStateRepository::new(
            temp.path().join("control"),
            temp.path().join("legacy"),
            true,
        );
        assert!(matches!(
            repository.bootstrap(),
            app_state::BootstrapStatus::Ready { .. }
        ));
        let loaded = repository.load_config(Some("WW")).expect("load WW");
        let mut configured_game = loaded.game.expect("WW game");
        configured_game["sourceDir"] =
            serde_json::Value::String(source.to_string_lossy().into_owned());
        configured_game["targetDir"] =
            serde_json::Value::String(target.to_string_lossy().into_owned());
        configured_game["data"] = serde_json::json!({
            "Characters\\Demo": {"source": "https://gamebanana.com/mods/99"}
        });
        repository
            .save_config(None, Some(configured_game), None, loaded.game_revision)
            .expect("configure WW");

        let error = prepare_gamebanana_download_state(
            &repository,
            "WW",
            &gamebanana_download_request(None),
            &save_path,
        )
        .expect_err("stale target metadata must reject the download commit");
        assert!(error.contains("metadata changed"));
        assert_eq!(fs::read(save_path.join("old.pak")).unwrap(), b"old");
        let visible = repository.load_config(Some("WW")).expect("visible config");
        assert_eq!(
            visible.game.as_ref().unwrap()["data"]["Characters\\Demo"]["source"],
            "https://gamebanana.com/mods/99"
        );
        assert!(visible.game.as_ref().unwrap()["downloads"]["completed"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn staged_deployment_restores_existing_mod_when_switch_fails() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        let missing_staging = temp.path().join("missing-staging");

        assert!(deploy_staged_directory(&save_path, &missing_staging, None, None, None).is_err());
        assert_eq!(
            fs::read(save_path.join("old.pak")).expect("restored"),
            b"old"
        );
    }

    #[test]
    fn post_filesystem_commit_failure_restores_existing_mod() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = deployment_sibling_path(&save_path, "staging").expect("staging path");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");

        let error = mod_mutation::with_library_lock(temp.path(), |journal| {
            nte::with_bound_nte_library_destination(
                temp.path(),
                &save_path,
                |destination_parent, destination_name| {
                    let staging =
                        create_bound_staging_directory(destination_parent, &staging_path)?;
                    fs::write(staging_path.join("new.pak"), b"new")
                        .map_err(|err| err.to_string())?;
                    deploy_staged_directory_with_commit(
                        &save_path,
                        &staging_path,
                        Some(temp.path()),
                        Some(journal),
                        Some(BoundNteDeployment {
                            parent: destination_parent,
                            destination_name,
                            staging,
                        }),
                        || Err("state commit rejected".to_string()),
                    )
                },
            )
        })
        .expect_err("state failure must roll back the directory");

        assert!(error.contains("state commit rejected"));
        assert_eq!(fs::read(save_path.join("old.pak")).unwrap(), b"old");
        assert!(!save_path.join("new.pak").exists());
        assert!(!staging_path.exists());
        assert!(!deployment_sibling_path(&save_path, "backup")
            .expect("backup path")
            .exists());
    }

    #[test]
    fn staged_deployment_replaces_old_payload_after_validation() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = deployment_sibling_path(&save_path, "staging").expect("staging path");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");

        deploy_staged_directory(&save_path, &staging_path, None, None, None).expect("deploy");
        assert!(!save_path.join("old.pak").exists());
        assert_eq!(
            fs::read(save_path.join("new.pak")).expect("new payload"),
            b"new"
        );
    }

    #[test]
    fn nte_library_deployment_writes_a_complete_wal_transaction() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = deployment_sibling_path(&save_path, "staging").expect("staging path");
        let wal_path = temp.path().join(".imm-nte-library.wal");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");

        nte::with_nte_library_operation_lock(temp.path(), None, |journal| {
            nte::with_bound_nte_library_destination(
                temp.path(),
                &save_path,
                |destination_parent, destination_name| {
                    let staging = nte::open_bound_directory_for_rename(
                        destination_parent,
                        staging_path.file_name().unwrap(),
                        "test staging",
                    )?;
                    deploy_staged_directory(
                        &save_path,
                        &staging_path,
                        Some(temp.path()),
                        Some(journal),
                        Some(BoundNteDeployment {
                            parent: destination_parent,
                            destination_name,
                            staging,
                        }),
                    )
                },
            )
        })
        .expect("deploy with WAL");

        let summary = nte_wal::validate_or_repair(&wal_path).expect("valid WAL");
        assert_eq!(summary.valid_records, 6);
        assert!(!summary.repaired_tail);
        assert_eq!(
            fs::read(save_path.join("new.pak")).expect("new payload"),
            b"new"
        );
    }

    #[cfg(windows)]
    #[test]
    fn bound_nte_deployment_moves_the_open_staging_leaf() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = deployment_sibling_path(&save_path, "staging").expect("staging path");
        let attacker_path = temp.path().join("attacker-replacement");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");

        nte::with_nte_library_operation_lock(temp.path(), None, |journal| {
            nte::with_bound_nte_library_destination(
                temp.path(),
                &save_path,
                |destination_parent, destination_name| {
                    let staging_handle = nte::open_bound_directory_for_rename(
                        destination_parent,
                        staging_path.file_name().unwrap(),
                        "test staging",
                    )?;
                    assert!(fs::rename(&staging_path, &attacker_path).is_err());
                    deploy_staged_directory(
                        &save_path,
                        &staging_path,
                        Some(temp.path()),
                        Some(journal),
                        Some(BoundNteDeployment {
                            parent: destination_parent,
                            destination_name,
                            staging: staging_handle,
                        }),
                    )
                },
            )
        })
        .expect("bound deploy with WAL");

        assert!(!attacker_path.exists());
        assert_eq!(fs::read(save_path.join("new.pak")).unwrap(), b"new");
    }

    #[test]
    fn nte_preview_update_is_deployed_through_the_library_wal() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let downloaded = temp.path().join("downloaded-preview");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&downloaded).expect("download dir");
        fs::write(save_path.join("demo.pak"), b"pak").expect("payload");
        fs::write(save_path.join("preview.png"), b"old-preview").expect("old preview");
        fs::write(save_path.join("preview.jpg"), b"stale-preview").expect("stale preview");
        let preview = downloaded.join("preview.png");
        fs::write(&preview, b"new-preview").expect("downloaded preview");

        nte::with_nte_library_operation_lock(temp.path(), None, |journal| {
            nte::with_bound_nte_library_destination(
                temp.path(),
                &save_path,
                |destination_parent, destination_name| {
                    stage_and_deploy_nte_preview(
                        &preview,
                        &save_path,
                        temp.path(),
                        journal,
                        destination_parent,
                        destination_name,
                    )
                },
            )
        })
        .expect("preview deploy with WAL");

        assert_eq!(fs::read(save_path.join("demo.pak")).unwrap(), b"pak");
        assert_eq!(
            fs::read(save_path.join("preview.png")).unwrap(),
            b"new-preview"
        );
        assert!(!save_path.join("preview.jpg").exists());
        let summary = nte_wal::validate_or_repair(&temp.path().join(".imm-nte-library.wal"))
            .expect("valid WAL");
        assert_eq!(summary.valid_records, 6);
    }

    #[test]
    fn nested_nte_library_deployment_keeps_lock_and_wal_at_managed_root() {
        let temp = tempdir().expect("tempdir");
        let managed_root = temp.path().join("managed-root");
        let category = managed_root.join("Characters");
        let save_path = category.join("nested-mod");
        let staging_path = deployment_sibling_path(&save_path, "staging").expect("staging path");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");

        nte::with_nte_library_operation_lock(&managed_root, None, |journal| {
            nte::with_bound_nte_library_destination(
                &managed_root,
                &save_path,
                |destination_parent, destination_name| {
                    let staging = nte::open_bound_directory_for_rename(
                        destination_parent,
                        staging_path.file_name().unwrap(),
                        "test nested staging",
                    )?;
                    deploy_staged_directory(
                        &save_path,
                        &staging_path,
                        Some(&managed_root),
                        Some(journal),
                        Some(BoundNteDeployment {
                            parent: destination_parent,
                            destination_name,
                            staging,
                        }),
                    )
                },
            )
        })
        .expect("nested deploy with WAL");

        let wal_path = managed_root.join(".imm-nte-library.wal");
        let lock_path = managed_root.join(".imm-nte-library.lock");
        assert!(wal_path.is_file());
        assert!(lock_path.is_file());
        assert!(!category.join(".imm-nte-library.wal").exists());
        assert!(!category.join(".imm-nte-library.lock").exists());
        assert_eq!(
            fs::read(save_path.join("new.pak")).expect("new payload"),
            b"new"
        );
        let summary = nte_wal::validate_or_repair(&wal_path).expect("valid WAL");
        assert_eq!(summary.valid_records, 5);
    }

    #[test]
    fn prepared_nte_library_transaction_recovers_before_new_deployment() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = temp.path().join(".managed-mod.imm-staging-1-1");
        let backup_path = temp.path().join(".managed-mod.imm-backup-1-1");
        let wal_path = temp.path().join(".imm-nte-library.wal");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");
        let mut journal = nte_wal::WalJournal::open(&wal_path).expect("journal");
        let plan = NteLibraryWalPlan {
            operation: "library_update".to_string(),
            destination_relative_path: "managed-mod".to_string(),
            staging_name: ".managed-mod.imm-staging-1-1".to_string(),
            backup_name: ".managed-mod.imm-backup-1-1".to_string(),
            before_hash: optional_deployment_tree_hash(&save_path).expect("before hash"),
            after_hash: deployment_tree_hash(&staging_path).expect("after hash"),
        };
        journal
            .begin(&serde_json::to_vec(&plan).expect("plan"))
            .expect("incomplete transaction");
        drop(journal);

        let result = nte::with_nte_library_operation_lock(temp.path(), None, |journal| {
            recover_nte_library_transaction(temp.path(), journal)
        });

        assert!(result.is_ok());
        assert_eq!(
            fs::read(save_path.join("old.pak")).expect("old payload"),
            b"old"
        );
        assert!(!staging_path.exists());
        assert!(!backup_path.exists());
    }

    #[test]
    fn nte_library_recovery_rolls_back_from_verified_backup() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = temp.path().join(".managed-mod.imm-staging-1-2");
        let backup_path = temp.path().join(".managed-mod.imm-backup-1-2");
        let wal_path = temp.path().join(".imm-nte-library.wal");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");
        let plan = NteLibraryWalPlan {
            operation: "library_update".to_string(),
            destination_relative_path: "managed-mod".to_string(),
            staging_name: ".managed-mod.imm-staging-1-2".to_string(),
            backup_name: ".managed-mod.imm-backup-1-2".to_string(),
            before_hash: optional_deployment_tree_hash(&save_path).expect("before hash"),
            after_hash: deployment_tree_hash(&staging_path).expect("after hash"),
        };
        let mut journal = nte_wal::WalJournal::open(&wal_path).expect("journal");
        let transaction_id = journal
            .begin(&serde_json::to_vec(&plan).expect("plan"))
            .expect("prepared");
        journal
            .append(transaction_id, nte_wal::WalState::Committing, b"{}")
            .expect("committing");
        fs::rename(&save_path, &backup_path).expect("backup rename");
        journal
            .append(
                transaction_id,
                nte_wal::WalState::StepReceipt,
                br#"{"step":"backup_previous","outcome":"applied"}"#,
            )
            .expect("receipt");
        drop(journal);

        nte::with_nte_library_operation_lock(temp.path(), None, |journal| {
            recover_nte_library_transaction(temp.path(), journal)
        })
        .expect("rollback recovery");

        assert_eq!(fs::read(save_path.join("old.pak")).unwrap(), b"old");
        assert!(!staging_path.exists());
        assert!(!backup_path.exists());
    }

    #[test]
    fn nte_library_recovery_rolls_forward_verified_after_state() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = temp.path().join(".managed-mod.imm-staging-1-3");
        let backup_path = temp.path().join(".managed-mod.imm-backup-1-3");
        let wal_path = temp.path().join(".imm-nte-library.wal");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");
        let plan = NteLibraryWalPlan {
            operation: "library_update".to_string(),
            destination_relative_path: "managed-mod".to_string(),
            staging_name: ".managed-mod.imm-staging-1-3".to_string(),
            backup_name: ".managed-mod.imm-backup-1-3".to_string(),
            before_hash: optional_deployment_tree_hash(&save_path).expect("before hash"),
            after_hash: deployment_tree_hash(&staging_path).expect("after hash"),
        };
        let mut journal = nte_wal::WalJournal::open(&wal_path).expect("journal");
        let transaction_id = journal
            .begin(&serde_json::to_vec(&plan).expect("plan"))
            .expect("prepared");
        journal
            .append(transaction_id, nte_wal::WalState::Committing, b"{}")
            .expect("committing");
        fs::rename(&save_path, &backup_path).expect("backup rename");
        fs::rename(&staging_path, &save_path).expect("deploy rename");
        journal
            .append(
                transaction_id,
                nte_wal::WalState::StepReceipt,
                br#"{"step":"deploy_staging","outcome":"applied"}"#,
            )
            .expect("receipt");
        drop(journal);

        nte::with_nte_library_operation_lock(temp.path(), None, |journal| {
            recover_nte_library_transaction(temp.path(), journal)
        })
        .expect("roll-forward recovery");

        assert_eq!(fs::read(save_path.join("new.pak")).unwrap(), b"new");
        assert!(!staging_path.exists());
        assert!(!backup_path.exists());
    }

    #[test]
    fn outer_state_forces_library_rollback_after_filesystem_apply() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = temp.path().join(".managed-mod.imm-staging-1-30");
        let backup_path = temp.path().join(".managed-mod.imm-backup-1-30");
        let wal_path = temp.path().join(".imm-nte-library.wal");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");
        let plan = NteLibraryWalPlan {
            operation: "library_update".to_string(),
            destination_relative_path: "managed-mod".to_string(),
            staging_name: ".managed-mod.imm-staging-1-30".to_string(),
            backup_name: ".managed-mod.imm-backup-1-30".to_string(),
            before_hash: optional_deployment_tree_hash(&save_path).expect("before hash"),
            after_hash: deployment_tree_hash(&staging_path).expect("after hash"),
        };
        let mut journal = nte_wal::WalJournal::open(&wal_path).expect("journal");
        let transaction_id = journal
            .begin(&serde_json::to_vec(&plan).expect("plan"))
            .expect("prepared");
        journal
            .append(transaction_id, nte_wal::WalState::Committing, b"{}")
            .expect("committing");
        fs::rename(&save_path, &backup_path).expect("backup rename");
        fs::rename(&staging_path, &save_path).expect("deploy rename");
        journal
            .append(transaction_id, nte_wal::WalState::StepReceipt, b"applied")
            .expect("receipt");
        drop(journal);

        nte::with_nte_library_operation_lock(temp.path(), None, |journal| {
            recover_nte_library_transaction_from_parent_with_preference(
                temp.path(),
                journal,
                LibraryRecoveryPreference::Before,
            )
        })
        .expect("forced rollback");

        assert_eq!(fs::read(save_path.join("old.pak")).unwrap(), b"old");
        assert!(!staging_path.exists());
        assert!(!backup_path.exists());
    }

    #[test]
    fn outer_state_forces_library_roll_forward_from_staging() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = temp.path().join(".managed-mod.imm-staging-1-31");
        let backup_path = temp.path().join(".managed-mod.imm-backup-1-31");
        let wal_path = temp.path().join(".imm-nte-library.wal");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");
        let plan = NteLibraryWalPlan {
            operation: "library_update".to_string(),
            destination_relative_path: "managed-mod".to_string(),
            staging_name: ".managed-mod.imm-staging-1-31".to_string(),
            backup_name: ".managed-mod.imm-backup-1-31".to_string(),
            before_hash: optional_deployment_tree_hash(&save_path).expect("before hash"),
            after_hash: deployment_tree_hash(&staging_path).expect("after hash"),
        };
        let mut journal = nte_wal::WalJournal::open(&wal_path).expect("journal");
        let transaction_id = journal
            .begin(&serde_json::to_vec(&plan).expect("plan"))
            .expect("prepared");
        journal
            .append(transaction_id, nte_wal::WalState::Committing, b"{}")
            .expect("committing");
        fs::rename(&save_path, &backup_path).expect("backup rename");
        journal
            .append(transaction_id, nte_wal::WalState::StepReceipt, b"backed-up")
            .expect("receipt");
        drop(journal);

        nte::with_nte_library_operation_lock(temp.path(), None, |journal| {
            recover_nte_library_transaction_from_parent_with_preference(
                temp.path(),
                journal,
                LibraryRecoveryPreference::After,
            )
        })
        .expect("forced roll-forward");

        assert_eq!(fs::read(save_path.join("new.pak")).unwrap(), b"new");
        assert!(!staging_path.exists());
        assert!(!backup_path.exists());
    }

    #[test]
    fn committed_library_update_rolls_forward_when_rename_persistence_lags_the_wal() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = temp.path().join(".managed-mod.imm-staging-1-4");
        let backup_path = temp.path().join(".managed-mod.imm-backup-1-4");
        let wal_path = temp.path().join(".imm-nte-library.wal");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");
        let plan = NteLibraryWalPlan {
            operation: "library_update".to_string(),
            destination_relative_path: "managed-mod".to_string(),
            staging_name: ".managed-mod.imm-staging-1-4".to_string(),
            backup_name: ".managed-mod.imm-backup-1-4".to_string(),
            before_hash: optional_deployment_tree_hash(&save_path).expect("before hash"),
            after_hash: deployment_tree_hash(&staging_path).expect("after hash"),
        };
        let mut journal = nte_wal::WalJournal::open(&wal_path).expect("journal");
        let transaction_id = journal
            .begin(&serde_json::to_vec(&plan).expect("plan"))
            .expect("prepared");
        journal
            .append(transaction_id, nte_wal::WalState::Committing, b"{}")
            .expect("committing");
        journal
            .append(transaction_id, nte_wal::WalState::StepReceipt, b"{}")
            .expect("receipt");
        journal
            .append(transaction_id, nte_wal::WalState::CommittedAfter, b"{}")
            .expect("committed");
        fs::rename(&save_path, &backup_path).expect("persisted backup rename");
        drop(journal);

        nte::with_nte_library_operation_lock(temp.path(), None, |journal| {
            recover_nte_library_transaction_from_parent(temp.path(), journal)
        })
        .expect("committed roll-forward");

        assert_eq!(fs::read(save_path.join("new.pak")).unwrap(), b"new");
        assert!(!staging_path.exists());
        assert!(!backup_path.exists());
    }

    #[test]
    fn aborted_before_library_terminal_discards_staging_without_redeploying_it() {
        let temp = tempdir().expect("tempdir");
        let save_path = temp.path().join("managed-mod");
        let staging_path = temp.path().join(".managed-mod.imm-staging-1-5");
        let backup_path = temp.path().join(".managed-mod.imm-backup-1-5");
        let wal_path = temp.path().join(".imm-nte-library.wal");
        fs::create_dir_all(&save_path).expect("save dir");
        fs::create_dir_all(&staging_path).expect("staging dir");
        fs::write(save_path.join("old.pak"), b"old").expect("old payload");
        fs::write(staging_path.join("new.pak"), b"new").expect("new payload");
        let plan = NteLibraryWalPlan {
            operation: "library_update".to_string(),
            destination_relative_path: "managed-mod".to_string(),
            staging_name: ".managed-mod.imm-staging-1-5".to_string(),
            backup_name: ".managed-mod.imm-backup-1-5".to_string(),
            before_hash: optional_deployment_tree_hash(&save_path).expect("before hash"),
            after_hash: deployment_tree_hash(&staging_path).expect("after hash"),
        };
        let mut journal = nte_wal::WalJournal::open(&wal_path).expect("journal");
        let transaction_id = journal
            .begin(&serde_json::to_vec(&plan).expect("plan"))
            .expect("prepared");
        journal
            .append(transaction_id, nte_wal::WalState::Committing, b"{}")
            .expect("committing");
        journal
            .append(transaction_id, nte_wal::WalState::AbortedBefore, b"{}")
            .expect("aborted before");
        drop(journal);

        nte::with_nte_library_operation_lock(temp.path(), None, |journal| {
            recover_nte_library_transaction_from_parent(temp.path(), journal)
        })
        .expect("aborted cleanup");

        assert_eq!(fs::read(save_path.join("old.pak")).unwrap(), b"old");
        assert!(!save_path.join("new.pak").exists());
        assert!(!staging_path.exists());
        assert!(!backup_path.exists());
    }

    #[test]
    fn library_cleanup_is_idempotent_when_the_destination_parent_is_missing() {
        let temp = tempdir().expect("tempdir");
        let plan = NteLibraryWalPlan {
            operation: "library_install".to_string(),
            destination_relative_path: "Missing/Demo".to_string(),
            staging_name: ".Demo.imm-staging-1-7".to_string(),
            backup_name: ".Demo.imm-backup-1-7".to_string(),
            before_hash: None,
            after_hash: "unused-cleanup-hash".to_string(),
        };

        let destination =
            nte::trusted_nte_library_destination(temp.path(), &plan.destination_relative_path)
                .expect("destination");
        let destination_parent = destination.parent().expect("destination parent");
        let staging = trusted_transaction_sibling(
            destination_parent,
            destination.file_name().unwrap().to_str().unwrap(),
            &plan.staging_name,
            "staging",
        )
        .expect("staging");
        let backup = trusted_transaction_sibling(
            destination_parent,
            destination.file_name().unwrap().to_str().unwrap(),
            &plan.backup_name,
            "backup",
        )
        .expect("backup");
        let staging = nte::BoundDirectoryLeaf::open_optional(&staging, "test staging").unwrap();
        let backup = nte::BoundDirectoryLeaf::open_optional(&backup, "test backup").unwrap();
        cleanup_captured_nte_library_artifacts(staging, backup)
            .expect("missing artifact parent is already clean");
    }

    #[test]
    fn library_cleanup_skips_an_artifact_created_after_capture() {
        let temp = tempdir().expect("tempdir");
        let staging = temp.path().join(".Demo.imm-staging-1-8");
        let captured =
            nte::BoundDirectoryLeaf::open_optional(&staging, "test missing staging").unwrap();
        assert!(captured.is_none());

        fs::create_dir(&staging).expect("replacement staging");
        fs::write(staging.join("keep.pak"), b"replacement").expect("replacement payload");

        cleanup_captured_nte_library_artifacts(captured, None).expect("captured cleanup");
        assert_eq!(fs::read(staging.join("keep.pak")).unwrap(), b"replacement");
    }

    #[test]
    fn wrapper_cleanup_skips_a_staging_replacement_after_handle_transfer() {
        let temp = tempdir().expect("tempdir");
        let parent =
            nte::bind_absolute_directory(temp.path(), "test staging parent").expect("bound parent");
        let name = std::ffi::OsStr::new(".Demo.imm-staging-1-9");
        let staging = temp.path().join(name);
        fs::create_dir(&staging).expect("replacement staging");
        fs::write(staging.join("keep.pak"), b"replacement").expect("replacement payload");

        cleanup_untransferred_bound_staging(None, parent.leaf(), name, "test handed-off staging")
            .expect("missing untransferred handle is a no-op");

        assert_eq!(fs::read(staging.join("keep.pak")).unwrap(), b"replacement");
    }
}

struct ExtractionSlotGuard;
struct PreviewSlotGuard;

impl Drop for ExtractionSlotGuard {
    fn drop(&mut self) {
        ACTIVE_EXTRACTIONS.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Drop for PreviewSlotGuard {
    fn drop(&mut self) {
        ACTIVE_PREVIEW_DOWNLOADS.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn acquire_extraction_slot(max_concurrent: usize) -> ExtractionSlotGuard {
    let max_concurrent = max_concurrent.max(1);
    loop {
        let current = ACTIVE_EXTRACTIONS.load(Ordering::SeqCst);
        if current < max_concurrent
            && ACTIVE_EXTRACTIONS
                .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            return ExtractionSlotGuard;
        }
        sleep(Duration::from_millis(100)).await;
    }
}

async fn acquire_preview_slot() -> PreviewSlotGuard {
    loop {
        let current = ACTIVE_PREVIEW_DOWNLOADS.load(Ordering::SeqCst);
        if current < 1
            && ACTIVE_PREVIEW_DOWNLOADS
                .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            return PreviewSlotGuard;
        }
        sleep(Duration::from_millis(100)).await;
    }
}

fn decrement_download_count(key: &str) {
    let mut counts = DOWNLOAD_COUNTS.lock().unwrap();
    if let Some(count) = counts.get_mut(key) {
        if *count > 0 {
            *count -= 1;
        }
        if *count == 0 {
            counts.remove(key);
        }
    }
}

fn active_primary_download_count() -> u64 {
    let counts = DOWNLOAD_COUNTS.lock().unwrap();
    counts.values().copied().sum()
}

fn mark_download_cancelled(key: &str) {
    let mut cancelled = CANCELLED_DOWNLOADS.lock().unwrap();
    cancelled.insert(key.to_string());
}

fn clear_cancelled_download(key: &str) {
    let mut cancelled = CANCELLED_DOWNLOADS.lock().unwrap();
    cancelled.remove(key);
}

fn is_download_cancelled(key: &str) -> bool {
    let cancelled = CANCELLED_DOWNLOADS.lock().unwrap();
    cancelled.contains(key)
}

fn parse_total_from_content_range(header_value: &str) -> Option<u64> {
    // Expected format: bytes start-end/total
    let total_part = header_value.split('/').nth(1)?;
    if total_part.trim() == "*" {
        return None;
    }
    total_part.trim().parse::<u64>().ok()
}

async fn wait_for_primary_downloads_to_idle(timeout_duration: Duration) {
    let start = Instant::now();
    while active_primary_download_count() > 0 {
        if start.elapsed() >= timeout_duration {
            tracing::warn!(
                "Preview wait timeout reached after {}s, proceeding anyway",
                timeout_duration.as_secs()
            );
            break;
        }
        sleep(Duration::from_millis(PREVIEW_IDLE_POLL_MS)).await;
    }
}

const MIME_EXTENSIONS: &[(&str, &str)] = &[
    ("image/jpeg", "jpg"),
    ("image/jpg", "jpg"),
    ("image/png", "png"),
    ("image/gif", "gif"),
    ("application/pdf", "pdf"),
    ("text/plain", "txt"),
    ("text/html", "html"),
    ("application/json", "json"),
    ("application/zip", "zip"),
    ("application/x-tar", "tar"),
    ("application/gzip", "gz"),
    ("application/x-bzip2", "bz2"),
    ("application/x-xz", "xz"),
    ("text/csv", "csv"),
    ("application/vnd.ms-excel", "xls"),
    (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsx",
    ),
    ("application/vnd.ms-powerpoint", "ppt"),
    (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pptx",
    ),
    ("application/msword", "doc"),
    (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
    ),
];

fn mime_to_extension(mime_type: &str) -> Option<&'static str> {
    let clean_mime = mime_type.split(';').next().unwrap_or("").trim();
    MIME_EXTENSIONS
        .iter()
        .find(|(mime, _)| *mime == clean_mime)
        .map(|(_, ext)| *ext)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BundledToolInfo {
    version: String,
    exe_path: String,
    source_path: String,
}

fn compare_version_names(left: &str, right: &str) -> std::cmp::Ordering {
    let left_parts = left
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect::<Vec<_>>();
    let right_parts = right
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect::<Vec<_>>();
    let max_len = left_parts.len().max(right_parts.len());
    for index in 0..max_len {
        let cmp = left_parts
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right_parts.get(index).copied().unwrap_or(0));
        if cmp != std::cmp::Ordering::Equal {
            return cmp;
        }
    }
    left.cmp(right)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|err| err.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
            continue;
        }
        let should_copy = match (std::fs::metadata(&src_path), std::fs::metadata(&dst_path)) {
            (Ok(src_meta), Ok(dst_meta)) => {
                src_meta.len() != dst_meta.len()
                    || src_meta.modified().ok() != dst_meta.modified().ok()
            }
            (Ok(_), Err(_)) => true,
            _ => false,
        };
        if should_copy {
            if let Some(parent) = dst_path.parent() {
                std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
            std::fs::copy(&src_path, &dst_path).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn find_fixer_exe(root: &Path, depth: usize) -> Option<PathBuf> {
    if !root.exists() || depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = entry.file_type().ok()?;
        if file_type.is_file() {
            let name = path.file_name()?.to_string_lossy().to_lowercase();
            if name.ends_with(".exe") && name.contains("wuwa_mod_fixer") {
                return Some(path);
            }
        }
    }
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = entry.file_type().ok()?;
        if file_type.is_dir() {
            if let Some(found) = find_fixer_exe(&path, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

fn resolve_bundled_fixer_root(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_path) = app_handle
        .path()
        .resolve("tools/Wuwa_Mod_Fixer", tauri::path::BaseDirectory::Resource)
    {
        if resource_path.exists() {
            return Ok(resource_path);
        }
    }

    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tools")
        .join("Wuwa_Mod_Fixer");
    if dev_path.exists() {
        return Ok(dev_path);
    }

    Err("Bundled Wuwa Mod Fixer resource is missing.".to_string())
}

fn resolve_latest_bundled_fixer_dir(root: &Path) -> Result<(String, PathBuf), String> {
    let mut candidates = std::fs::read_dir(root)
        .map_err(|err| err.to_string())?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = entry.file_type().ok()?;
            if file_type.is_dir() && !name.trim().is_empty() {
                Some((name, path))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| compare_version_names(&right.0, &left.0));
    candidates
        .into_iter()
        .next()
        .ok_or_else(|| "No bundled Wuwa Mod Fixer versions were found.".to_string())
}

#[tauri::command]
fn ensure_bundled_wuwa_mod_fixer(app_handle: tauri::AppHandle) -> Result<BundledToolInfo, String> {
    let bundled_root = resolve_bundled_fixer_root(&app_handle)?;
    let (version, bundled_version_dir) = resolve_latest_bundled_fixer_dir(&bundled_root)?;
    let runtime_dir = std::env::current_dir().map_err(|err| err.to_string())?;
    let runtime_root = runtime_dir.join("tools").join("Wuwa_Mod_Fixer");
    let runtime_version_dir = runtime_root.join(&version);

    copy_dir_recursive(&bundled_version_dir, &runtime_version_dir)?;

    let exe_path = find_fixer_exe(&runtime_version_dir, 5).ok_or_else(|| {
        format!(
            "Bundled Wuwa Mod Fixer executable not found in {:?}",
            runtime_version_dir
        )
    })?;

    Ok(BundledToolInfo {
        version,
        exe_path: exe_path.to_string_lossy().to_string(),
        source_path: bundled_version_dir.to_string_lossy().to_string(),
    })
}

fn extract_zip_archive(file_path: &Path, save_path: &Path) -> Result<(), String> {
    const MAX_ENTRIES: usize = 20_000;
    const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024 * 1024;
    const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024 * 1024;
    const MAX_RATIO: u64 = 200;
    const MAX_COMPONENTS: usize = 32;
    const MAX_COMPONENT_UTF16: usize = 128;
    const MAX_PATH_UTF16: usize = 240;

    let file = std::fs::File::open(file_path)
        .map_err(|err| format!("Unable to open ZIP archive: {err}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|err| format!("Invalid ZIP archive: {err}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err(format!(
            "ZIP archive contains too many entries (max {MAX_ENTRIES})"
        ));
    }
    std::fs::create_dir_all(save_path)
        .map_err(|err| format!("Unable to create extraction directory: {err}"))?;
    let mut total_written = 0_u64;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("Unable to read ZIP entry {index}: {err}"))?;
        if entry.encrypted() {
            return Err("Encrypted ZIP entries are not supported".to_string());
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| format!("ZIP entry escapes extraction root: {}", entry.name()))?
            .to_path_buf();
        let relative_text = relative.to_string_lossy();
        let components = relative.components().collect::<Vec<_>>();
        if components.is_empty()
            || components.len() > MAX_COMPONENTS
            || relative_text.encode_utf16().count() > MAX_PATH_UTF16
            || components.iter().any(|component| {
                let text = component.as_os_str().to_string_lossy();
                text.is_empty()
                    || text.contains(':')
                    || text.ends_with('.')
                    || text.ends_with(' ')
                    || text.encode_utf16().count() > MAX_COMPONENT_UTF16
            })
        {
            return Err(format!("Unsafe ZIP entry path: {relative_text}"));
        }
        let output_path = save_path.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output_path)
                .map_err(|err| format!("Unable to create ZIP directory {relative_text}: {err}"))?;
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!(
                "ZIP symlink entries are not supported: {relative_text}"
            ));
        }
        let declared_size = entry.size();
        let compressed_size = entry.compressed_size();
        if declared_size > MAX_ENTRY_BYTES
            || total_written.saturating_add(declared_size) > MAX_TOTAL_BYTES
            || (compressed_size == 0 && declared_size > 0)
            || (compressed_size > 0 && declared_size / compressed_size > MAX_RATIO)
        {
            return Err(format!("ZIP entry exceeds safety limits: {relative_text}"));
        }
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("Unable to create ZIP parent directory: {err}"))?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
            .map_err(|err| format!("Unable to create ZIP output {relative_text}: {err}"))?;
        let written = std::io::copy(&mut entry, &mut output)
            .map_err(|err| format!("Unable to extract ZIP entry {relative_text}: {err}"))?;
        if written != declared_size {
            return Err(format!(
                "ZIP entry size changed while extracting: {relative_text}"
            ));
        }
        output
            .sync_all()
            .map_err(|err| format!("Unable to flush ZIP entry {relative_text}: {err}"))?;
        total_written = total_written.saturating_add(written);
    }
    Ok(())
}

fn deployment_sibling_path(save_path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = save_path
        .parent()
        .ok_or_else(|| "Extraction destination has no parent directory".to_string())?;
    let name = save_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Extraction destination has no directory name".to_string())?;
    let counter = DEPLOYMENT_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(parent.join(format!(
        ".{name}.imm-{suffix}-{}-{counter}",
        std::process::id()
    )))
}

trait DownloadAppContext: Clone {
    fn app_local_data_dir(&self) -> Result<PathBuf, String>;

    fn emit_event<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String>;

    fn prepare_download_state_mutation(
        &self,
        _game: &str,
        _request: &GameBananaDownloadState,
        _destination: &Path,
    ) -> Result<PreparedDownloadStateMutation, String> {
        Err("Application state is unavailable for this download context.".to_string())
    }

    fn commit_download_state_mutation(
        &self,
        _game: &str,
        _prepared: PreparedDownloadStateMutation,
    ) -> Result<app_state::AppConfigSnapshot, String> {
        Err("Application state is unavailable for this download context.".to_string())
    }
}

#[derive(Debug)]
enum PreparedInstallPreview {
    Ready(PathBuf),
    Unavailable(String),
}

async fn prepare_install_preview<A: DownloadAppContext>(
    app_handle: &A,
    preview_url: Option<&str>,
    key: &str,
) -> PreparedInstallPreview {
    let Some(preview_url) = preview_url.map(str::trim).filter(|url| !url.is_empty()) else {
        return PreparedInstallPreview::Unavailable(
            "GameBanana did not provide a fallback preview URL.".to_string(),
        );
    };
    if let Err(error) = remote_media::validate_remote_media_url(preview_url) {
        return PreparedInstallPreview::Unavailable(error);
    }
    let app_local_data = match app_handle.app_local_data_dir() {
        Ok(path) => path,
        Err(error) => return PreparedInstallPreview::Unavailable(error),
    };
    let mut last_error = "Preview preparation failed.".to_string();
    for attempt in 1u64..=3 {
        match remote_media::resolve_remote_media_in_app_data(&app_local_data, preview_url).await {
            Ok(path) => return PreparedInstallPreview::Ready(path),
            Err(error) => last_error = error,
        }
        if attempt < 3 {
            let jitter = key.bytes().fold(attempt * 97, |acc, byte| {
                acc.wrapping_mul(31).wrapping_add(u64::from(byte))
            }) % 250;
            sleep(Duration::from_millis(
                400 * 2u64.pow((attempt - 1) as u32) + jitter,
            ))
            .await;
        }
    }
    PreparedInstallPreview::Unavailable(format!(
        "GameBanana preview failed after 3 attempts: {last_error}"
    ))
}

impl<R: tauri::Runtime> DownloadAppContext for tauri::AppHandle<R> {
    fn app_local_data_dir(&self) -> Result<PathBuf, String> {
        self.path()
            .app_local_data_dir()
            .map_err(|err| err.to_string())
    }

    fn emit_event<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String> {
        self.emit(event, payload).map_err(|err| err.to_string())
    }

    fn prepare_download_state_mutation(
        &self,
        game: &str,
        request: &GameBananaDownloadState,
        destination: &Path,
    ) -> Result<PreparedDownloadStateMutation, String> {
        prepare_gamebanana_download_state(
            &self.state::<app_state::AppStateRepository>(),
            game,
            request,
            destination,
        )
    }

    fn commit_download_state_mutation(
        &self,
        game: &str,
        prepared: PreparedDownloadStateMutation,
    ) -> Result<app_state::AppConfigSnapshot, String> {
        let repository = self.state::<app_state::AppStateRepository>();
        commit_game_config_for_mod_mutation(
            &repository,
            game,
            prepared.next_game,
            prepared.expected_game_revision,
            &prepared.plan,
        )
    }
}

fn nte_download_staging_directory<A: DownloadAppContext>(
    app_handle: &A,
    key: &str,
    destination: &Path,
) -> Result<BoundNteDownloadStaging, String> {
    let app_local_data = app_handle
        .app_local_data_dir()
        .map_err(|err| format!("Unable to resolve NTE download staging: {err}"))?;
    let root = bind_nte_download_staging_root(&app_local_data, true)?
        .ok_or_else(|| "NTE download staging root disappeared after creation.".to_string())?;
    cleanup_stale_nte_download_staging_root(&root)?;
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    hasher.update([0]);
    hasher.update(destination.as_os_str().to_string_lossy().as_bytes());
    hasher.update(
        DEPLOYMENT_COUNTER
            .fetch_add(1, Ordering::SeqCst)
            .to_le_bytes(),
    );
    let digest = format!("{:x}", hasher.finalize());
    let staging_name = format!(".imm-download-{}-{}", std::process::id(), &digest[..24]);
    nte::remove_bound_directory_tree(
        &root.directory,
        std::ffi::OsStr::new(&staging_name),
        "previous hidden NTE download staging",
    )?;
    root.directory
        .create_dir(&staging_name)
        .map_err(|err| format!("Unable to create hidden NTE download staging: {err}"))?;
    let staging_directory = nte::open_bound_directory_for_rename(
        &root.directory,
        std::ffi::OsStr::new(&staging_name),
        "hidden NTE download staging",
    )?;
    let staging = root.path.join(&staging_name);
    Ok(BoundNteDownloadStaging {
        path: staging,
        root,
        directory: staging_directory,
    })
}

struct BoundNteStagingRoot {
    path: PathBuf,
    _app_local_chain: nte::BoundDirectoryChain,
    directory: CapDir,
}

struct BoundNteDownloadStaging {
    path: PathBuf,
    root: BoundNteStagingRoot,
    directory: CapDir,
}

impl std::ops::Deref for BoundNteDownloadStaging {
    type Target = Path;

    fn deref(&self) -> &Self::Target {
        &self.path
    }
}

impl BoundNteDownloadStaging {
    fn cleanup(self) -> Result<(), String> {
        let name = self
            .path
            .file_name()
            .ok_or_else(|| "NTE download staging has no directory name.".to_string())?
            .to_os_string();
        if nte_download_staging_owner(&name.to_string_lossy()) != Some(std::process::id()) {
            return Err("NTE download staging cleanup refused an unowned path.".to_string());
        }
        let BoundNteDownloadStaging {
            root, directory, ..
        } = self;
        nte::remove_open_bound_directory_tree(
            directory,
            &root.directory,
            &name,
            "hidden NTE download staging",
        )
    }
}

fn bind_nte_download_staging_root(
    app_local_data: &Path,
    create: bool,
) -> Result<Option<BoundNteStagingRoot>, String> {
    if create {
        std::fs::create_dir_all(app_local_data)
            .map_err(|err| format!("Unable to create app-local data directory: {err}"))?;
    }
    let Some(app_local_chain) =
        nte::bind_absolute_directory_optional(app_local_data, "app-local data")?
    else {
        if create {
            return Err("App-local data disappeared after creation.".to_string());
        }
        return Ok(None);
    };
    let name = "nte-download-staging";
    let directory = match nte::open_bound_directory_optional(
        app_local_chain.leaf(),
        std::ffi::OsStr::new(name),
        "NTE download staging root",
    )? {
        Some(directory) => directory,
        None if create => {
            app_local_chain
                .leaf()
                .create_dir(name)
                .map_err(|err| format!("Unable to create NTE download staging root: {err}"))?;
            nte::open_bound_directory_optional(
                app_local_chain.leaf(),
                std::ffi::OsStr::new(name),
                "NTE download staging root",
            )?
            .ok_or_else(|| "NTE download staging root disappeared after creation.".to_string())?
        }
        None => return Ok(None),
    };
    Ok(Some(BoundNteStagingRoot {
        path: app_local_data.join(name),
        _app_local_chain: app_local_chain,
        directory,
    }))
}

fn nte_download_staging_owner(name: &str) -> Option<u32> {
    let remainder = name.strip_prefix(".imm-download-")?;
    let (pid, digest) = remainder.split_once('-')?;
    if pid.is_empty()
        || !pid.bytes().all(|byte| byte.is_ascii_digit())
        || digest.len() != 24
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    pid.parse().ok().filter(|pid| *pid != 0)
}

#[cfg(windows)]
fn nte_staging_owner_is_live(pid: u32) -> bool {
    use winapi::shared::winerror::ERROR_INVALID_PARAMETER;
    use winapi::um::{
        errhandlingapi::GetLastError, handleapi::CloseHandle, processthreadsapi::OpenProcess,
        winnt::PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == std::process::id() {
        return true;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // Access denied is treated as live/unknown. ERROR_INVALID_PARAMETER is the
        // documented result for a PID that no longer exists.
        unsafe { GetLastError() != ERROR_INVALID_PARAMETER }
    } else {
        unsafe { CloseHandle(handle) };
        true
    }
}

#[cfg(not(windows))]
fn nte_staging_owner_is_live(pid: u32) -> bool {
    pid == std::process::id()
}

#[cfg(windows)]
fn cap_deployment_metadata_is_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;
    metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
fn cap_deployment_metadata_is_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    metadata.is_symlink()
}

fn cleanup_stale_nte_download_staging_root(root: &BoundNteStagingRoot) -> Result<(), String> {
    let entries = match root.directory.read_dir(".") {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("Unable to inspect NTE download staging: {err}")),
    };
    for entry in entries {
        let entry = entry.map_err(|err| format!("Unable to inspect NTE staging entry: {err}"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(owner_pid) = nte_download_staging_owner(name) else {
            continue;
        };
        if nte_staging_owner_is_live(owner_pid) {
            continue;
        }
        let Some(directory) = nte::open_bound_directory_for_rename_optional(
            &root.directory,
            std::ffi::OsStr::new(name),
            "stale NTE download staging",
        )?
        else {
            continue;
        };
        nte::remove_open_bound_directory_tree(
            directory,
            &root.directory,
            std::ffi::OsStr::new(name),
            "stale NTE download staging",
        )?;
    }
    Ok(())
}

fn cleanup_stale_nte_download_staging(app_local_data: &Path) -> Result<(), String> {
    let Some(root) = bind_nte_download_staging_root(app_local_data, false)? else {
        return Ok(());
    };
    cleanup_stale_nte_download_staging_root(&root)
}

#[cfg(test)]
mod nte_download_staging_cleanup_tests {
    use super::{cleanup_stale_nte_download_staging, nte_download_staging_owner};
    use tempfile::tempdir;

    #[test]
    fn parser_accepts_only_exact_owned_staging_names() {
        assert_eq!(
            nte_download_staging_owner(".imm-download-42-0123456789abcdef01234567"),
            Some(42)
        );
        for name in [
            ".imm-download-0-0123456789abcdef01234567",
            ".imm-download-42-short",
            ".imm-download-42-0123456789abcdef0123456g",
            "imm-download-42-0123456789abcdef01234567",
            ".imm-download-x-0123456789abcdef01234567",
        ] {
            assert_eq!(nte_download_staging_owner(name), None, "{name}");
        }
    }

    #[test]
    fn cleanup_removes_dead_owner_but_preserves_live_and_unowned_directories() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("nte-download-staging");
        std::fs::create_dir(&root).unwrap();
        let stale = root.join(".imm-download-4294967295-0123456789abcdef01234567");
        let live = root.join(format!(
            ".imm-download-{}-0123456789abcdef01234567",
            std::process::id()
        ));
        let unowned = root.join(".imm-download-manual-backup");
        std::fs::create_dir(&stale).unwrap();
        std::fs::create_dir(&live).unwrap();
        std::fs::create_dir(&unowned).unwrap();

        cleanup_stale_nte_download_staging(temp.path()).unwrap();

        assert!(!stale.exists());
        assert!(live.exists());
        assert!(unowned.exists());
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_rejects_a_junction_staging_root_without_touching_its_target() {
        let temp = tempdir().unwrap();
        let app_local = temp.path().join("app-local");
        let external = temp.path().join("external");
        let staging_root = app_local.join("nte-download-staging");
        let stale = external.join(".imm-download-4294967295-0123456789abcdef01234567");
        std::fs::create_dir_all(&app_local).unwrap();
        std::fs::create_dir_all(&stale).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&staging_root)
            .arg(&external)
            .status()
            .unwrap();
        assert!(status.success());

        let error = cleanup_stale_nte_download_staging(&app_local).unwrap_err();
        assert!(
            error.contains("Unable to bind the NTE download staging root directory leaf"),
            "unexpected staging-root rejection: {error}"
        );
        assert!(stale.is_dir());
    }
}

fn remove_directory_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "Unable to remove directory '{}': {err}",
            path.display()
        )),
    }
}

fn cleanup_captured_nte_library_artifacts(
    staging: Option<nte::BoundDirectoryLeaf>,
    backup: Option<nte::BoundDirectoryLeaf>,
) -> Result<(), String> {
    if let Some(staging) = staging {
        staging.remove("NTE library staging artifact")?;
    }
    if let Some(backup) = backup {
        backup.remove("NTE library backup artifact")?;
    }
    Ok(())
}

fn commit_and_cleanup_nte_library_transaction(
    journal: &mut nte_wal::WalJournal,
    transaction_id: [u8; 16],
    parent: &CapDir,
    staging_name: &std::ffi::OsStr,
    staging: Option<CapDir>,
    backup_name: &std::ffi::OsStr,
    backup: Option<CapDir>,
) -> Result<(), String> {
    journal.append(transaction_id, nte_wal::WalState::CommittedAfter, b"{}")?;
    cleanup_open_nte_library_artifacts(parent, staging_name, staging, backup_name, backup)?;
    journal.append(
        transaction_id,
        nte_wal::WalState::CleanupComplete,
        br#"{"cleanup":"complete"}"#,
    )
}

fn cleanup_open_nte_library_artifacts(
    parent: &CapDir,
    staging_name: &std::ffi::OsStr,
    staging: Option<CapDir>,
    backup_name: &std::ffi::OsStr,
    backup: Option<CapDir>,
) -> Result<(), String> {
    if let Some(staging) = staging {
        nte::remove_open_bound_directory_tree(
            staging,
            parent,
            staging_name,
            "NTE library staging artifact",
        )?;
    }
    if let Some(backup) = backup {
        nte::remove_open_bound_directory_tree(
            backup,
            parent,
            backup_name,
            "NTE library backup artifact",
        )?;
    }
    Ok(())
}

#[cfg(windows)]
fn deployment_metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
fn deployment_metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn deployment_tree_hash(root: &Path) -> Result<String, String> {
    const MAX_ENTRIES: usize = 20_000;
    const MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
    let root_metadata = std::fs::symlink_metadata(root)
        .map_err(|err| format!("Unable to inspect NTE library directory: {err}"))?;
    if !root_metadata.is_dir() || deployment_metadata_is_reparse(&root_metadata) {
        return Err("NTE library directory is missing or unsafe.".to_string());
    }
    let mut pending = vec![root.to_path_buf()];
    let mut entries = Vec::new();
    let mut total_bytes = 0u64;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|err| err.to_string())?;
            if deployment_metadata_is_reparse(&metadata) {
                return Err("NTE library tree contains a reparse point.".to_string());
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "NTE library entry escaped its root.".to_string())?;
            let relative = relative
                .components()
                .map(|component| {
                    component
                        .as_os_str()
                        .to_str()
                        .ok_or_else(|| "NTE library path is not valid UTF-8.".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            if metadata.is_dir() {
                entries.push((format!("d:{relative}"), None));
                pending.push(path);
            } else if metadata.is_file() {
                total_bytes = total_bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| "NTE library size overflow.".to_string())?;
                if total_bytes > MAX_BYTES {
                    return Err("NTE library tree exceeds the 16 GiB limit.".to_string());
                }
                entries.push((format!("f:{relative}:{}", metadata.len()), Some(path)));
            } else {
                return Err("NTE library tree contains an unsupported entry.".to_string());
            }
            if entries.len() > MAX_ENTRIES {
                return Err("NTE library tree exceeds the 20,000 entry limit.".to_string());
            }
        }
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut tree_hasher = Sha256::new();
    for (descriptor, file_path) in entries {
        tree_hasher.update((descriptor.len() as u64).to_le_bytes());
        tree_hasher.update(descriptor.as_bytes());
        if let Some(file_path) = file_path {
            let mut file = std::fs::File::open(&file_path).map_err(|err| err.to_string())?;
            let mut file_hasher = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer).map_err(|err| err.to_string())?;
                if read == 0 {
                    break;
                }
                file_hasher.update(&buffer[..read]);
            }
            tree_hasher.update(file_hasher.finalize());
        }
    }
    Ok(format!("{:x}", tree_hasher.finalize()))
}

fn optional_deployment_tree_hash(path: &Path) -> Result<Option<String>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => deployment_tree_hash(path).map(Some),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Unable to inspect NTE library state: {err}")),
    }
}

fn captured_deployment_tree_hash(
    path: &Path,
    captured: Option<&nte::BoundDirectoryLeaf>,
) -> Result<Option<String>, String> {
    match captured {
        Some(_) => deployment_tree_hash(path).map(Some),
        None => Ok(None),
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NteLibraryWalPlan {
    operation: String,
    destination_relative_path: String,
    staging_name: String,
    backup_name: String,
    before_hash: Option<String>,
    after_hash: String,
}

fn trusted_sibling(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    if path.components().count() != 1
        || !matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err("NTE transaction WAL contains an unsafe sibling name.".to_string());
    }
    Ok(parent.join(path))
}

fn trusted_transaction_sibling(
    parent: &Path,
    destination_name: &str,
    candidate_name: &str,
    role: &str,
) -> Result<PathBuf, String> {
    let expected_prefix = format!(".{destination_name}.imm-{role}-");
    if !candidate_name.starts_with(&expected_prefix)
        || candidate_name.len() <= expected_prefix.len()
        || !candidate_name[expected_prefix.len()..]
            .chars()
            .all(|character| character.is_ascii_digit() || character == '-')
    {
        return Err(format!(
            "NTE transaction WAL contains an invalid {role} sibling name."
        ));
    }
    trusted_sibling(parent, candidate_name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LibraryRecoveryPreference {
    Infer,
    Before,
    After,
}

pub(crate) fn recover_nte_library_transaction_from_parent(
    parent: &Path,
    journal: &mut nte_wal::WalJournal,
) -> Result<(), String> {
    recover_nte_library_transaction_from_parent_with_preference(
        parent,
        journal,
        LibraryRecoveryPreference::Infer,
    )
}

fn recover_nte_library_transaction_from_parent_with_preference(
    parent: &Path,
    journal: &mut nte_wal::WalJournal,
    preference: LibraryRecoveryPreference,
) -> Result<(), String> {
    let Some(incomplete) = journal.incomplete_transaction()? else {
        return Ok(());
    };
    let plan: NteLibraryWalPlan = serde_json::from_slice(&incomplete.prepared_payload)
        .map_err(|err| format!("Unable to read the NTE recovery plan: {err}"))?;
    if !matches!(
        plan.operation.as_str(),
        "library_install" | "library_update"
    ) {
        return Err("NTE recovery plan has an unsupported operation.".to_string());
    }
    let destination =
        nte::trusted_nte_library_destination(parent, &plan.destination_relative_path)?;
    let destination_parent = destination
        .parent()
        .ok_or_else(|| "NTE library destination has no parent.".to_string())?;
    let destination_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "NTE library destination has no valid name.".to_string())?;
    let staging = trusted_transaction_sibling(
        destination_parent,
        destination_name,
        &plan.staging_name,
        "staging",
    )?;
    let backup = trusted_transaction_sibling(
        destination_parent,
        destination_name,
        &plan.backup_name,
        "backup",
    )?;
    let mut destination_bound =
        nte::BoundDirectoryLeaf::open_optional(&destination, "NTE library destination")?;
    let mut staging_bound =
        nte::BoundDirectoryLeaf::open_optional(&staging, "NTE library staging artifact")?;
    let mut backup_bound =
        nte::BoundDirectoryLeaf::open_optional(&backup, "NTE library backup artifact")?;
    let destination_hash = captured_deployment_tree_hash(&destination, destination_bound.as_ref())?;
    let staging_hash = captured_deployment_tree_hash(&staging, staging_bound.as_ref())?;
    let backup_hash = captured_deployment_tree_hash(&backup, backup_bound.as_ref())?;

    if (incomplete.state == nte_wal::WalState::AbortedBefore
        && preference == LibraryRecoveryPreference::After)
        || (incomplete.state == nte_wal::WalState::CommittedAfter
            && preference == LibraryRecoveryPreference::Before)
    {
        return Err(
            "The outer Mod transaction conflicts with the terminal library WAL state.".to_string(),
        );
    }

    if incomplete.state == nte_wal::WalState::AbortedBefore {
        if destination_hash != plan.before_hash {
            return Err(
                "Aborted NTE library transaction no longer matches its verified before state."
                    .to_string(),
            );
        }
        cleanup_captured_nte_library_artifacts(staging_bound, backup_bound)?;
        return journal.append(
            incomplete.transaction_id,
            nte_wal::WalState::CleanupComplete,
            br#"{"cleanup":"aborted_before_complete"}"#,
        );
    }

    if incomplete.state == nte_wal::WalState::CommittedAfter {
        if destination_hash.as_deref() != Some(plan.after_hash.as_str()) {
            if staging_hash.as_deref() != Some(plan.after_hash.as_str()) {
                return Err(
                    "Committed NTE library transaction has no verified after-state payload."
                        .to_string(),
                );
            }
            if destination_hash == plan.before_hash {
                if plan.before_hash.is_some() {
                    if backup_hash.is_some() {
                        return Err(
                            "Committed NTE library transaction has conflicting before-state copies."
                                .to_string(),
                        );
                    }
                    let destination_leaf = destination_bound.take().ok_or_else(|| {
                        "Committed NTE library destination handle disappeared.".to_string()
                    })?;
                    backup_bound =
                        Some(destination_leaf.rename_to(&backup, "committed NTE library backup")?);
                }
            } else if !(destination_hash.is_none() && backup_hash == plan.before_hash) {
                return Err(
                    "Committed NTE library before-state is ambiguous; repair is required."
                        .to_string(),
                );
            }
            let staging_leaf = staging_bound
                .take()
                .ok_or_else(|| "Committed NTE library staging handle disappeared.".to_string())?;
            destination_bound =
                Some(staging_leaf.rename_to(&destination, "committed NTE library deployment")?);
            if captured_deployment_tree_hash(&destination, destination_bound.as_ref())?.as_deref()
                != Some(plan.after_hash.as_str())
            {
                return Err(
                    "Committed NTE library transaction could not reach its after state."
                        .to_string(),
                );
            }
        }
        cleanup_captured_nte_library_artifacts(staging_bound, backup_bound)?;
        return journal.append(
            incomplete.transaction_id,
            nte_wal::WalState::CleanupComplete,
            br#"{"cleanup":"complete"}"#,
        );
    }

    if incomplete.state == nte_wal::WalState::Prepared {
        journal.append(
            incomplete.transaction_id,
            nte_wal::WalState::Committing,
            br#"{"recovery":"begin"}"#,
        )?;
    }

    if preference != LibraryRecoveryPreference::Infer {
        if staging_hash
            .as_deref()
            .is_some_and(|hash| hash != plan.after_hash)
            || backup_hash
                .as_ref()
                .is_some_and(|hash| Some(hash) != plan.before_hash.as_ref())
            || destination_hash.as_ref().is_some_and(|hash| {
                Some(hash) != plan.before_hash.as_ref() && hash != &plan.after_hash
            })
        {
            return Err(
                "The library transaction artifacts do not match their recorded hashes.".to_string(),
            );
        }

        match preference {
            LibraryRecoveryPreference::Before => {
                if destination_hash == plan.before_hash {
                    if backup_hash.is_some() {
                        return Err("The library transaction has duplicate before-state copies."
                            .to_string());
                    }
                } else if destination_hash.as_deref() == Some(plan.after_hash.as_str()) {
                    if staging_hash.is_some() {
                        return Err(
                            "The library transaction has duplicate after-state copies.".to_string()
                        );
                    }
                    if backup_hash != plan.before_hash {
                        return Err(
                            "The library transaction cannot restore its recorded before state."
                                .to_string(),
                        );
                    }
                    let destination_leaf = destination_bound.take().ok_or_else(|| {
                        "The library after-state handle disappeared during rollback.".to_string()
                    })?;
                    staging_bound = Some(
                        destination_leaf
                            .rename_to(&staging, "rolled-back Mod library after-state")?,
                    );
                    if let Some(backup_leaf) = backup_bound.take() {
                        destination_bound = Some(
                            backup_leaf
                                .rename_to(&destination, "restored Mod library before-state")?,
                        );
                    }
                } else if destination_hash.is_none()
                    && plan.before_hash.is_some()
                    && backup_hash == plan.before_hash
                {
                    let backup_leaf = backup_bound.take().ok_or_else(|| {
                        "The library before-state handle disappeared during rollback.".to_string()
                    })?;
                    destination_bound = Some(
                        backup_leaf.rename_to(&destination, "restored Mod library before-state")?,
                    );
                } else {
                    return Err(
                        "The library transaction cannot prove its requested before state."
                            .to_string(),
                    );
                }
                if captured_deployment_tree_hash(&destination, destination_bound.as_ref())?
                    != plan.before_hash
                {
                    return Err(
                        "The library transaction could not reach its requested before state."
                            .to_string(),
                    );
                }
                journal.append(
                    incomplete.transaction_id,
                    nte_wal::WalState::StepReceipt,
                    br#"{"step":"outer_recovery","outcome":"before"}"#,
                )?;
                journal.append(
                    incomplete.transaction_id,
                    nte_wal::WalState::AbortedBefore,
                    b"{}",
                )?;
            }
            LibraryRecoveryPreference::After => {
                if destination_hash.as_deref() == Some(plan.after_hash.as_str()) {
                    if staging_hash.is_some() {
                        return Err(
                            "The library transaction has duplicate after-state copies.".to_string()
                        );
                    }
                } else {
                    if staging_hash.as_deref() != Some(plan.after_hash.as_str()) {
                        return Err(
                            "The library transaction has no verified after-state payload."
                                .to_string(),
                        );
                    }
                    if destination_hash == plan.before_hash {
                        if plan.before_hash.is_some() {
                            if backup_hash.is_some() {
                                return Err(
                                    "The library transaction has duplicate before-state copies."
                                        .to_string(),
                                );
                            }
                            let destination_leaf = destination_bound.take().ok_or_else(|| {
                                "The library before-state handle disappeared during roll-forward."
                                    .to_string()
                            })?;
                            backup_bound = Some(
                                destination_leaf
                                    .rename_to(&backup, "preserved Mod library before-state")?,
                            );
                        }
                    } else if !(destination_hash.is_none() && backup_hash == plan.before_hash) {
                        return Err(
                            "The library transaction cannot prove its requested after state."
                                .to_string(),
                        );
                    }
                    let staging_leaf = staging_bound.take().ok_or_else(|| {
                        "The library after-state handle disappeared during roll-forward."
                            .to_string()
                    })?;
                    destination_bound = Some(
                        staging_leaf.rename_to(&destination, "restored Mod library after-state")?,
                    );
                }
                if captured_deployment_tree_hash(&destination, destination_bound.as_ref())?
                    .as_deref()
                    != Some(plan.after_hash.as_str())
                {
                    return Err(
                        "The library transaction could not reach its requested after state."
                            .to_string(),
                    );
                }
                journal.append(
                    incomplete.transaction_id,
                    nte_wal::WalState::StepReceipt,
                    br#"{"step":"outer_recovery","outcome":"after"}"#,
                )?;
                journal.append(
                    incomplete.transaction_id,
                    nte_wal::WalState::CommittedAfter,
                    b"{}",
                )?;
            }
            LibraryRecoveryPreference::Infer => unreachable!(),
        }
        drop(destination_bound);
        cleanup_captured_nte_library_artifacts(staging_bound, backup_bound)?;
        return journal.append(
            incomplete.transaction_id,
            nte_wal::WalState::CleanupComplete,
            br#"{"cleanup":"outer_recovery_complete"}"#,
        );
    }

    let outcome = if destination_hash.as_deref() == Some(plan.after_hash.as_str())
        && staging_hash.is_none()
        && (backup_hash.is_none() || backup_hash == plan.before_hash)
    {
        "roll_forward_after_hash"
    } else if destination_hash == plan.before_hash
        && staging_hash.as_deref() == Some(plan.after_hash.as_str())
        && backup_hash.is_none()
    {
        "verified_before_state"
    } else if destination_hash.is_none()
        && backup_hash == plan.before_hash
        && staging_hash.as_deref() == Some(plan.after_hash.as_str())
        && plan.before_hash.is_some()
    {
        let backup_leaf = backup_bound
            .take()
            .ok_or_else(|| "NTE library rollback backup handle disappeared.".to_string())?;
        destination_bound =
            Some(backup_leaf.rename_to(&destination, "NTE library transaction rollback")?);
        "rolled_back_from_backup"
    } else {
        return Err(
            "NTE library transaction state is ambiguous or externally modified; repair is required."
                .to_string(),
        );
    };
    let receipt = serde_json::to_vec(&serde_json::json!({
        "step": "recovery",
        "outcome": outcome,
    }))
    .map_err(|err| format!("Unable to serialize the NTE recovery receipt: {err}"))?;
    journal.append(
        incomplete.transaction_id,
        nte_wal::WalState::StepReceipt,
        &receipt,
    )?;
    let terminal_state = if outcome == "roll_forward_after_hash" {
        nte_wal::WalState::CommittedAfter
    } else {
        nte_wal::WalState::AbortedBefore
    };
    journal.append(incomplete.transaction_id, terminal_state, b"{}")?;
    drop(destination_bound);
    cleanup_captured_nte_library_artifacts(staging_bound, backup_bound)?;
    journal.append(
        incomplete.transaction_id,
        nte_wal::WalState::CleanupComplete,
        br#"{"cleanup":"complete"}"#,
    )
}

fn recover_nte_library_transaction(
    trusted_library_root: &Path,
    journal: &mut nte_wal::WalJournal,
) -> Result<(), String> {
    recover_nte_library_transaction_from_parent(trusted_library_root, journal)
}

fn preserve_existing_preview_files(save_path: &Path, staging_path: &Path) -> Result<(), String> {
    if !save_path.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(save_path).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if !file_type.is_file() || !name_text.starts_with("preview.") {
            continue;
        }
        let destination = staging_path.join(&name);
        if !destination.exists() {
            std::fs::copy(entry.path(), &destination)
                .map_err(|err| format!("Unable to preserve preview '{}': {err}", name_text))?;
        }
    }
    Ok(())
}

fn is_preview_file_name(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with("preview.")
}

fn normalize_staged_mod_root(staging_path: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(staging_path)
        .map_err(|err| format!("Unable to inspect extracted Mod root: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Unable to inspect extracted Mod root: {err}"))?;
    let mut wrapper: Option<PathBuf> = None;
    for entry in &entries {
        let metadata = std::fs::symlink_metadata(entry.path())
            .map_err(|err| format!("Unable to inspect extracted root entry: {err}"))?;
        if deployment_metadata_is_reparse(&metadata) {
            return Err(format!(
                "Extracted Mod root contains a reparse point: {}",
                entry.path().display()
            ));
        }
        if metadata.is_dir() {
            if wrapper.is_some() {
                return Ok(());
            }
            wrapper = Some(entry.path());
            continue;
        }
        if !metadata.is_file() {
            return Err(format!(
                "Extracted Mod root contains an unsupported entry: {}",
                entry.path().display()
            ));
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let extension = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        if extension != "txt" && !is_preview_file_name(&name) {
            return Ok(());
        }
    }
    let Some(wrapper) = wrapper else {
        return Ok(());
    };
    for entry in std::fs::read_dir(&wrapper)
        .map_err(|err| format!("Unable to inspect Mod wrapper directory: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Unable to inspect Mod wrapper entry: {err}"))?;
        let metadata = std::fs::symlink_metadata(entry.path())
            .map_err(|err| format!("Unable to inspect Mod wrapper entry: {err}"))?;
        if deployment_metadata_is_reparse(&metadata) || (!metadata.is_file() && !metadata.is_dir())
        {
            return Err(format!(
                "Mod wrapper contains an unsupported entry: {}",
                entry.path().display()
            ));
        }
        let destination = staging_path.join(entry.file_name());
        if destination.exists() {
            return Err(format!(
                "Mod wrapper conflicts with a root entry: {}",
                destination.display()
            ));
        }
        std::fs::rename(entry.path(), &destination).map_err(|err| {
            format!(
                "Unable to normalize Mod wrapper '{}' to '{}': {err}",
                entry.path().display(),
                destination.display()
            )
        })?;
    }
    std::fs::remove_dir(&wrapper)
        .map_err(|err| format!("Unable to remove empty Mod wrapper directory: {err}"))
}

fn read_preview_candidate(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|err| format!("Unable to inspect preview '{}': {err}", path.display()))?;
    if !metadata.is_file() || deployment_metadata_is_reparse(&metadata) {
        return Err(format!(
            "Preview '{}' is not a safe regular file.",
            path.display()
        ));
    }
    if metadata.len() == 0 || metadata.len() > INSTALL_PREVIEW_MAX_BYTES {
        return Err(format!(
            "Preview '{}' must be between 1 byte and 20 MiB.",
            path.display()
        ));
    }
    std::fs::read(path).map_err(|err| format!("Unable to read preview '{}': {err}", path.display()))
}

fn decode_preview_candidate(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = read_preview_candidate(path)?;
    let expected = match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => image::ImageFormat::Png,
        Some("jpg" | "jpeg") => image::ImageFormat::Jpeg,
        Some("webp") => image::ImageFormat::WebP,
        _ => {
            return Err(format!(
                "Preview '{}' has an unsupported extension.",
                path.display()
            ))
        }
    };
    let detected = image::guess_format(&bytes)
        .map_err(|err| format!("Unable to identify preview '{}': {err}", path.display()))?;
    if detected != expected {
        return Err(format!(
            "Preview '{}' extension does not match its file signature.",
            path.display()
        ));
    }
    remote_media::decode_and_reencode_preview_jpeg(&bytes)
}

fn install_required_preview(
    staging_path: &Path,
    fallback: &PreparedInstallPreview,
) -> Result<(), String> {
    let mut package_errors = Vec::new();
    let mut normalized_jpeg = None;
    for extension in INSTALL_PREVIEW_EXTENSIONS {
        let candidate = std::fs::read_dir(staging_path)
            .map_err(|err| format!("Unable to inspect extracted Mod previews: {err}"))?
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(&format!("preview.{extension}")))
            })
            .map(|entry| entry.path());
        let Some(candidate) = candidate else {
            continue;
        };
        match decode_preview_candidate(&candidate) {
            Ok(jpeg) => {
                normalized_jpeg = Some(jpeg);
                break;
            }
            Err(error) => package_errors.push(error),
        }
    }

    if normalized_jpeg.is_none() {
        normalized_jpeg = match fallback {
            PreparedInstallPreview::Ready(path) => Some(decode_preview_candidate(path)?),
            PreparedInstallPreview::Unavailable(error) => {
                let package_context = if package_errors.is_empty() {
                    "The archive has no valid root preview.".to_string()
                } else {
                    package_errors.join(" ")
                };
                return Err(format!("{package_context} {error}"));
            }
        };
    }

    for entry in std::fs::read_dir(staging_path)
        .map_err(|err| format!("Unable to inspect extracted Mod previews: {err}"))?
    {
        let entry =
            entry.map_err(|err| format!("Unable to inspect extracted Mod preview: {err}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_preview_file_name(&name) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path())
            .map_err(|err| format!("Unable to inspect extracted Mod preview: {err}"))?;
        if !metadata.is_file() || deployment_metadata_is_reparse(&metadata) {
            return Err(format!(
                "Extracted preview entry '{}' is not a safe regular file.",
                entry.path().display()
            ));
        }
        std::fs::remove_file(entry.path()).map_err(|err| {
            format!(
                "Unable to remove superseded preview '{}': {err}",
                entry.path().display()
            )
        })?;
    }

    let preview_path = staging_path.join("preview.jpg");
    let mut output = atomic_write_file::AtomicWriteFile::open(&preview_path)
        .map_err(|err| format!("Unable to stage preview.jpg: {err}"))?;
    output
        .write_all(normalized_jpeg.as_deref().unwrap_or_default())
        .map_err(|err| format!("Unable to write preview.jpg: {err}"))?;
    output
        .commit()
        .map_err(|err| format!("Unable to publish staged preview.jpg: {err}"))?;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&preview_path)
        .and_then(|file| file.sync_all())
        .map_err(|err| format!("Unable to flush staged preview.jpg: {err}"))
}

fn copy_nte_library_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|err| format!("Unable to inspect NTE preview source tree: {err}"))?;
    if !metadata.is_dir() || deployment_metadata_is_reparse(&metadata) {
        return Err("NTE preview source tree is unsafe.".to_string());
    }
    std::fs::create_dir_all(destination)
        .map_err(|err| format!("Unable to create NTE preview staging: {err}"))?;
    for entry in std::fs::read_dir(source).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|err| err.to_string())?;
        if deployment_metadata_is_reparse(&metadata) {
            return Err(format!(
                "NTE preview source contains a reparse point: {}",
                entry.path().display()
            ));
        }
        let target = destination.join(entry.file_name());
        if metadata.is_dir() {
            copy_nte_library_tree(&entry.path(), &target)?;
        } else if metadata.is_file() {
            std::fs::copy(entry.path(), &target).map_err(|err| {
                format!(
                    "Unable to copy NTE preview source '{}': {err}",
                    entry.path().display()
                )
            })?;
        } else {
            return Err(format!(
                "NTE preview source contains an unsupported entry: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

fn stage_and_deploy_nte_preview(
    downloaded_preview: &Path,
    save_path: &Path,
    trusted_library_root: &Path,
    journal: &mut nte_wal::WalJournal,
    destination_parent: &CapDir,
    destination_name: &std::ffi::OsStr,
) -> Result<(), String> {
    let preview_name = downloaded_preview
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Downloaded NTE preview has no valid file name.".to_string())?;
    let preview_extension = downloaded_preview
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !preview_name.starts_with("preview.")
        || !PREVIEW_EXTENSIONS.contains(&preview_extension.as_str())
    {
        return Err("Downloaded NTE preview has an unsupported file type.".to_string());
    }
    let staging_path = deployment_sibling_path(save_path, "staging")?;
    let mut staging_directory = Some(create_bound_staging_directory(
        destination_parent,
        &staging_path,
    )?);
    let result = (|| {
        copy_nte_library_tree(save_path, &staging_path)?;
        for extension in PREVIEW_EXTENSIONS {
            let existing = staging_path.join(format!("preview.{extension}"));
            match std::fs::remove_file(&existing) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(format!(
                        "Unable to replace the existing NTE preview '{}': {err}",
                        existing.display()
                    ));
                }
            }
        }
        std::fs::copy(downloaded_preview, staging_path.join(preview_name))
            .map_err(|err| format!("Unable to stage the NTE preview: {err}"))?;
        deploy_staged_directory(
            save_path,
            &staging_path,
            Some(trusted_library_root),
            Some(journal),
            Some(BoundNteDeployment {
                parent: destination_parent,
                destination_name,
                staging: staging_directory.take().ok_or_else(|| {
                    "NTE preview staging handle was already transferred.".to_string()
                })?,
            }),
        )
    })();
    if result.is_err() {
        if let Some(name) = staging_path.file_name() {
            let _ = cleanup_untransferred_bound_staging(
                staging_directory.take(),
                destination_parent,
                name,
                "failed NTE preview staging",
            );
        }
    }
    result
}

fn deploy_downloaded_nte_preview(
    config_dir: &Path,
    trusted_library_root: &Path,
    save_path: &Path,
    downloaded_preview: &Path,
) -> Result<(), String> {
    nte::with_nte_library_operation_lock(trusted_library_root, Some(config_dir), |journal| {
        let current_library_root = nte::persisted_nte_library_root(config_dir)?;
        if nte::normalized_path_for_comparison(&current_library_root)
            != nte::normalized_path_for_comparison(trusted_library_root)
        {
            return Err("NTE library configuration changed before preview deployment.".to_string());
        }
        recover_nte_library_transaction(trusted_library_root, journal)?;
        nte::with_bound_nte_library_destination(
            trusted_library_root,
            save_path,
            |destination_parent, destination_name| {
                stage_and_deploy_nte_preview(
                    downloaded_preview,
                    save_path,
                    trusted_library_root,
                    journal,
                    destination_parent,
                    destination_name,
                )
            },
        )
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenericModMutationStatePlan {
    before_game_config_hash: String,
    after_game_config_hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenericModMutationRegistryPlan {
    schema_version: u32,
    operation: String,
    game: String,
    trusted_root: String,
    destination_relative_path: String,
    before_hash: Option<String>,
    after_hash: String,
    #[serde(default)]
    state: Option<GenericModMutationStatePlan>,
}

struct GenericStateMutation<'a> {
    plan: GenericModMutationStatePlan,
    commit: Box<dyn FnOnce() -> Result<(), String> + 'a>,
}

struct GenericModMutationContext<'a> {
    operation: &'a str,
    game: &'a str,
    trusted_root: &'a Path,
    registry: &'a mut nte_wal::WalJournal,
    state: Option<GenericStateMutation<'a>>,
}

fn persisted_game_config_hash(config_dir: &Path, game: &str) -> Result<String, String> {
    validate_registered_game_key(game)?;
    let path = config_dir.join(format!("config{game}.json"));
    let metadata = std::fs::metadata(&path)
        .map_err(|err| format!("Unable to inspect persisted {game} configuration: {err}"))?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return Err(format!(
            "Persisted {game} configuration is missing or exceeds the 16 MiB safety limit."
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&path)
            .map_err(|err| format!("Unable to read persisted {game} configuration: {err}"))?,
    )
    .map_err(|err| format!("Unable to parse persisted {game} configuration: {err}"))?;
    if value.get("game").and_then(serde_json::Value::as_str) != Some(game) {
        return Err(format!(
            "Persisted {game} configuration has a mismatched game identity."
        ));
    }
    app_state::stable_json_value_hash(&value)
}

fn persisted_managed_source_root(config_dir: &Path, game: &str) -> Result<PathBuf, String> {
    resolve_managed_folder_from_config_dir(
        config_dir,
        game,
        ManagedPathRoot::Source,
        MANAGED_SOURCE_DIR,
    )
}

fn generic_registry_destination(
    config_dir: &Path,
    plan: &GenericModMutationRegistryPlan,
) -> Result<(PathBuf, PathBuf), String> {
    let valid_schema = (plan.schema_version == 1 && plan.state.is_none())
        || (plan.schema_version == 2 && plan.state.is_some());
    if !valid_schema
        || !matches!(
            plan.operation.as_str(),
            "preview_backfill" | "archive_install" | "gamebanana_binding" | "gamebanana_download"
        )
    {
        return Err("The Mod mutation registry plan has an unsupported operation.".to_string());
    }
    validate_registered_game_key(&plan.game)?;
    let trusted_root = if plan.game == "NTE" {
        nte::persisted_nte_library_root(config_dir)?
    } else {
        persisted_managed_source_root(config_dir, &plan.game)?
    };
    let recorded_root = PathBuf::from(&plan.trusted_root)
        .canonicalize()
        .map_err(|err| format!("Unable to resolve the recorded Mod mutation root: {err}"))?;
    if nte::normalized_path_for_comparison(&trusted_root)
        != nte::normalized_path_for_comparison(&recorded_root)
    {
        return Err("The persisted Mod root changed during mutation recovery.".to_string());
    }
    let destination =
        nte::trusted_nte_library_destination(&trusted_root, &plan.destination_relative_path)?;
    Ok((trusted_root, destination))
}

fn recover_generic_mod_mutation_registry(
    config_dir: &Path,
    registry: &mut nte_wal::WalJournal,
) -> Result<(), String> {
    let Some(incomplete) = registry.incomplete_transaction()? else {
        return Ok(());
    };
    let plan: GenericModMutationRegistryPlan = serde_json::from_slice(&incomplete.prepared_payload)
        .map_err(|err| format!("Unable to read the Mod mutation registry plan: {err}"))?;
    let (trusted_root, destination) = generic_registry_destination(config_dir, &plan)?;
    let state_preference = if let Some(state) = &plan.state {
        let current_hash = persisted_game_config_hash(config_dir, &plan.game)?;
        if current_hash == state.before_game_config_hash {
            LibraryRecoveryPreference::Before
        } else if current_hash == state.after_game_config_hash {
            LibraryRecoveryPreference::After
        } else {
            return Err(
                "The current game configuration matches neither the Mod mutation before nor after state."
                    .to_string(),
            );
        }
    } else {
        LibraryRecoveryPreference::Infer
    };
    mod_mutation::with_library_lock(&trusted_root, |library_journal| {
        recover_nte_library_transaction_from_parent_with_preference(
            &trusted_root,
            library_journal,
            state_preference,
        )
    })?;
    let destination_hash = optional_deployment_tree_hash(&destination)?;

    if (incomplete.state == nte_wal::WalState::AbortedBefore
        && state_preference == LibraryRecoveryPreference::After)
        || (incomplete.state == nte_wal::WalState::CommittedAfter
            && state_preference == LibraryRecoveryPreference::Before)
    {
        return Err(
            "The central Mod mutation WAL conflicts with the visible game configuration."
                .to_string(),
        );
    }

    if incomplete.state == nte_wal::WalState::CommittedAfter {
        if destination_hash.as_deref() != Some(plan.after_hash.as_str()) {
            return Err(
                "A committed Mod mutation does not match its recorded after-state hash."
                    .to_string(),
            );
        }
        return registry.append(
            incomplete.transaction_id,
            nte_wal::WalState::CleanupComplete,
            br#"{"recovery":"cleanup_after"}"#,
        );
    }
    if incomplete.state == nte_wal::WalState::AbortedBefore {
        if destination_hash != plan.before_hash {
            return Err(
                "An aborted Mod mutation does not match its recorded before-state hash."
                    .to_string(),
            );
        }
        return registry.append(
            incomplete.transaction_id,
            nte_wal::WalState::CleanupComplete,
            br#"{"recovery":"cleanup_before"}"#,
        );
    }
    if incomplete.state == nte_wal::WalState::Prepared {
        registry.append(
            incomplete.transaction_id,
            nte_wal::WalState::Committing,
            br#"{"recovery":"begin"}"#,
        )?;
    }
    let terminal = match state_preference {
        LibraryRecoveryPreference::After
            if destination_hash.as_deref() == Some(plan.after_hash.as_str()) =>
        {
            nte_wal::WalState::CommittedAfter
        }
        LibraryRecoveryPreference::Before if destination_hash == plan.before_hash => {
            nte_wal::WalState::AbortedBefore
        }
        LibraryRecoveryPreference::Infer
            if destination_hash.as_deref() == Some(plan.after_hash.as_str()) =>
        {
            nte_wal::WalState::CommittedAfter
        }
        LibraryRecoveryPreference::Infer if destination_hash == plan.before_hash => {
            nte_wal::WalState::AbortedBefore
        }
        _ => {
            return Err(if state_preference == LibraryRecoveryPreference::Infer {
                "The Mod mutation target matches neither its before nor after state; recovery is required."
                    .to_string()
            } else {
                "The Mod mutation target does not match the state-selected recovery direction."
                    .to_string()
            });
        }
    };
    registry.append(
        incomplete.transaction_id,
        nte_wal::WalState::StepReceipt,
        br#"{"recovery":"verified_target"}"#,
    )?;
    registry.append(incomplete.transaction_id, terminal, b"{}")?;
    registry.append(
        incomplete.transaction_id,
        nte_wal::WalState::CleanupComplete,
        br#"{"recovery":"complete"}"#,
    )
}

fn deploy_generic_staged_directory(
    save_path: &Path,
    staging_path: &Path,
    bound: BoundNteDeployment<'_>,
    context: GenericModMutationContext<'_>,
) -> Result<(), String> {
    let GenericModMutationContext {
        operation,
        game,
        trusted_root,
        registry,
        state: state_mutation,
    } = context;
    let destination = nte::canonical_nte_library_destination(trusted_root, save_path)?;
    let destination_relative_path = destination
        .strip_prefix(trusted_root)
        .map_err(|_| "The generic Mod destination escaped its persisted root.".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let state_plan = state_mutation
        .as_ref()
        .map(|mutation| mutation.plan.clone());
    let plan = GenericModMutationRegistryPlan {
        schema_version: if state_plan.is_some() { 2 } else { 1 },
        operation: operation.to_string(),
        game: game.to_string(),
        trusted_root: trusted_root.to_string_lossy().into_owned(),
        destination_relative_path,
        before_hash: optional_deployment_tree_hash(save_path)?,
        after_hash: deployment_tree_hash(staging_path)?,
        state: state_plan,
    };
    let payload = serde_json::to_vec(&plan)
        .map_err(|err| format!("Unable to serialize the Mod mutation registry plan: {err}"))?;
    let transaction_id = registry.begin(&payload)?;
    registry.append(transaction_id, nte_wal::WalState::Committing, b"{}")?;

    let deploy_result = mod_mutation::with_library_lock(trusted_root, |library_journal| {
        recover_nte_library_transaction(trusted_root, library_journal)?;
        deploy_staged_directory_with_commit(
            save_path,
            staging_path,
            Some(trusted_root),
            Some(library_journal),
            Some(bound),
            || {
                registry.append(
                    transaction_id,
                    nte_wal::WalState::StepReceipt,
                    br#"{"step":"filesystem","outcome":"applied"}"#,
                )?;
                if let Some(state_mutation) = state_mutation {
                    (state_mutation.commit)()?;
                    registry.append(
                        transaction_id,
                        nte_wal::WalState::StepReceipt,
                        br#"{"step":"state","outcome":"applied"}"#,
                    )?;
                }
                Ok(())
            },
        )
    });
    if let Err(error) = deploy_result {
        let current = optional_deployment_tree_hash(save_path)?;
        if current == plan.before_hash {
            registry.append(
                transaction_id,
                nte_wal::WalState::StepReceipt,
                br#"{"step":"filesystem","outcome":"rolled_back"}"#,
            )?;
            registry.append(transaction_id, nte_wal::WalState::AbortedBefore, b"{}")?;
            registry.append(
                transaction_id,
                nte_wal::WalState::CleanupComplete,
                br#"{"cleanup":"complete"}"#,
            )?;
        }
        return Err(error);
    }
    if optional_deployment_tree_hash(save_path)?.as_deref() != Some(plan.after_hash.as_str()) {
        return Err(
            "The generic Mod deployment does not match its recorded after state.".to_string(),
        );
    }
    registry.append(transaction_id, nte_wal::WalState::CommittedAfter, b"{}")?;
    registry.append(
        transaction_id,
        nte_wal::WalState::CleanupComplete,
        br#"{"cleanup":"complete"}"#,
    )
}

fn stage_and_deploy_generic_preview(
    downloaded_preview: &Path,
    save_path: &Path,
    mutation: Option<GenericModMutationContext<'_>>,
) -> Result<(), String> {
    let Some(context) = mutation else {
        return stage_and_deploy_generic_preview_inner(downloaded_preview, save_path, None, None);
    };
    let trusted_root = context.trusted_root;
    nte::with_bound_nte_library_destination(
        trusted_root,
        save_path,
        move |destination_parent, destination_name| {
            stage_and_deploy_generic_preview_inner(
                downloaded_preview,
                save_path,
                Some(context),
                Some((destination_parent, destination_name)),
            )
        },
    )
}

fn stage_and_deploy_generic_preview_inner(
    downloaded_preview: &Path,
    save_path: &Path,
    mutation: Option<GenericModMutationContext<'_>>,
    bound_destination: Option<(&CapDir, &std::ffi::OsStr)>,
) -> Result<(), String> {
    let staging_path = deployment_sibling_path(save_path, "preview-staging")?;
    let mut staging_directory = if let Some((parent, _)) = bound_destination {
        Some(create_bound_staging_directory(parent, &staging_path)?)
    } else {
        remove_directory_if_exists(&staging_path)?;
        None
    };
    let result = (|| {
        copy_nte_library_tree(save_path, &staging_path)?;
        for entry in std::fs::read_dir(&staging_path)
            .map_err(|err| format!("Unable to inspect generic preview staging: {err}"))?
        {
            let entry =
                entry.map_err(|err| format!("Unable to inspect generic preview staging: {err}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !is_preview_file_name(&name) {
                continue;
            }
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|err| format!("Unable to inspect generic preview entry: {err}"))?;
            if !metadata.is_file() || deployment_metadata_is_reparse(&metadata) {
                return Err(format!(
                    "Generic preview entry '{}' is not a safe regular file.",
                    entry.path().display()
                ));
            }
            std::fs::remove_file(entry.path()).map_err(|err| {
                format!(
                    "Unable to remove superseded generic preview '{}': {err}",
                    entry.path().display()
                )
            })?;
        }
        std::fs::copy(downloaded_preview, staging_path.join("preview.jpg"))
            .map_err(|err| format!("Unable to stage generic preview.jpg: {err}"))?;
        let bound = match (bound_destination, staging_directory.take()) {
            (Some((parent, destination_name)), Some(staging)) => Some(BoundNteDeployment {
                parent,
                destination_name,
                staging,
            }),
            (None, None) => None,
            _ => return Err("Generic preview staging binding is incomplete.".to_string()),
        };
        match mutation {
            Some(context) => deploy_generic_staged_directory(
                save_path,
                &staging_path,
                bound.ok_or_else(|| {
                    "Generic preview mutation requires bound staging.".to_string()
                })?,
                context,
            ),
            None => deploy_staged_directory(save_path, &staging_path, None, None, bound),
        }
    })();
    if let Err(error) = result {
        let cleanup_result = if let Some((parent, _)) = bound_destination {
            let name = staging_path
                .file_name()
                .ok_or_else(|| "Generic preview staging directory has no name.".to_string())?;
            cleanup_untransferred_bound_staging(
                staging_directory.take(),
                parent,
                name,
                "failed generic preview staging",
            )
        } else {
            remove_directory_if_exists(&staging_path)
        };
        return match cleanup_result {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; unable to clean failed generic preview staging: {cleanup_error}"
            )),
        };
    }
    drop(staging_directory.take());
    Ok(())
}

async fn prepare_normalized_preview_staging<A: DownloadAppContext>(
    app_handle: &A,
    key: &str,
    preview_url: &str,
) -> Result<(BoundNteDownloadStaging, PathBuf), String> {
    let cached_preview = match prepare_install_preview(app_handle, Some(preview_url), key).await {
        PreparedInstallPreview::Ready(path) => path,
        PreparedInstallPreview::Unavailable(error) => return Err(error),
    };
    let normalized_jpeg = decode_preview_candidate(&cached_preview)?;
    let app_local_data = app_handle
        .app_local_data_dir()
        .map_err(|err| format!("Unable to resolve preview staging: {err}"))?;
    let staging = nte_download_staging_directory(
        app_handle,
        key,
        &app_local_data.join("preview-backfill-placeholder"),
    )?;
    let staged_preview = staging.join("preview.jpg");
    let stage_result = (|| {
        std::fs::write(&staged_preview, normalized_jpeg)
            .map_err(|err| format!("Unable to write backfill preview staging: {err}"))?;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&staged_preview)
            .and_then(|file| file.sync_all())
            .map_err(|err| format!("Unable to flush backfill preview staging: {err}"))
    })();
    match stage_result {
        Ok(()) => Ok((staging, staged_preview)),
        Err(error) => match staging.cleanup() {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; unable to clean preview staging: {cleanup_error}"
            )),
        },
    }
}

fn commit_game_config_for_mod_mutation(
    repository: &app_state::AppStateRepository,
    game: &str,
    next_game: serde_json::Value,
    expected_game_revision: u64,
    state_plan: &GenericModMutationStatePlan,
) -> Result<app_state::AppConfigSnapshot, String> {
    let save_result = repository.save_config_for_mod_mutation(
        None,
        Some(next_game),
        None,
        Some(expected_game_revision),
    );
    let snapshot = match save_result {
        Ok(snapshot) => snapshot,
        Err(save_error) => {
            let visible = repository.load_config(Some(game)).map_err(|read_error| {
                format!(
                    "Unable to determine whether the game configuration committed ({save_error}); state recovery also failed ({read_error})"
                )
            })?;
            let visible_game = visible.game.as_ref().ok_or_else(|| {
                format!("Application state is missing {game} after a Mod mutation commit.")
            })?;
            let visible_hash = app_state::stable_json_value_hash(visible_game)?;
            if visible_hash == state_plan.after_game_config_hash {
                visible
            } else if visible_hash == state_plan.before_game_config_hash {
                return Err(save_error);
            } else {
                return Err(format!(
                    "Game configuration commit is ambiguous after an error: {save_error}"
                ));
            }
        }
    };
    let committed_game = snapshot
        .game
        .as_ref()
        .ok_or_else(|| format!("Application state is missing committed {game} configuration."))?;
    if app_state::stable_json_value_hash(committed_game)? != state_plan.after_game_config_hash {
        return Err(
            "Committed game configuration does not match the prepared Mod mutation state."
                .to_string(),
        );
    }
    Ok(snapshot)
}

fn download_history_item_matches(
    candidate: &serde_json::Value,
    completed: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    let Some(candidate) = candidate.as_object() else {
        return false;
    };
    let completed_key = completed.get("key").and_then(serde_json::Value::as_str);
    let candidate_key = candidate.get("key").and_then(serde_json::Value::as_str);
    if completed_key.is_some() && completed_key == candidate_key {
        return true;
    }
    ["source", "file", "fname"].into_iter().all(|field| {
        candidate.get(field).and_then(serde_json::Value::as_str)
            == completed.get(field).and_then(serde_json::Value::as_str)
    })
}

fn prepare_gamebanana_download_state(
    repository: &app_state::AppStateRepository,
    game: &str,
    request: &GameBananaDownloadState,
    destination: &Path,
) -> Result<PreparedDownloadStateMutation, String> {
    validate_registered_game_key(game)?;
    let relative = validate_managed_relative_path(&request.relative_path)?;
    if relative.as_os_str().is_empty() {
        return Err("GameBanana download requires a Mod-relative path.".to_string());
    }
    if request.config_updated_at.trim().is_empty() || request.config_updated_at.len() > 128 {
        return Err("GameBanana download has an invalid configuration timestamp.".to_string());
    }
    let completed_bytes = serde_json::to_vec(&request.completed_download)
        .map_err(|err| format!("Unable to validate completed download metadata: {err}"))?;
    if completed_bytes.len() > 128 * 1024 {
        return Err("Completed download metadata exceeds the 128 KiB safety limit.".to_string());
    }
    let completed_input = request
        .completed_download
        .as_object()
        .ok_or_else(|| "Completed download metadata is not an object.".to_string())?;
    for field in ["key", "file", "fname"] {
        if completed_input
            .get(field)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.len() <= 4_096)
            .is_none()
        {
            return Err(format!(
                "Completed download metadata has an invalid {field}."
            ));
        }
    }
    if completed_input
        .get("source")
        .and_then(serde_json::Value::as_str)
        != Some(request.source.as_str())
    {
        return Err(
            "Completed download source does not match the Mod metadata source.".to_string(),
        );
    }
    let mod_id = completed_input
        .get("gameBananaModId")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "Completed download has no valid GameBanana Mod ID.".to_string())?;
    if app_state::gamebanana_mod_id_from_profile_url(&request.source) != Some(mod_id) {
        return Err("Completed download source does not match its GameBanana Mod ID.".to_string());
    }
    let file_id = completed_input
        .get("gameBananaFileId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 2_048)
        .ok_or_else(|| "Completed download has no valid GameBanana file ID.".to_string())?;
    let selected_file_size = completed_input
        .get("expectedSize")
        .and_then(serde_json::Value::as_u64);
    let selected_file_updated_at = completed_input
        .get("updated")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let selected_file_name = completed_input
        .get("fname")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Completed download has no file name.".to_string())?;

    let snapshot = repository.load_config(Some(game))?;
    let expected_game_revision = snapshot
        .game_revision
        .ok_or_else(|| format!("Application state is missing the {game} revision."))?;
    let mut next_game = snapshot
        .game
        .ok_or_else(|| format!("Application state is missing {game}."))?;
    let normalized_relative = relative.to_string_lossy().replace('/', "\\");
    let data = next_game
        .get_mut("data")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| format!("{game} Mod metadata is invalid."))?;
    let current_entry = data.get(&normalized_relative).cloned();
    if current_entry != request.expected_data_entry {
        return Err(
            "The target Mod metadata changed while the GameBanana download was pending."
                .to_string(),
        );
    }
    let mut next_entry = match current_entry {
        Some(serde_json::Value::Object(entry)) => entry,
        Some(_) => return Err("The target Mod metadata entry is not an object.".to_string()),
        None => serde_json::Map::new(),
    };
    let existing_binding = next_entry
        .get("gameBanana")
        .and_then(serde_json::Value::as_object)
        .filter(|binding| binding.get("modId").and_then(serde_json::Value::as_u64) == Some(mod_id));
    let variant = existing_binding
        .and_then(|binding| binding.get("variant"))
        .and_then(serde_json::Value::as_str)
        .filter(|variant| matches!(*variant, "primary" | "independent"))
        .unwrap_or_else(|| {
            if completed_input
                .get("addon")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                "independent"
            } else {
                "primary"
            }
        });
    let bound_at = existing_binding
        .and_then(|binding| binding.get("boundAt"))
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or(request.viewed_at.max(1));
    let mut binding = serde_json::json!({
        "provider": "gamebanana",
        "modId": mod_id,
        "profileUrl": request.source,
        "variant": variant,
        "boundAt": bound_at,
    });
    if let Some(size) = selected_file_size {
        binding["selectedFile"] = serde_json::json!({
            "id": file_id,
            "name": selected_file_name,
            "size": size,
            "updatedAt": selected_file_updated_at,
        });
    }
    next_entry.insert(
        "source".to_string(),
        serde_json::Value::String(request.source.clone()),
    );
    next_entry.insert(
        "updatedAt".to_string(),
        serde_json::Value::Number(request.updated_at.into()),
    );
    next_entry.insert(
        "viewedAt".to_string(),
        serde_json::Value::Number(request.viewed_at.into()),
    );
    next_entry.insert("gameBanana".to_string(), binding);
    data.insert(
        normalized_relative.clone(),
        serde_json::Value::Object(next_entry),
    );

    let downloads = next_game
        .get_mut("downloads")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| format!("{game} download history is invalid."))?;
    let mut completed = completed_input.clone();
    completed.insert(
        "status".to_string(),
        serde_json::Value::String("completed".to_string()),
    );
    completed.insert(
        "path".to_string(),
        serde_json::Value::String(normalized_relative),
    );
    completed.insert(
        "dlPath".to_string(),
        serde_json::Value::String(destination.to_string_lossy().into_owned()),
    );
    for queue in ["queue", "downloading", "extracting", "failed", "completed"] {
        let entries = downloads
            .get_mut(queue)
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(|| format!("{game} download queue '{queue}' is invalid."))?;
        entries.retain(|candidate| !download_history_item_matches(candidate, &completed));
    }
    downloads
        .get_mut("completed")
        .and_then(serde_json::Value::as_array_mut)
        .expect("validated completed download array")
        .push(serde_json::Value::Object(completed));
    next_game["updatedAt"] = serde_json::Value::String(request.config_updated_at.clone());

    let preflight =
        repository.preflight_game_config_update(game, &next_game, expected_game_revision)?;
    Ok(PreparedDownloadStateMutation {
        next_game,
        expected_game_revision,
        plan: GenericModMutationStatePlan {
            before_game_config_hash: preflight.before_game_config_hash,
            after_game_config_hash: preflight.after_game_config_hash,
        },
    })
}

#[tauri::command]
async fn bind_gamebanana_mod(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, app_state::AppStateRepository>,
    game: String,
    relative_path: String,
    preview_url: String,
    game_config: serde_json::Value,
    expected_game_revision: u64,
) -> Result<app_state::AppConfigSnapshot, String> {
    validate_registered_game_key(&game)?;
    let relative = validate_managed_relative_path(&relative_path)?;
    if relative.as_os_str().is_empty() {
        return Err("GameBanana binding requires a Mod-relative path.".to_string());
    }
    repository.preflight_game_config_update(&game, &game_config, expected_game_revision)?;
    let key = format!("binding-{game}-{}", relative.to_string_lossy());
    let (staging, staged_preview) =
        prepare_normalized_preview_staging(&app_handle, &key, &preview_url).await?;
    let config_dir = std::env::current_dir().map_err(|err| err.to_string())?;
    let control_root = repository.control_root().to_path_buf();
    let managed_relative = PathBuf::from(MANAGED_SOURCE_DIR).join(&relative);
    let task_app = app_handle.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let repository = task_app.state::<app_state::AppStateRepository>();
        mod_mutation::with_global_lock(&control_root, |registry| {
            recover_generic_mod_mutation_registry(&config_dir, registry)?;
            let preflight = repository.preflight_game_config_update(
                &game,
                &game_config,
                expected_game_revision,
            )?;
            let state_plan = GenericModMutationStatePlan {
                before_game_config_hash: preflight.before_game_config_hash,
                after_game_config_hash: preflight.after_game_config_hash,
            };
            let save_path = resolve_managed_folder_from_config_dir(
                &config_dir,
                &game,
                ManagedPathRoot::Source,
                &managed_relative.to_string_lossy(),
            )?;
            let trusted_root = if game == "NTE" {
                nte::persisted_nte_library_root(&config_dir)?
            } else {
                persisted_managed_source_root(&config_dir, &game)?
            };
            let trusted_destination =
                nte::trusted_nte_library_destination(&trusted_root, &relative_path)?;
            if nte::normalized_path_for_comparison(&trusted_destination)
                != nte::normalized_path_for_comparison(&save_path)
            {
                return Err("GameBanana binding destination changed before deployment.".to_string());
            }

            let mut committed_snapshot = None;
            {
                let snapshot_slot = &mut committed_snapshot;
                let commit_plan = state_plan.clone();
                let commit_game = game.clone();
                let commit_config = game_config.clone();
                stage_and_deploy_generic_preview(
                    &staged_preview,
                    &save_path,
                    Some(GenericModMutationContext {
                        operation: "gamebanana_binding",
                        game: &game,
                        trusted_root: &trusted_root,
                        registry,
                        state: Some(GenericStateMutation {
                            plan: state_plan,
                            commit: Box::new(move || {
                                let snapshot = commit_game_config_for_mod_mutation(
                                    &repository,
                                    &commit_game,
                                    commit_config,
                                    expected_game_revision,
                                    &commit_plan,
                                )?;
                                *snapshot_slot = Some(snapshot);
                                Ok(())
                            }),
                        }),
                    }),
                )?;
            }
            committed_snapshot.ok_or_else(|| {
                "GameBanana binding completed without a committed state snapshot.".to_string()
            })
        })
    })
    .await;
    let result = match worker {
        Ok(result) => result,
        Err(error) => Err(format!("GameBanana binding worker failed: {error}")),
    };
    let cleanup = staging.cleanup();
    match (result, cleanup) {
        (Ok(snapshot), Ok(())) => Ok(snapshot),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup_error)) => Err(format!(
            "{error}; unable to clean GameBanana binding staging: {cleanup_error}"
        )),
    }
}

#[tauri::command]
async fn backfill_mod_preview(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, app_state::AppStateRepository>,
    game: String,
    relative_path: String,
    preview_url: String,
) -> Result<(), String> {
    validate_registered_game_key(&game)?;
    let relative = validate_managed_relative_path(&relative_path)?;
    if relative.as_os_str().is_empty() {
        return Err("Preview backfill requires a Mod-relative path.".to_string());
    }
    let key = format!("backfill-{game}-{}", relative.to_string_lossy());
    let (staging, staged_preview) =
        prepare_normalized_preview_staging(&app_handle, &key, &preview_url).await?;

    let config_dir = std::env::current_dir().map_err(|err| err.to_string())?;
    let control_root = repository.control_root().to_path_buf();
    let managed_relative = PathBuf::from(MANAGED_SOURCE_DIR).join(&relative);
    let worker = tauri::async_runtime::spawn_blocking(move || {
        mod_mutation::with_global_lock(&control_root, |registry| {
            recover_generic_mod_mutation_registry(&config_dir, registry)?;
            let save_path = resolve_managed_folder_from_config_dir(
                &config_dir,
                &game,
                ManagedPathRoot::Source,
                &managed_relative.to_string_lossy(),
            )?;
            if game == "NTE" {
                let library_root = nte::persisted_nte_library_root(&config_dir)?;
                let trusted = nte::trusted_nte_library_destination(&library_root, &relative_path)?;
                if nte::normalized_path_for_comparison(&trusted)
                    != nte::normalized_path_for_comparison(&save_path)
                {
                    return Err("NTE preview destination changed before deployment.".to_string());
                }
                deploy_downloaded_nte_preview(&config_dir, &library_root, &trusted, &staged_preview)
            } else {
                let trusted_root = persisted_managed_source_root(&config_dir, &game)?;
                stage_and_deploy_generic_preview(
                    &staged_preview,
                    &save_path,
                    Some(GenericModMutationContext {
                        operation: "preview_backfill",
                        game: &game,
                        trusted_root: &trusted_root,
                        registry,
                        state: None,
                    }),
                )
            }
        })
    })
    .await;
    let result = match worker {
        Ok(result) => result,
        Err(error) => Err(format!("Preview backfill worker failed: {error}")),
    };
    let cleanup = staging.cleanup();
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(cleanup_error)) => Err(format!(
            "{error}; unable to clean preview backfill staging: {cleanup_error}"
        )),
    }
}

fn prepare_normalized_preview_data_staging<A: DownloadAppContext>(
    app_handle: &A,
    key: &str,
    extension: &str,
    data: &[u8],
) -> Result<(BoundNteDownloadStaging, PathBuf), String> {
    if data.is_empty() || data.len() > INSTALL_PREVIEW_MAX_BYTES as usize {
        return Err(format!(
            "Preview data must be between 1 byte and {INSTALL_PREVIEW_MAX_BYTES} bytes."
        ));
    }
    let expected = match extension.to_ascii_lowercase().as_str() {
        "png" => image::ImageFormat::Png,
        "jpg" | "jpeg" => image::ImageFormat::Jpeg,
        "webp" => image::ImageFormat::WebP,
        _ => return Err("Preview data has an unsupported file extension.".to_string()),
    };
    let detected = image::guess_format(data)
        .map_err(|error| format!("Unable to identify preview data: {error}"))?;
    if detected != expected {
        return Err("Preview data does not match its file extension.".to_string());
    }
    let normalized_jpeg = remote_media::decode_and_reencode_preview_jpeg(data)?;
    let app_local_data = app_handle
        .app_local_data_dir()
        .map_err(|error| format!("Unable to resolve preview staging: {error}"))?;
    let staging = nte_download_staging_directory(
        app_handle,
        key,
        &app_local_data.join("local-preview-placeholder"),
    )?;
    let staged_preview = staging.join("preview.jpg");
    let stage_result = (|| {
        std::fs::write(&staged_preview, normalized_jpeg)
            .map_err(|error| format!("Unable to write local preview staging: {error}"))?;
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&staged_preview)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Unable to flush local preview staging: {error}"))
    })();
    match stage_result {
        Ok(()) => Ok((staging, staged_preview)),
        Err(error) => match staging.cleanup() {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; unable to clean local preview staging: {cleanup_error}"
            )),
        },
    }
}

#[cfg(windows)]
fn bound_preview_metadata_is_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;
    metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
fn bound_preview_metadata_is_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    metadata.is_symlink()
}

fn read_selected_preview_file(source: &Path) -> Result<(String, Vec<u8>), String> {
    let parent = source
        .parent()
        .ok_or_else(|| "Selected preview has no parent directory.".to_string())?;
    let name = source
        .file_name()
        .ok_or_else(|| "Selected preview has no file name.".to_string())?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Selected preview has no file extension.".to_string())?
        .to_string();
    let directory = CapDir::open_ambient_dir(parent, ambient_authority())
        .map_err(|error| format!("Unable to bind the selected preview directory: {error}"))?;
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let input = directory
        .open_with(Path::new(name), &options)
        .map_err(|error| format!("Unable to open the selected preview safely: {error}"))?;
    let metadata = input
        .metadata()
        .map_err(|error| format!("Unable to inspect the selected preview: {error}"))?;
    if !metadata.is_file() || bound_preview_metadata_is_reparse(&metadata) {
        return Err("Selected preview is not a safe regular file.".to_string());
    }
    if metadata.len() == 0 || metadata.len() > INSTALL_PREVIEW_MAX_BYTES {
        return Err(format!(
            "Selected preview must be between 1 byte and {INSTALL_PREVIEW_MAX_BYTES} bytes."
        ));
    }
    let expected_len = metadata.len() as usize;
    let mut data = Vec::with_capacity(expected_len);
    input
        .take(INSTALL_PREVIEW_MAX_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|error| format!("Unable to read the selected preview: {error}"))?;
    if data.len() != expected_len {
        return Err("Selected preview changed while it was being read.".to_string());
    }
    Ok((extension, data))
}

enum ManagedPreviewInput {
    Data { extension: String, data: Vec<u8> },
    File(PathBuf),
}

async fn replace_managed_preview(
    app_handle: tauri::AppHandle,
    control_root: PathBuf,
    game: String,
    relative_path: String,
    input: ManagedPreviewInput,
) -> Result<(), String> {
    validate_registered_game_key(&game)?;
    let relative = validate_managed_relative_path(&relative_path)?;
    if relative.as_os_str().is_empty() {
        return Err("A Mod-relative path is required for preview replacement.".to_string());
    }
    let config_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let (extension, data) = match input {
            ManagedPreviewInput::Data { extension, data } => (extension, data),
            ManagedPreviewInput::File(source) => read_selected_preview_file(&source)?,
        };
        let key = format!("local-preview-{game}-{}", relative.to_string_lossy());
        let (staging, staged_preview) =
            prepare_normalized_preview_data_staging(&app_handle, &key, &extension, &data)?;
        let managed_relative = PathBuf::from(MANAGED_SOURCE_DIR).join(&relative);
        let result = mod_mutation::with_global_lock(&control_root, |registry| {
            recover_generic_mod_mutation_registry(&config_dir, registry)?;
            let save_path = resolve_managed_folder_from_config_dir(
                &config_dir,
                &game,
                ManagedPathRoot::Source,
                &managed_relative.to_string_lossy(),
            )?;
            if game == "NTE" {
                let library_root = nte::persisted_nte_library_root(&config_dir)?;
                let trusted = nte::trusted_nte_library_destination(&library_root, &relative_path)?;
                if nte::normalized_path_for_comparison(&trusted)
                    != nte::normalized_path_for_comparison(&save_path)
                {
                    return Err("NTE preview destination changed before deployment.".to_string());
                }
                deploy_downloaded_nte_preview(&config_dir, &library_root, &trusted, &staged_preview)
            } else {
                let trusted_root = persisted_managed_source_root(&config_dir, &game)?;
                stage_and_deploy_generic_preview(
                    &staged_preview,
                    &save_path,
                    Some(GenericModMutationContext {
                        operation: "local_preview_replacement",
                        game: &game,
                        trusted_root: &trusted_root,
                        registry,
                        state: None,
                    }),
                )
            }
        });
        let cleanup = staging.cleanup();
        match (result, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Err(error), Err(cleanup_error)) => Err(format!(
                "{error}; unable to clean local preview staging: {cleanup_error}"
            )),
        }
    })
    .await
    .map_err(|error| format!("Local preview worker failed: {error}"))?
}

#[tauri::command]
async fn save_managed_preview_data(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, app_state::AppStateRepository>,
    game: String,
    relative_path: String,
    extension: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let control_root = repository.control_root().to_path_buf();
    replace_managed_preview(
        app_handle,
        control_root,
        game,
        relative_path,
        ManagedPreviewInput::Data { extension, data },
    )
    .await
}

#[tauri::command]
async fn import_managed_preview_file(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, app_state::AppStateRepository>,
    game: String,
    relative_path: String,
    source_path: String,
) -> Result<(), String> {
    let control_root = repository.control_root().to_path_buf();
    replace_managed_preview(
        app_handle,
        control_root,
        game,
        relative_path,
        ManagedPreviewInput::File(PathBuf::from(source_path)),
    )
    .await
}

fn validate_nte_staged_content(root: &Path) -> Result<(), String> {
    const ALLOWED_EXTENSIONS: &[&str] = &["pak", "utoc", "ucas"];
    let mut pending = vec![root.to_path_buf()];
    let mut file_count = 0usize;
    let mut has_pak = false;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let file_type = entry.file_type().map_err(|err| err.to_string())?;
            if file_type.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                return Err(format!(
                    "NTE archive contains an unsupported filesystem entry: {}",
                    entry.path().display()
                ));
            }
            file_count += 1;
            if entry.path() == root.join("preview.jpg") {
                continue;
            }
            let extension = entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            if !ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
                return Err(format!(
                    "NTE archives may contain only .pak, .utoc, and .ucas files: {}",
                    entry.path().display()
                ));
            }
            has_pak |= extension == "pak";
        }
    }
    if file_count == 0 || !has_pak {
        return Err("NTE archive does not contain a .pak payload".to_string());
    }
    Ok(())
}

fn sync_staged_tree(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut directories = Vec::new();
    while let Some(directory) = pending.pop() {
        directories.push(directory.clone());
        for entry in std::fs::read_dir(&directory).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let metadata =
                std::fs::symlink_metadata(entry.path()).map_err(|err| err.to_string())?;
            if deployment_metadata_is_reparse(&metadata) {
                return Err(format!(
                    "NTE staging contains a reparse point: {}",
                    entry.path().display()
                ));
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(entry.path())
                    .and_then(|file| file.sync_all())
                    .map_err(|err| {
                        format!(
                            "Unable to flush NTE staged file '{}': {err}",
                            entry.path().display()
                        )
                    })?;
            } else {
                return Err(format!(
                    "NTE staging contains an unsupported filesystem entry: {}",
                    entry.path().display()
                ));
            }
        }
    }
    #[cfg(not(windows))]
    for directory in directories.into_iter().rev() {
        std::fs::File::open(&directory)
            .and_then(|file| file.sync_all())
            .map_err(|err| {
                format!(
                    "Unable to flush NTE staging directory '{}': {err}",
                    directory.display()
                )
            })?;
    }
    Ok(())
}

struct BoundNteDeployment<'a> {
    parent: &'a CapDir,
    destination_name: &'a std::ffi::OsStr,
    staging: CapDir,
}

fn remove_bound_directory_if_exists(
    parent: &CapDir,
    name: &std::ffi::OsStr,
    label: &str,
) -> Result<(), String> {
    nte::remove_bound_directory_tree(parent, name, label)
}

fn create_bound_staging_directory(parent: &CapDir, staging_path: &Path) -> Result<CapDir, String> {
    let name = staging_path
        .file_name()
        .ok_or_else(|| "NTE staging directory has no name.".to_string())?;
    remove_bound_directory_if_exists(parent, name, "NTE staging directory")?;
    parent
        .create_dir(name)
        .map_err(|err| format!("Unable to create bound NTE staging directory: {err}"))?;
    nte::open_bound_directory_for_rename(parent, name, "NTE staging")
}

fn cleanup_untransferred_bound_staging(
    staging: Option<CapDir>,
    parent: &CapDir,
    name: &std::ffi::OsStr,
    label: &str,
) -> Result<(), String> {
    match staging {
        Some(staging) => nte::remove_open_bound_directory_tree(staging, parent, name, label),
        None => Ok(()),
    }
}

fn deploy_staged_directory(
    save_path: &Path,
    staging_path: &Path,
    trusted_library_root: Option<&Path>,
    journal: Option<&mut nte_wal::WalJournal>,
    bound: Option<BoundNteDeployment<'_>>,
) -> Result<(), String> {
    deploy_staged_directory_with_commit(
        save_path,
        staging_path,
        trusted_library_root,
        journal,
        bound,
        || Ok(()),
    )
}

fn deploy_staged_directory_with_commit<F>(
    save_path: &Path,
    staging_path: &Path,
    trusted_library_root: Option<&Path>,
    mut journal: Option<&mut nte_wal::WalJournal>,
    mut bound: Option<BoundNteDeployment<'_>>,
    commit_after_filesystem: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    if journal.is_some() && bound.is_none() {
        return Err("NTE library WAL deployment requires a bound destination.".to_string());
    }
    sync_staged_tree(staging_path)?;
    let backup_path = deployment_sibling_path(save_path, "backup")?;
    let backup_name = backup_path
        .file_name()
        .ok_or_else(|| "NTE library backup directory has no valid name.".to_string())?;
    if let Some(bound) = bound.as_ref() {
        remove_bound_directory_if_exists(bound.parent, backup_name, "NTE backup directory")?;
    } else {
        remove_directory_if_exists(&backup_path)?;
    }
    let mut existing_handle = if let Some(bound) = bound.as_ref() {
        match bound.parent.symlink_metadata(bound.destination_name) {
            Ok(metadata) if metadata.is_dir() && !cap_deployment_metadata_is_reparse(&metadata) => {
                Some(nte::open_bound_directory_for_rename(
                    bound.parent,
                    bound.destination_name,
                    "NTE existing destination",
                )?)
            }
            Ok(_) => return Err("The existing NTE library destination is unsafe.".to_string()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => {
                return Err(format!(
                    "Unable to inspect the existing NTE library destination: {err}"
                ));
            }
        }
    } else {
        None
    };
    let had_existing = if bound.is_some() {
        existing_handle.is_some()
    } else {
        save_path.exists()
    };
    let transaction_id = if let Some(journal) = journal.as_deref_mut() {
        let trusted_library_root = trusted_library_root
            .ok_or_else(|| "NTE library transaction has no persisted root.".to_string())?;
        let canonical_destination =
            nte::canonical_nte_library_destination(trusted_library_root, save_path)?;
        let destination_relative_path = canonical_destination
            .strip_prefix(trusted_library_root)
            .map_err(|_| "NTE library destination escaped the persisted root.".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        nte::trusted_nte_library_destination(trusted_library_root, &destination_relative_path)?;
        let staging_name = staging_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "NTE library staging directory has no valid name.".to_string())?;
        let backup_name = backup_name
            .to_str()
            .ok_or_else(|| "NTE library backup directory has no valid name.".to_string())?;
        let plan = NteLibraryWalPlan {
            operation: if had_existing {
                "library_update"
            } else {
                "library_install"
            }
            .to_string(),
            destination_relative_path,
            staging_name: staging_name.to_string(),
            backup_name: backup_name.to_string(),
            before_hash: optional_deployment_tree_hash(save_path)?,
            after_hash: deployment_tree_hash(staging_path)?,
        };
        let payload = serde_json::to_vec(&plan)
            .map_err(|err| format!("Unable to serialize the NTE transaction plan: {err}"))?;
        let transaction_id = journal.begin(&payload)?;
        journal.append(transaction_id, nte_wal::WalState::Committing, b"{}")?;
        Some(transaction_id)
    } else {
        None
    };
    if had_existing {
        let backup_result = if let Some(bound) = bound.as_ref() {
            nte::durable_rename_bound_directory(
                existing_handle
                    .as_ref()
                    .expect("bound existing destination is present"),
                bound.parent,
                bound.destination_name,
                bound.parent,
                backup_name,
            )
        } else {
            nte::durable_rename(save_path, &backup_path)
        };
        if let Err(err) = backup_result {
            drop(existing_handle.take());
            let failed_staging = bound.take().map(|bound| (bound.parent, bound.staging));
            if let (Some(journal), Some(transaction_id)) = (journal.as_deref_mut(), transaction_id)
            {
                journal.append(
                    transaction_id,
                    nte_wal::WalState::StepReceipt,
                    br#"{"step":"backup_previous","outcome":"not_applied"}"#,
                )?;
                journal.append(transaction_id, nte_wal::WalState::AbortedBefore, b"{}")?;
                let (cleanup_parent, staging_handle) = failed_staging.ok_or_else(|| {
                    "NTE library abort cleanup lost the bound staging handle.".to_string()
                })?;
                cleanup_open_nte_library_artifacts(
                    cleanup_parent,
                    staging_path.file_name().ok_or_else(|| {
                        "NTE library staging cleanup path has no name.".to_string()
                    })?,
                    Some(staging_handle),
                    backup_name,
                    None,
                )?;
                journal.append(
                    transaction_id,
                    nte_wal::WalState::CleanupComplete,
                    br#"{"cleanup":"complete"}"#,
                )?;
            }
            return Err(format!(
                "Unable to stage the previous mod directory for replacement: {err}"
            ));
        }
        if let (Some(journal), Some(transaction_id)) = (journal.as_deref_mut(), transaction_id) {
            journal.append(
                transaction_id,
                nte_wal::WalState::StepReceipt,
                br#"{"step":"backup_previous","outcome":"applied"}"#,
            )?;
        }
    }
    let staging_name = staging_path
        .file_name()
        .ok_or_else(|| "NTE staging directory has no valid name.".to_string())?;
    let deploy_result = if let Some(bound) = bound.as_ref() {
        nte::durable_rename_bound_directory(
            &bound.staging,
            bound.parent,
            staging_name,
            bound.parent,
            bound.destination_name,
        )
    } else {
        nte::durable_rename(staging_path, save_path)
    };
    if let Err(err) = deploy_result {
        if had_existing {
            let restore_result = if let Some(bound) = bound.as_ref() {
                nte::durable_rename_bound_directory(
                    existing_handle
                        .as_ref()
                        .expect("bound backup destination is present"),
                    bound.parent,
                    backup_name,
                    bound.parent,
                    bound.destination_name,
                )
            } else {
                nte::durable_rename(&backup_path, save_path)
            };
            if let Err(restore_err) = restore_result {
                if let (Some(journal), Some(transaction_id)) =
                    (journal.as_deref_mut(), transaction_id)
                {
                    journal.append(
                        transaction_id,
                        nte_wal::WalState::StepReceipt,
                        br#"{"step":"deploy_staging","outcome":"failed_rollback_ambiguous"}"#,
                    )?;
                }
                return Err(format!(
                    "Unable to deploy extracted mod ({err}); rollback also failed ({restore_err})"
                ));
            }
        }
        drop(existing_handle.take());
        let failed_staging = bound.take().map(|bound| (bound.parent, bound.staging));
        if let (Some(journal), Some(transaction_id)) = (journal.as_deref_mut(), transaction_id) {
            journal.append(
                transaction_id,
                nte_wal::WalState::StepReceipt,
                if had_existing {
                    br#"{"step":"deploy_staging","outcome":"rolled_back"}"#
                } else {
                    br#"{"step":"deploy_staging","outcome":"not_applied"}"#
                },
            )?;
            journal.append(transaction_id, nte_wal::WalState::AbortedBefore, b"{}")?;
            let (cleanup_parent, staging_handle) = failed_staging.ok_or_else(|| {
                "NTE library rollback cleanup lost the bound staging handle.".to_string()
            })?;
            cleanup_open_nte_library_artifacts(
                cleanup_parent,
                staging_name,
                Some(staging_handle),
                backup_name,
                None,
            )?;
            journal.append(
                transaction_id,
                nte_wal::WalState::CleanupComplete,
                br#"{"cleanup":"complete"}"#,
            )?;
        }
        return Err(format!("Unable to deploy extracted mod: {err}"));
    }
    if let (Some(journal), Some(transaction_id)) = (journal.as_deref_mut(), transaction_id) {
        journal.append(
            transaction_id,
            nte_wal::WalState::StepReceipt,
            br#"{"step":"deploy_staging","outcome":"applied"}"#,
        )?;
    }
    if let Err(commit_error) = commit_after_filesystem() {
        let deployed = bound.take().ok_or_else(|| {
            format!(
                "Post-deployment commit failed ({commit_error}) without bound rollback handles."
            )
        })?;
        let cleanup_parent = deployed.parent;
        if let Err(rollback_error) = nte::durable_rename_bound_directory(
            &deployed.staging,
            deployed.parent,
            deployed.destination_name,
            deployed.parent,
            staging_name,
        ) {
            return Err(format!(
                "Post-deployment commit failed ({commit_error}); unable to quarantine the after state for rollback ({rollback_error})"
            ));
        }
        if had_existing {
            let previous = existing_handle.as_ref().ok_or_else(|| {
                "Post-deployment rollback lost the bound before-state handle.".to_string()
            })?;
            if let Err(rollback_error) = nte::durable_rename_bound_directory(
                previous,
                deployed.parent,
                backup_name,
                deployed.parent,
                deployed.destination_name,
            ) {
                return Err(format!(
                    "Post-deployment commit failed ({commit_error}); unable to restore the before state ({rollback_error})"
                ));
            }
        }
        drop(existing_handle.take());
        let journal = journal.as_deref_mut().ok_or_else(|| {
            "Post-deployment rollback requires a durable library journal.".to_string()
        })?;
        let transaction_id = transaction_id.ok_or_else(|| {
            "Post-deployment rollback requires a library transaction id.".to_string()
        })?;
        journal.append(
            transaction_id,
            nte_wal::WalState::StepReceipt,
            br#"{"step":"post_filesystem_commit","outcome":"rolled_back"}"#,
        )?;
        journal.append(transaction_id, nte_wal::WalState::AbortedBefore, b"{}")?;
        cleanup_open_nte_library_artifacts(
            cleanup_parent,
            staging_name,
            Some(deployed.staging),
            backup_name,
            None,
        )?;
        journal.append(
            transaction_id,
            nte_wal::WalState::CleanupComplete,
            br#"{"cleanup":"complete"}"#,
        )?;
        return Err(commit_error);
    }
    if let (Some(journal), Some(transaction_id)) = (journal, transaction_id) {
        let deployed = bound.take().ok_or_else(|| {
            "NTE library commit cleanup lost the bound deployment handles.".to_string()
        })?;
        let cleanup_parent = deployed.parent;
        drop(deployed.staging);
        commit_and_cleanup_nte_library_transaction(
            journal,
            transaction_id,
            cleanup_parent,
            staging_name,
            None,
            backup_name,
            existing_handle.take(),
        )?;
    } else if let Err(error) = remove_directory_if_exists(&backup_path) {
        tracing::warn!(
            "Unable to remove committed generic Mod backup '{}': {}",
            backup_path.display(),
            error
        );
    }
    drop(existing_handle.take());
    drop(bound.take());
    Ok(())
}

struct ArchiveDeploymentContext<'a> {
    is_nte_archive: bool,
    trusted_library_root: Option<&'a Path>,
    journal: Option<&'a mut nte_wal::WalJournal>,
    bound_destination: Option<(&'a CapDir, &'a std::ffi::OsStr)>,
    generic_mutation: Option<GenericModMutationContext<'a>>,
}

fn stage_and_deploy_zip_archive(
    file_path: &Path,
    save_path: &Path,
    del: bool,
    required_preview: Option<&PreparedInstallPreview>,
    context: ArchiveDeploymentContext<'_>,
) -> Result<(), String> {
    if context.generic_mutation.is_some()
        && (context.trusted_library_root.is_some()
            || context.journal.is_some()
            || context.bound_destination.is_some())
    {
        return Err("Generic and NTE archive mutation contexts cannot be combined.".to_string());
    }
    let ArchiveDeploymentContext {
        is_nte_archive,
        trusted_library_root,
        journal,
        bound_destination,
        generic_mutation,
    } = context;
    let Some(generic_mutation) = generic_mutation else {
        return stage_and_deploy_zip_archive_inner(
            file_path,
            save_path,
            del,
            required_preview,
            ArchiveDeploymentContext {
                is_nte_archive,
                trusted_library_root,
                journal,
                bound_destination,
                generic_mutation: None,
            },
        );
    };
    let trusted_root = generic_mutation.trusted_root;
    nte::with_bound_nte_library_destination(
        trusted_root,
        save_path,
        move |destination_parent, destination_name| {
            stage_and_deploy_zip_archive_inner(
                file_path,
                save_path,
                del,
                required_preview,
                ArchiveDeploymentContext {
                    is_nte_archive,
                    trusted_library_root: None,
                    journal: None,
                    bound_destination: Some((destination_parent, destination_name)),
                    generic_mutation: Some(generic_mutation),
                },
            )
        },
    )
}

fn populate_archive_staging(
    file_path: &Path,
    save_path: &Path,
    staging_path: &Path,
    del: bool,
    is_nte_archive: bool,
    required_preview: Option<&PreparedInstallPreview>,
) -> Result<(), String> {
    extract_zip_archive(file_path, staging_path)
        .map_err(|err| format!("Extraction failed: {err}"))?;
    if let Some(required_preview) = required_preview {
        normalize_staged_mod_root(staging_path)?;
        install_required_preview(staging_path, required_preview)?;
    }
    if is_nte_archive {
        validate_nte_staged_content(staging_path)?;
    }
    if required_preview.is_none() {
        preserve_existing_preview_files(save_path, staging_path)?;
    }
    if !del && file_path.parent() == Some(save_path) {
        if let Some(archive_name) = file_path.file_name() {
            let staged_archive = staging_path.join(archive_name);
            if !staged_archive.exists() {
                std::fs::copy(file_path, &staged_archive)
                    .map_err(|err| format!("Unable to preserve the source archive: {err}"))?;
            }
        }
    }
    Ok(())
}

struct PreparedBoundArchiveStaging {
    parent: nte::BoundDirectoryChain,
    destination_name: std::ffi::OsString,
    staging_path: PathBuf,
    staging: Option<CapDir>,
}

impl PreparedBoundArchiveStaging {
    fn cleanup(mut self) -> Result<(), String> {
        let Some(staging) = self.staging.take() else {
            return Ok(());
        };
        let staging_name = self
            .staging_path
            .file_name()
            .ok_or_else(|| "Archive staging directory has no name.".to_string())?;
        nte::remove_open_bound_directory_tree(
            staging,
            self.parent.leaf(),
            staging_name,
            "uncommitted archive staging",
        )
    }
}

fn prepare_bound_archive_staging(
    file_path: &Path,
    save_path: &Path,
    del: bool,
    is_nte_archive: bool,
    required_preview: Option<&PreparedInstallPreview>,
    trusted_root: &Path,
) -> Result<PreparedBoundArchiveStaging, String> {
    let (parent, destination_name) = nte::bind_nte_library_destination(trusted_root, save_path)?;
    let staging_path = deployment_sibling_path(save_path, "staging")?;
    let staging = create_bound_staging_directory(parent.leaf(), &staging_path)?;
    let prepared = PreparedBoundArchiveStaging {
        parent,
        destination_name,
        staging_path,
        staging: Some(staging),
    };
    if let Err(error) = populate_archive_staging(
        file_path,
        save_path,
        &prepared.staging_path,
        del,
        is_nte_archive,
        required_preview,
    ) {
        return match prepared.cleanup() {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; unable to clean failed archive staging: {cleanup_error}"
            )),
        };
    }
    Ok(prepared)
}

fn deploy_prepared_generic_archive(
    prepared: &mut PreparedBoundArchiveStaging,
    save_path: &Path,
    context: GenericModMutationContext<'_>,
) -> Result<(), String> {
    let staging = prepared
        .staging
        .take()
        .ok_or_else(|| "Prepared archive staging was already consumed.".to_string())?;
    let bound = BoundNteDeployment {
        parent: prepared.parent.leaf(),
        destination_name: &prepared.destination_name,
        staging,
    };
    deploy_generic_staged_directory(save_path, &prepared.staging_path, bound, context)
}

fn stage_and_deploy_zip_archive_inner(
    file_path: &Path,
    save_path: &Path,
    del: bool,
    required_preview: Option<&PreparedInstallPreview>,
    context: ArchiveDeploymentContext<'_>,
) -> Result<(), String> {
    let ArchiveDeploymentContext {
        is_nte_archive,
        trusted_library_root,
        journal,
        bound_destination,
        generic_mutation,
    } = context;
    let staging_path = deployment_sibling_path(save_path, "staging")?;
    let mut staging_directory = if let Some((parent, _)) = bound_destination {
        Some(create_bound_staging_directory(parent, &staging_path)?)
    } else {
        remove_directory_if_exists(&staging_path)?;
        std::fs::create_dir_all(&staging_path)
            .map_err(|err| format!("Unable to create extraction staging directory: {err}"))?;
        None
    };
    let result = (|| {
        populate_archive_staging(
            file_path,
            save_path,
            &staging_path,
            del,
            is_nte_archive,
            required_preview,
        )?;
        let bound = match (bound_destination, staging_directory.take()) {
            (Some((parent, destination_name)), Some(staging)) => Some(BoundNteDeployment {
                parent,
                destination_name,
                staging,
            }),
            (None, None) => None,
            _ => return Err("Archive staging binding is incomplete.".to_string()),
        };
        match generic_mutation {
            Some(context) => deploy_generic_staged_directory(
                save_path,
                &staging_path,
                bound.ok_or_else(|| {
                    "Generic archive mutation requires bound staging.".to_string()
                })?,
                context,
            ),
            None => deploy_staged_directory(
                save_path,
                &staging_path,
                trusted_library_root,
                journal,
                bound,
            ),
        }
    })();
    if let Err(error) = result {
        let cleanup_result = if let Some((parent, _)) = bound_destination {
            if let Some(name) = staging_path.file_name() {
                cleanup_untransferred_bound_staging(
                    staging_directory.take(),
                    parent,
                    name,
                    "failed archive staging",
                )
            } else {
                Err("Archive staging cleanup path has no name.".to_string())
            }
        } else {
            remove_directory_if_exists(&staging_path)
        };
        return match cleanup_result {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; unable to clean failed archive staging: {cleanup_error}"
            )),
        };
    }
    drop(staging_directory.take());
    Ok(())
}

/// Extract a ZIP archive to the specified path. RAR and 7z are intentionally unsupported.
fn enforce_archive_game_boundary(game: Option<&str>, is_nte_archive: bool) -> Result<(), String> {
    if game == Some("NTE") && !is_nte_archive {
        return Err(
            "NTE archive destination is outside the persisted managed library.".to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod archive_game_boundary_tests {
    use super::enforce_archive_game_boundary;

    #[test]
    fn nte_request_never_falls_back_to_generic_extraction() {
        assert!(enforce_archive_game_boundary(Some("NTE"), false).is_err());
        assert!(enforce_archive_game_boundary(Some("NTE"), true).is_ok());
        assert!(enforce_archive_game_boundary(Some("WW"), false).is_ok());
        assert!(enforce_archive_game_boundary(None, false).is_ok());
    }
}

// These named arguments are the stable renderer IPC contract; bundling them would break callers.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn extract_archive(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, app_state::AppStateRepository>,
    file_path: String,
    save_path: String,
    file_name: String,
    emit: bool,
    key: String,
    current_sid: u64,
    del: bool,
    max_concurrent_extracts: Option<usize>,
    game: Option<String>,
) -> Result<(), String> {
    extract_archive_impl(
        app_handle,
        file_path,
        save_path,
        file_name,
        emit,
        key,
        current_sid,
        del,
        max_concurrent_extracts,
        game,
        None,
        None,
        Some(repository.control_root().to_path_buf()),
    )
    .await
    .map(|_| ())
}

#[allow(clippy::too_many_arguments)]
async fn extract_archive_impl<A: DownloadAppContext>(
    app_handle: A,
    file_path: String,
    save_path: String,
    file_name: String,
    emit: bool,
    key: String,
    current_sid: u64,
    del: bool,
    max_concurrent_extracts: Option<usize>,
    game: Option<String>,
    required_preview: Option<PreparedInstallPreview>,
    install_state: Option<GameBananaDownloadState>,
    mutation_control_root: Option<PathBuf>,
) -> Result<Option<app_state::AppConfigSnapshot>, String> {
    let file_path = Path::new(&file_path);
    let save_path = Path::new(&save_path);
    let file_name = file_name.as_str();

    if file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        != Some("zip".to_string())
    {
        return Err("Only ZIP archives are supported. RAR and 7z files are preserved but cannot be installed.".to_string());
    }

    let _extract_slot =
        acquire_extraction_slot(max_concurrent_extracts.unwrap_or(DEFAULT_MAX_CONCURRENT_EXTRACTS))
            .await;

    let before = Instant::now();
    let config_dir = std::env::current_dir().map_err(|err| err.to_string())?;
    let nte_library_root = nte::persisted_nte_library_root_for_destination(&config_dir, save_path)?;
    let is_nte_archive = nte_library_root.is_some();
    enforce_archive_game_boundary(game.as_deref(), is_nte_archive)?;
    let mut install_state = install_state;
    let mut prepared_install_archive = if let Some(request) = install_state.as_ref() {
        if mutation_control_root.is_none() {
            return Err(
                "Transactional GameBanana download requires the central mutation registry."
                    .to_string(),
            );
        }
        if is_download_cancelled(&key) || SESSION_ID.load(Ordering::SeqCst) != current_sid {
            return Err(format!(
                "Download cancelled before archive preparation (file: {file_name})"
            ));
        }
        let game = game.as_deref().ok_or_else(|| {
            "Transactional GameBanana download requires a game identity.".to_string()
        })?;
        let trusted_root = if is_nte_archive {
            nte_library_root
                .clone()
                .ok_or_else(|| "NTE library root disappeared during archive staging.".to_string())?
        } else {
            persisted_managed_source_root(&config_dir, game)?
        };
        let trusted_destination =
            nte::trusted_nte_library_destination(&trusted_root, &request.relative_path)?;
        if nte::normalized_path_for_comparison(&trusted_destination)
            != nte::normalized_path_for_comparison(save_path)
        {
            return Err("GameBanana download destination is outside its managed root.".to_string());
        }
        Some((
            trusted_root.clone(),
            prepare_bound_archive_staging(
                file_path,
                save_path,
                del,
                is_nte_archive,
                required_preview.as_ref(),
                &trusted_root,
            )?,
        ))
    } else {
        None
    };
    let mut committed_snapshot = None;
    let mut deploy = |registry: Option<&mut nte_wal::WalJournal>| -> Result<(), String> {
        if let Some(request) = install_state.take() {
            if is_download_cancelled(&key) || SESSION_ID.load(Ordering::SeqCst) != current_sid {
                return Err(format!(
                    "Download cancelled before deployment (file: {file_name})"
                ));
            }
            let registry = registry.ok_or_else(|| {
                "Transactional GameBanana download requires the central mutation registry."
                    .to_string()
            })?;
            let game = game.as_deref().ok_or_else(|| {
                "Transactional GameBanana download requires a game identity.".to_string()
            })?;
            let trusted_root = if is_nte_archive {
                nte_library_root.clone().ok_or_else(|| {
                    "NTE library root disappeared during archive staging.".to_string()
                })?
            } else {
                persisted_managed_source_root(&config_dir, game)?
            };
            let (prepared_root, prepared_archive) = prepared_install_archive
                .as_mut()
                .ok_or_else(|| "GameBanana archive staging is missing.".to_string())?;
            if nte::normalized_path_for_comparison(prepared_root)
                != nte::normalized_path_for_comparison(&trusted_root)
            {
                return Err(
                    "The managed Mod root changed while the archive was being prepared."
                        .to_string(),
                );
            }
            let trusted_destination =
                nte::trusted_nte_library_destination(&trusted_root, &request.relative_path)?;
            if nte::normalized_path_for_comparison(&trusted_destination)
                != nte::normalized_path_for_comparison(save_path)
            {
                return Err(
                    "GameBanana download destination changed before deployment.".to_string()
                );
            }
            let prepared = app_handle.prepare_download_state_mutation(game, &request, save_path)?;
            let state_plan = prepared.plan.clone();
            let snapshot_slot = &mut committed_snapshot;
            let commit_app = app_handle.clone();
            let commit_game = game.to_string();
            deploy_prepared_generic_archive(
                prepared_archive,
                save_path,
                GenericModMutationContext {
                    operation: "gamebanana_download",
                    game,
                    trusted_root: &trusted_root,
                    registry,
                    state: Some(GenericStateMutation {
                        plan: state_plan,
                        commit: Box::new(move || {
                            *snapshot_slot = Some(
                                commit_app
                                    .commit_download_state_mutation(&commit_game, prepared)?,
                            );
                            Ok(())
                        }),
                    }),
                },
            )
        } else if is_nte_archive {
            let library_root = nte_library_root.as_deref().ok_or_else(|| {
                "NTE library root disappeared during archive staging.".to_string()
            })?;
            nte::with_nte_library_operation_lock(library_root, Some(&config_dir), |journal| {
                let current_library_root = nte::persisted_nte_library_root(&config_dir)?;
                if nte::normalized_path_for_comparison(&current_library_root)
                    != nte::normalized_path_for_comparison(library_root)
                {
                    return Err(
                        "NTE library configuration changed before archive deployment.".to_string(),
                    );
                }
                recover_nte_library_transaction(library_root, journal)?;
                nte::with_bound_nte_library_destination(
                    library_root,
                    save_path,
                    |destination_parent, destination_name| {
                        stage_and_deploy_zip_archive(
                            file_path,
                            save_path,
                            del,
                            required_preview.as_ref(),
                            ArchiveDeploymentContext {
                                is_nte_archive: true,
                                trusted_library_root: Some(library_root),
                                journal: Some(journal),
                                bound_destination: Some((destination_parent, destination_name)),
                                generic_mutation: None,
                            },
                        )
                    },
                )
            })
        } else if let Some(registry) = registry {
            let game = game.as_deref().ok_or_else(|| {
                "A generic archive mutation requires a game identity.".to_string()
            })?;
            let trusted_root = persisted_managed_source_root(&config_dir, game)?;
            stage_and_deploy_zip_archive(
                file_path,
                save_path,
                del,
                required_preview.as_ref(),
                ArchiveDeploymentContext {
                    is_nte_archive: false,
                    trusted_library_root: None,
                    journal: None,
                    bound_destination: None,
                    generic_mutation: Some(GenericModMutationContext {
                        operation: "archive_install",
                        game,
                        trusted_root: &trusted_root,
                        registry,
                        state: None,
                    }),
                },
            )
        } else {
            stage_and_deploy_zip_archive(
                file_path,
                save_path,
                del,
                required_preview.as_ref(),
                ArchiveDeploymentContext {
                    is_nte_archive: false,
                    trusted_library_root: None,
                    journal: None,
                    bound_destination: None,
                    generic_mutation: None,
                },
            )
        }
    };
    let deploy_result = if let Some(control_root) = mutation_control_root {
        mod_mutation::with_global_lock(&control_root, |registry| {
            recover_generic_mod_mutation_registry(&config_dir, registry)?;
            deploy(Some(registry))
        })
    } else {
        let _mutation_guard = MOD_MUTATION_PROCESS_LOCK
            .lock()
            .map_err(|_| "Mod mutation process lock is poisoned.".to_string())?;
        deploy(None)
    };
    if let Err(error) = deploy_result {
        let cleanup = prepared_install_archive
            .take()
            .map(|(_, prepared)| prepared.cleanup())
            .unwrap_or(Ok(()));
        return match cleanup {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; unable to clean uncommitted archive staging: {cleanup_error}"
            )),
        };
    }
    let duration = before.elapsed();
    tracing::info!("Staged extraction deployed in {:.2?}", duration);

    if !del {
        app_handle.emit_event("fin", serde_json::json!({ "key": key, "type": "manual" }))?;
        return Ok(None);
    }
    if emit {
        decrement_download_count(&key);
        tracing::info!(
            "Emitting completion event for session {}: {}",
            current_sid,
            file_name
        );
        let _ = app_handle.emit_event("fin", serde_json::json!({ "key": key , "type": "auto" }));
    }
    Ok(committed_snapshot)
}
// These named arguments are the stable renderer IPC contract; bundling them would break callers.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn download_and_unzip(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, app_state::AppStateRepository>,
    file_name: String,
    download_url: String,
    save_path: String,
    key: String,
    emit: bool,
    download_options: Option<DownloadOptions>,
    game: Option<String>,
    preview_url: Option<String>,
    expected_size: Option<u64>,
    expected_hash: Option<ExpectedDownloadHash>,
    install_state: GameBananaDownloadState,
) -> Result<app_state::AppConfigSnapshot, String> {
    download_and_unzip_impl(
        app_handle,
        file_name,
        download_url,
        save_path,
        key,
        emit,
        download_options,
        game,
        preview_url,
        expected_size,
        expected_hash,
        Some(install_state),
        Some(repository.control_root().to_path_buf()),
    )
    .await?
    .ok_or_else(|| "GameBanana download completed without a committed state snapshot.".to_string())
}

async fn send_download_request(
    request: reqwest::RequestBuilder,
    response_timeout: Duration,
) -> Result<reqwest::Response, String> {
    match timeout(response_timeout, request.send()).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err(format!(
            "No response headers received within {:.1} seconds",
            response_timeout.as_secs_f64()
        )),
    }
}

#[cfg(test)]
mod download_request_timeout_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn response_headers_are_bounded_per_attempt() {
        ensure_rustls_crypto_provider();
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.expect("accepted connection");
            sleep(Duration::from_millis(500)).await;
        });
        let client = Client::builder().build().expect("client");

        let result = timeout(
            Duration::from_secs(1),
            send_download_request(
                client.get(format!("http://{address}/slow-headers")),
                Duration::from_millis(50),
            ),
        )
        .await
        .expect("header timeout must be bounded")
        .expect_err("missing response headers must fail");

        assert!(result.contains("No response headers received"));
        server.abort();
    }

    #[tokio::test]
    async fn response_header_timeout_does_not_limit_the_body() {
        ensure_rustls_crypto_provider();
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accepted connection");
            let mut request = [0_u8; 1024];
            let request_bytes = stream.read(&mut request).await.expect("request bytes");
            assert!(request_bytes > 0, "non-empty request");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n")
                .await
                .expect("response headers");
            sleep(Duration::from_millis(500)).await;
            stream.write_all(b"x").await.expect("response body");
        });
        let client = Client::builder().build().expect("client");

        let response = send_download_request(
            client.get(format!("http://{address}/slow-body")),
            Duration::from_millis(250),
        )
        .await
        .expect("prompt response headers");
        let body = timeout(Duration::from_secs(2), response.bytes())
            .await
            .expect("body read timeout")
            .expect("body bytes");

        assert_eq!(&body[..], b"x");
        server.await.expect("server task");
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_and_unzip_impl<A: DownloadAppContext>(
    app_handle: A,
    file_name: String,
    download_url: String,
    save_path: String,
    key: String,
    emit: bool,
    download_options: Option<DownloadOptions>,
    game: Option<String>,
    preview_url: Option<String>,
    expected_size: Option<u64>,
    expected_hash: Option<ExpectedDownloadHash>,
    install_state: Option<GameBananaDownloadState>,
    mutation_control_root: Option<PathBuf>,
) -> Result<Option<app_state::AppConfigSnapshot>, String> {
    validate_download_file_name(&file_name)?;
    let mut install_state = install_state;
    let (validated_url, url_class) = classify_download_url(&download_url, !emit)?;
    let download_url = validated_url.to_string();
    let expected_md5 = if url_class == DownloadUrlClass::GameBananaFile {
        Some(validate_required_gamebanana_integrity(
            expected_size,
            expected_hash.as_ref(),
        )?)
    } else {
        normalized_expected_md5(expected_hash.as_ref())?
    };
    if let Some(request) = install_state.as_ref() {
        validate_gamebanana_completed_download(
            &request.completed_download,
            &request.source,
            expected_size,
            expected_hash.as_ref(),
        )?;
    }
    let mut requested_save_path = PathBuf::from(&save_path);
    let config_dir = std::env::current_dir().map_err(|err| err.to_string())?;
    let nte_library_root = if game.as_deref() == Some("NTE") {
        if let Some(request) = install_state.as_ref() {
            let library_root = nte::persisted_nte_library_root(&config_dir)?;
            let expected_destination =
                nte::trusted_nte_library_destination(&library_root, &request.relative_path)?;
            if nte::normalized_path_for_comparison(&expected_destination)
                != nte::normalized_path_for_comparison(&requested_save_path)
            {
                return Err(
                    "NTE download destination does not match its persisted relative path."
                        .to_string(),
                );
            }
            let control_root = mutation_control_root.as_deref().ok_or_else(|| {
                "Transactional NTE download has no global mutation coordinator.".to_string()
            })?;
            mod_mutation::with_global_lock(control_root, |registry| {
                recover_generic_mod_mutation_registry(&config_dir, registry)?;
                let current_library_root = nte::persisted_nte_library_root(&config_dir)?;
                if nte::normalized_path_for_comparison(&current_library_root)
                    != nte::normalized_path_for_comparison(&library_root)
                {
                    return Err(
                        "NTE library configuration changed before download preparation."
                            .to_string(),
                    );
                }
                mod_mutation::with_library_lock(&current_library_root, |_journal| {
                    let current_destination = nte::ensure_nte_library_destination_parent(
                        &current_library_root,
                        &request.relative_path,
                    )?;
                    if nte::normalized_path_for_comparison(&current_destination)
                        != nte::normalized_path_for_comparison(&requested_save_path)
                    {
                        return Err(
                            "NTE download destination changed while preparing its category."
                                .to_string(),
                        );
                    }
                    Ok(())
                })
            })?;
        }
        let library_root =
            nte::persisted_nte_library_root_for_destination(&config_dir, &requested_save_path)?
                .ok_or_else(|| {
                    "NTE download destination is outside the persisted managed library.".to_string()
                })?;
        requested_save_path =
            nte::canonical_nte_library_destination(&library_root, &requested_save_path)?;
        Some(library_root)
    } else {
        None
    };
    let mut nte_download_staging = if emit || nte_library_root.is_some() {
        Some(nte_download_staging_directory(
            &app_handle,
            &key,
            &requested_save_path,
        )?)
    } else {
        None
    };

    if emit {
        let mut counts = DOWNLOAD_COUNTS.lock().unwrap();
        *counts.entry(key.clone()).or_insert(0) += 1;
        tracing::debug!(
            "Download count for key '{}': {}",
            key,
            counts.get(&key).unwrap()
        );
    }

    clear_cancelled_download(&key);
    let options = download_options.unwrap_or_default();
    let _preview_slot = if !emit {
        Some(acquire_preview_slot().await)
    } else {
        None
    };
    if !emit && options.wait_for_primary_idle.unwrap_or(true) {
        wait_for_primary_downloads_to_idle(Duration::from_secs(PREVIEW_IDLE_WAIT_TIMEOUT_SECS))
            .await;
    }

    let current_sid = SESSION_ID.load(Ordering::SeqCst);

    let connect_timeout = Duration::from_secs(
        options
            .connect_timeout_sec
            .unwrap_or(DEFAULT_CONNECT_TIMEOUT_SECS)
            .max(1),
    );
    let stall_timeout = Duration::from_secs(
        options
            .stall_timeout_sec
            .unwrap_or(DEFAULT_STALL_TIMEOUT_SECS)
            .max(1),
    );
    let retries = if emit {
        options
            .request_retries
            .unwrap_or(DEFAULT_REQUEST_RETRIES)
            .max(1)
    } else {
        options
            .request_retries
            .unwrap_or(DEFAULT_REQUEST_RETRIES)
            .clamp(1, 2)
    };
    let progress_interval = Duration::from_millis(
        options
            .progress_interval_ms
            .unwrap_or(DEFAULT_PROGRESS_INTERVAL_MS)
            .max(100),
    );
    let progress_threshold = options
        .progress_bytes_threshold
        .unwrap_or(PROGRESS_UPDATE_THRESHOLD)
        .max(PROGRESS_UPDATE_THRESHOLD);
    let backoff_base_ms = options
        .backoff_base_ms
        .unwrap_or(DEFAULT_BACKOFF_BASE_MS)
        .max(100);
    let max_extracts = options
        .max_concurrent_extracts
        .unwrap_or(DEFAULT_MAX_CONCURRENT_EXTRACTS)
        .max(1);

    let compute_backoff_ms = |attempt: u32, rate_limited: bool| -> u64 {
        let exp = 2u64.pow((attempt - 1).min(8));
        let mut backoff = backoff_base_ms.saturating_mul(exp);
        if rate_limited {
            backoff = backoff.saturating_mul(3);
        }
        backoff.min(60_000)
    };

    let mut last_error = "Unknown download error".to_string();
    let mut last_error_stage = "download".to_string();
    let mut final_attempt = 1u32;
    let save_dir_path = nte_download_staging
        .as_ref()
        .map(|staging| staging.path.clone())
        .unwrap_or_else(|| requested_save_path.clone());
    if let Err(e) = std::fs::create_dir_all(&save_dir_path) {
        last_error = format!("Failed to create download directory '{}': {}", save_path, e);
        last_error_stage = "filesystem".to_string();
    }
    let temp_file_path = save_dir_path.join(format!("{}.part", file_name));
    let resume_meta_path = resume_metadata_path(&temp_file_path);

    for attempt in 1..=retries {
        if last_error_stage == "filesystem" {
            break;
        }
        final_attempt = attempt;
        tracing::info!(
            "Starting download attempt {}/{} for key {}",
            attempt,
            retries,
            key
        );

        if let Err(e) = std::fs::create_dir_all(&save_dir_path) {
            last_error = format!(
                "Failed to ensure download directory '{}' exists: {}",
                save_path, e
            );
            last_error_stage = "filesystem".to_string();
            break;
        }

        let client = match Client::builder()
            .connect_timeout(connect_timeout)
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("too many redirects");
                }
                if redirect_allowed(attempt.url(), url_class) {
                    attempt.follow()
                } else {
                    attempt.error("download redirect left the allowed network boundary")
                }
            }))
            .build()
        {
            Ok(client) => client,
            Err(e) => {
                last_error = format!("Failed to initialize HTTP client: {}", e);
                last_error_stage = "download".to_string();
                if attempt < retries {
                    let backoff = compute_backoff_ms(attempt, false);
                    sleep(Duration::from_millis(backoff)).await;
                    continue;
                }
                break;
            }
        };

        let mut resume_from = std::fs::metadata(&temp_file_path)
            .map(|m| m.len())
            .unwrap_or(0);
        let resume_metadata = if resume_from > 0 {
            read_resume_metadata(&resume_meta_path).filter(|metadata| {
                metadata.source_url == download_url
                    && metadata.etag.as_deref().is_some_and(is_strong_etag)
            })
        } else {
            None
        };
        if resume_from > 0 && resume_metadata.is_none() {
            tracing::info!("Discarding unvalidated partial download for key {}", key);
            let _ = remove_file(&temp_file_path);
            let _ = remove_file(&resume_meta_path);
            resume_from = 0;
        }

        // GameBanana's `/dl/` redirect chain serves an empty stream to the
        // default reqwest client identity. Keep the request recognizable as
        // IMM and send a browser-like accept header for the CDN hop.
        let mut request = client
            .get(validated_url.clone())
            .header(USER_AGENT, DOWNLOAD_USER_AGENT)
            .header(ACCEPT, "*/*");
        if url_class == DownloadUrlClass::GameBananaFile {
            request = request.header(REFERER, "https://gamebanana.com/");
        }
        let requested_range_start = request_range_start(url_class, resume_from);
        if let Some(range_start) = requested_range_start {
            request = request.header(RANGE, format!("bytes={range_start}-"));
            if let Some(metadata) = &resume_metadata {
                if let Some(etag) = &metadata.etag {
                    request = request.header(IF_RANGE, etag);
                }
            }
        }

        let response = match send_download_request(request, stall_timeout).await {
            Ok(response) => response,
            Err(error) => {
                last_error = error;
                if attempt < retries {
                    let backoff = compute_backoff_ms(attempt, false);
                    sleep(Duration::from_millis(backoff)).await;
                    continue;
                }
                break;
            }
        };

        let status = response.status();
        if status == StatusCode::RANGE_NOT_SATISFIABLE && resume_from > 0 {
            tracing::warn!(
                "Range request not satisfiable for key {}, resetting partial file",
                key
            );
            let _ = remove_file(&temp_file_path);
            let _ = remove_file(&resume_meta_path);
            if attempt < retries {
                sleep(Duration::from_millis(compute_backoff_ms(attempt, true))).await;
                continue;
            }
            last_error = "Resume offset rejected by server".to_string();
            break;
        }

        if !status.is_success() {
            last_error = format!("HTTP {}", status);
            let rate_limited = matches!(
                status,
                StatusCode::TOO_MANY_REQUESTS
                    | StatusCode::SERVICE_UNAVAILABLE
                    | StatusCode::BAD_GATEWAY
                    | StatusCode::GATEWAY_TIMEOUT
            );
            if attempt < retries {
                let backoff = compute_backoff_ms(attempt, rate_limited);
                sleep(Duration::from_millis(backoff)).await;
                continue;
            }
            break;
        }

        if let Some(length) = response.content_length() {
            let expected = if status == StatusCode::PARTIAL_CONTENT {
                length.saturating_add(resume_from)
            } else {
                length
            };
            if expected > DOWNLOAD_MAX_BYTES {
                last_error = "Download exceeds the 16 GiB safety limit".to_string();
                last_error_stage = "download".to_string();
                break;
            }
        }

        if status == StatusCode::PARTIAL_CONTENT {
            if let Some(requested_range_start) = requested_range_start {
                let range_start = response
                    .headers()
                    .get(CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(parse_content_range_start);
                let range_total = response
                    .headers()
                    .get(CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(parse_total_from_content_range);
                let validators_mismatch = if resume_from > 0 {
                    let etag_changed = resume_metadata
                        .as_ref()
                        .and_then(|metadata| metadata.etag.as_deref())
                        .is_some_and(|expected| {
                            response
                                .headers()
                                .get(ETAG)
                                .and_then(|value| value.to_str().ok())
                                != Some(expected)
                        });
                    let modified_changed = resume_metadata
                        .as_ref()
                        .and_then(|metadata| metadata.last_modified.as_deref())
                        .is_some_and(|expected| {
                            response
                                .headers()
                                .get(LAST_MODIFIED)
                                .and_then(|value| value.to_str().ok())
                                != Some(expected)
                        });
                    let total_changed = resume_metadata
                        .as_ref()
                        .and_then(|metadata| metadata.total_size)
                        .is_some_and(|expected| range_total != Some(expected));
                    etag_changed || modified_changed || total_changed
                } else {
                    false
                };
                if range_start != Some(requested_range_start) || validators_mismatch {
                    tracing::warn!(
                        "Rejecting stale or mismatched partial response for key {}",
                        key
                    );
                    let _ = remove_file(&temp_file_path);
                    let _ = remove_file(&resume_meta_path);
                    if attempt < retries {
                        sleep(Duration::from_millis(compute_backoff_ms(attempt, true))).await;
                        continue;
                    }
                    last_error =
                        "Partial response did not match the saved download validator".to_string();
                    break;
                }
            }
        }

        let ext = response
            .url()
            .path_segments()
            .and_then(|mut segments| segments.next_back())
            .and_then(|name| std::path::Path::new(name).extension())
            .and_then(|ext| ext.to_str())
            .or_else(|| {
                response
                    .headers()
                    .get("content-type")
                    .and_then(|ct| ct.to_str().ok())
                    .and_then(|ct| mime_to_extension(ct))
            })
            .unwrap_or("")
            .to_owned();

        let resolved_name_candidate = if !ext.is_empty() {
            format!("{}.{}", file_name, ext)
        } else {
            file_name.clone()
        };
        let resolved_file_name = resolved_name_candidate;

        let final_file_path = save_dir_path.join(&resolved_file_name);
        let mut effective_resume_from = resume_from;
        let supports_resume =
            response.status() == StatusCode::PARTIAL_CONTENT && effective_resume_from > 0;
        if effective_resume_from > 0 && !supports_resume {
            tracing::warn!(
                "Server ignored range resume for key {}, restarting from 0",
                key
            );
            effective_resume_from = 0;
            let _ = remove_file(&temp_file_path);
        }

        let total_from_content_range = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_total_from_content_range);
        let total_size = total_from_content_range.unwrap_or_else(|| {
            let base = response.content_length().unwrap_or(0);
            if supports_resume {
                base.saturating_add(effective_resume_from)
            } else {
                base
            }
        });
        if total_size > DOWNLOAD_MAX_BYTES {
            last_error = "Download exceeds the 16 GiB safety limit".to_string();
            last_error_stage = "download".to_string();
            break;
        }
        if expected_size.is_some_and(|expected| total_size > 0 && total_size != expected) {
            last_error = format!(
                "Download size mismatch (expected {}, server reported {})",
                expected_size.unwrap_or_default(),
                total_size
            );
            last_error_stage = "download".to_string();
            break;
        }

        let resume_metadata_value = DownloadResumeMetadata {
            source_url: download_url.clone(),
            response_url: response.url().to_string(),
            etag: response
                .headers()
                .get(ETAG)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            last_modified: response
                .headers()
                .get(LAST_MODIFIED)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            total_size: (total_size > 0).then_some(total_size),
        };
        if let Err(error) = write_resume_metadata(&resume_meta_path, &resume_metadata_value) {
            last_error = error;
            last_error_stage = "filesystem".to_string();
            break;
        }

        let file = match if supports_resume && effective_resume_from > 0 {
            OpenOptions::new().append(true).open(&temp_file_path)
        } else {
            OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&temp_file_path)
        } {
            Ok(file) => file,
            Err(e) => {
                last_error = format!(
                    "Failed to open temporary file '{}': {}",
                    temp_file_path.to_string_lossy(),
                    e
                );
                last_error_stage = "filesystem".to_string();
                break;
            }
        };
        let mut writer = BufWriter::with_capacity(BUFFER_SIZE, file);
        let mut stream = response.bytes_stream();
        let mut downloaded: u64 = effective_resume_from;
        let mut last_progress_update: u64 = 0;
        let mut last_emit_at = Instant::now();
        let start_time = Instant::now();
        let mut speed_window_start = Instant::now();
        let mut speed_window_bytes: u64 = 0;
        let mut rolling_speed_bps = 0.0f64;
        let mut emit_window_start = Instant::now();
        let mut emit_window_bytes: u64 = 0;
        let mut attempt_error: Option<String> = None;
        let mut attempt_error_stage = "download".to_string();

        loop {
            if is_download_cancelled(&key) {
                attempt_error = Some(format!(
                    "Download cancelled by user (file: {})",
                    resolved_file_name
                ));
                break;
            }

            let global_sid = SESSION_ID.load(Ordering::SeqCst);
            if global_sid != current_sid {
                attempt_error = Some(format!(
                    "Download cancelled due to session change (file: {})",
                    resolved_file_name
                ));
                break;
            }

            let stream_item = match timeout(stall_timeout, stream.next()).await {
                Ok(item) => item,
                Err(_) => {
                    attempt_error = Some(format!(
                        "No download progress for {} seconds (file: {})",
                        stall_timeout.as_secs(),
                        resolved_file_name
                    ));
                    break;
                }
            };

            let Some(item) = stream_item else {
                break;
            };

            let chunk = match item {
                Ok(chunk) => chunk,
                Err(e) => {
                    attempt_error = Some(e.to_string());
                    attempt_error_stage = "download".to_string();
                    break;
                }
            };

            if let Err(e) = writer.write_all(&chunk) {
                attempt_error = Some(format!(
                    "Failed writing to temporary file '{}': {}",
                    temp_file_path.to_string_lossy(),
                    e
                ));
                attempt_error_stage = "filesystem".to_string();
                break;
            }
            downloaded += chunk.len() as u64;
            if downloaded > DOWNLOAD_MAX_BYTES {
                attempt_error = Some("Download exceeds the 16 GiB safety limit".to_string());
                attempt_error_stage = "download".to_string();
                break;
            }
            speed_window_bytes = speed_window_bytes.saturating_add(chunk.len() as u64);
            emit_window_bytes = emit_window_bytes.saturating_add(chunk.len() as u64);

            if speed_window_start.elapsed() >= Duration::from_secs(1) {
                let secs = speed_window_start.elapsed().as_secs_f64();
                rolling_speed_bps = if secs > 0.0 {
                    speed_window_bytes as f64 / secs
                } else {
                    rolling_speed_bps
                };
                speed_window_start = Instant::now();
                speed_window_bytes = 0;
            }

            if emit
                && (downloaded.saturating_sub(last_progress_update) >= progress_threshold
                    || last_emit_at.elapsed() >= progress_interval
                    || (total_size > 0 && downloaded >= total_size))
            {
                let emit_elapsed = emit_window_start.elapsed().as_secs_f64();
                let short_window_speed = if emit_elapsed > 0.0 {
                    emit_window_bytes as f64 / emit_elapsed
                } else {
                    0.0
                };
                let speed_for_display = if short_window_speed > 0.0 {
                    short_window_speed
                } else {
                    rolling_speed_bps
                };
                let total_elapsed = start_time.elapsed().as_secs_f64();
                let avg_speed = if total_elapsed > 0.0 {
                    downloaded as f64 / total_elapsed
                } else {
                    0.0
                };
                let speed_for_eta = if speed_for_display > 0.0 {
                    speed_for_display
                } else {
                    avg_speed
                };
                let remaining_bytes = total_size.saturating_sub(downloaded);
                let eta_secs = if speed_for_eta > 0.0 {
                    (remaining_bytes as f64 / speed_for_eta) as u64
                } else {
                    0
                };
                let progress_data = DownloadProgress {
                    downloaded: downloaded as f64,
                    total: total_size as f64,
                    speed: format_speed(speed_for_display.max(0.0)),
                    eta: format_duration(eta_secs),
                    key: key.clone(),
                };
                let _ = app_handle.emit_event("download-progress", progress_data);
                last_progress_update = downloaded;
                last_emit_at = Instant::now();
                emit_window_start = Instant::now();
                emit_window_bytes = 0;
            }
        }

        if let Some(err) = attempt_error {
            last_error = err;
            last_error_stage = attempt_error_stage;
            drop(writer);

            if is_download_cancelled(&key) {
                let _ = remove_file(&temp_file_path);
                let _ = remove_file(&resume_meta_path);
                break;
            }
            if last_error.contains("session change") {
                let _ = remove_file(&temp_file_path);
                let _ = remove_file(&resume_meta_path);
                break;
            }

            if attempt < retries && last_error_stage == "download" {
                let backoff = compute_backoff_ms(attempt, false);
                sleep(Duration::from_millis(backoff)).await;
                continue;
            }
            break;
        }

        if let Err(e) = writer.flush() {
            last_error = format!(
                "Failed flushing temporary file '{}': {}",
                temp_file_path.to_string_lossy(),
                e
            );
            last_error_stage = "filesystem".to_string();
            drop(writer);
            break;
        }
        drop(writer);

        if let Some(expected) = expected_size {
            match std::fs::metadata(&temp_file_path) {
                Ok(metadata) if metadata.len() == expected => {}
                Ok(metadata) => {
                    last_error = format!(
                        "Downloaded file size mismatch (expected {}, got {})",
                        expected,
                        metadata.len()
                    );
                    last_error_stage = "download".to_string();
                    let _ = remove_file(&temp_file_path);
                    let _ = remove_file(&resume_meta_path);
                    break;
                }
                Err(err) => {
                    last_error = format!("Unable to inspect completed download: {err}");
                    last_error_stage = "filesystem".to_string();
                    break;
                }
            }
        }
        if let Some(expected) = &expected_md5 {
            if let Err(err) = verify_download_md5(&temp_file_path, expected) {
                last_error = err;
                last_error_stage = "download".to_string();
                let _ = remove_file(&temp_file_path);
                let _ = remove_file(&resume_meta_path);
                break;
            }
        }

        let total_elapsed = start_time.elapsed().as_secs_f64();
        let avg_speed = if total_elapsed > 0.0 {
            downloaded as f64 / total_elapsed
        } else {
            0.0
        };

        if final_file_path.exists() {
            let _ = remove_file(&final_file_path);
        }
        if let Err(e) = std::fs::rename(&temp_file_path, &final_file_path) {
            last_error = format!(
                "Failed to finalize download from '{}' to '{}': {}",
                temp_file_path.to_string_lossy(),
                final_file_path.to_string_lossy(),
                e
            );
            last_error_stage = "filesystem".to_string();
            break;
        }
        let _ = remove_file(&resume_meta_path);

        tracing::info!(
            "Download completed for '{}': {} in {:.2}s (Avg Speed: {})",
            resolved_file_name,
            format_bytes(downloaded),
            total_elapsed,
            format_speed(avg_speed)
        );

        if !emit {
            if let Some(library_root) = nte_library_root.as_deref() {
                let preview_result = deploy_downloaded_nte_preview(
                    &config_dir,
                    library_root,
                    &requested_save_path,
                    &final_file_path,
                );
                if let Some(staging) = nte_download_staging.take() {
                    let _ = staging.cleanup();
                }
                preview_result?;
            }
            clear_cancelled_download(&key);
            return Ok(None);
        }

        if emit {
            let final_total = if total_size > 0 {
                total_size
            } else {
                downloaded
            };
            let _ = app_handle.emit_event(
                "ext",
                DownloadProgress {
                    downloaded: final_total as f64,
                    total: final_total as f64,
                    speed: format_speed(avg_speed),
                    eta: "0s".to_string(),
                    key: key.clone(),
                },
            );
        }

        let required_preview = if emit {
            Some(prepare_install_preview(&app_handle, preview_url.as_deref(), &key).await)
        } else {
            None
        };
        if is_download_cancelled(&key) {
            if let Some(staging) = nte_download_staging.take() {
                let _ = staging.cleanup();
            }
            decrement_download_count(&key);
            clear_cancelled_download(&key);
            return Err(format!(
                "Download cancelled by user (file: {resolved_file_name})"
            ));
        }

        let extraction_snapshot = match extract_archive_impl(
            app_handle.clone(),
            final_file_path.to_string_lossy().to_string(),
            save_path.clone(),
            resolved_file_name.clone(),
            emit,
            key.clone(),
            current_sid,
            true,
            Some(max_extracts),
            game.clone(),
            required_preview,
            install_state.take(),
            mutation_control_root.clone(),
        )
        .await
        {
            Ok(snapshot) => snapshot,
            Err(e) => {
                last_error = e;
                if let Some(staging) = nte_download_staging.take() {
                    let _ = staging.cleanup();
                }
                if emit {
                    let _ = app_handle.emit_event(
                        "download-error",
                        DownloadErrorEvent {
                            key: key.clone(),
                            message: last_error.clone(),
                            stage: if last_error.to_ascii_lowercase().contains("preview") {
                                "preview"
                            } else {
                                "extract"
                            }
                            .to_string(),
                            attempt,
                            max_attempts: retries,
                        },
                    );
                }
                decrement_download_count(&key);
                clear_cancelled_download(&key);
                return Err(last_error);
            }
        };

        let cleanup_result = nte_download_staging
            .take()
            .map(BoundNteDownloadStaging::cleanup)
            .unwrap_or(Ok(()));
        let cleanup_result = resolve_post_install_staging_cleanup(
            &key,
            extraction_snapshot.is_some(),
            cleanup_result,
        );
        clear_cancelled_download(&key);
        cleanup_result?;
        return Ok(extraction_snapshot);
    }

    if emit {
        let _ = app_handle.emit_event(
            "download-error",
            DownloadErrorEvent {
                key: key.clone(),
                message: last_error.clone(),
                stage: last_error_stage,
                attempt: final_attempt,
                max_attempts: retries,
            },
        );
    }
    if !emit {
        let _ = remove_file(&temp_file_path);
    }
    if let Some(staging) = nte_download_staging.take() {
        let _ = staging.cleanup();
    }
    let _ = remove_file(&resume_meta_path);
    decrement_download_count(&key);
    clear_cancelled_download(&key);
    Err(last_error)
}

fn resolve_post_install_staging_cleanup(
    key: &str,
    committed_snapshot_exists: bool,
    cleanup_result: Result<(), String>,
) -> Result<(), String> {
    match cleanup_result {
        Ok(()) => Ok(()),
        Err(error) if committed_snapshot_exists => {
            tracing::warn!(
                "Download '{}' was committed, but hidden staging cleanup failed: {}",
                key,
                error
            );
            Ok(())
        }
        Err(error) => Err(format!(
            "Archive deployment completed, but hidden download staging cleanup failed: {error}"
        )),
    }
}

#[cfg(test)]
mod post_install_staging_cleanup_tests {
    use super::resolve_post_install_staging_cleanup;

    #[test]
    fn committed_download_is_not_reported_as_failed_when_cleanup_fails() {
        assert!(resolve_post_install_staging_cleanup(
            "committed-download",
            true,
            Err("sharing violation".to_string()),
        )
        .is_ok());
    }

    #[test]
    fn cleanup_failure_without_a_committed_snapshot_remains_visible() {
        let error = resolve_post_install_staging_cleanup(
            "uncommitted-download",
            false,
            Err("sharing violation".to_string()),
        )
        .expect_err("cleanup failure must remain visible before state commit");

        assert!(error.contains("hidden download staging cleanup failed"));
        assert!(error.contains("sharing violation"));
    }
}

#[cfg(test)]
mod live_gamebanana_download_tests {
    use super::*;
    use std::fs;
    use std::time::Instant;
    use tempfile::tempdir;

    struct CurrentDirGuard(PathBuf);

    #[derive(Clone)]
    struct TestDownloadApp {
        app_local_data: PathBuf,
    }

    impl DownloadAppContext for TestDownloadApp {
        fn app_local_data_dir(&self) -> Result<PathBuf, String> {
            Ok(self.app_local_data.clone())
        }

        fn emit_event<S: Serialize + Clone>(
            &self,
            _event: &str,
            _payload: S,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    impl Drop for CurrentDirGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.0);
        }
    }

    fn count_nte_payloads(root: &Path) -> usize {
        let Ok(entries) = fs::read_dir(root) else {
            return 0;
        };
        entries
            .filter_map(Result::ok)
            .map(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    count_nte_payloads(&path)
                } else if path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        matches!(
                            extension.to_ascii_lowercase().as_str(),
                            "pak" | "utoc" | "ucas"
                        )
                    })
                {
                    1
                } else {
                    0
                }
            })
            .sum()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "live GameBanana smoke test; provide IMM_LIVE_NTE_* environment variables"]
    async fn live_nte_zip_uses_download_hash_extract_and_library_wal_path() {
        ensure_rustls_crypto_provider();
        let url = std::env::var("IMM_LIVE_NTE_URL").expect("IMM_LIVE_NTE_URL");
        let file_name = std::env::var("IMM_LIVE_NTE_FILE").expect("IMM_LIVE_NTE_FILE");
        let expected_size = std::env::var("IMM_LIVE_NTE_SIZE")
            .expect("IMM_LIVE_NTE_SIZE")
            .parse::<u64>()
            .expect("numeric IMM_LIVE_NTE_SIZE");
        let md5 = std::env::var("IMM_LIVE_NTE_MD5").expect("IMM_LIVE_NTE_MD5");
        let preview_url = std::env::var("IMM_LIVE_NTE_PREVIEW_URL").ok();

        let temp = tempdir().expect("tempdir");
        let runtime_dir = temp.path().join("runtime");
        let source_root = temp.path().join("source");
        let target_root = temp.path().join("target");
        let managed_root = source_root.join(MANAGED_SOURCE_DIR);
        let destination = managed_root.join("LiveSmoke").join("GameBananaDownload");
        fs::create_dir_all(&runtime_dir).expect("runtime");
        fs::create_dir_all(managed_root.join("LiveSmoke")).expect("managed library");
        fs::create_dir_all(&target_root).expect("target");
        fs::write(
            runtime_dir.join("configNTE.json"),
            serde_json::to_vec(&serde_json::json!({
                "game": "NTE",
                "sourceDir": source_root,
                "targetDir": target_root,
                "nteRegion": "global",
                "updatedAt": "live-download-smoke"
            }))
            .expect("config JSON"),
        )
        .expect("write config");

        let original_dir = std::env::current_dir().expect("current dir");
        let _guard = CurrentDirGuard(original_dir);
        std::env::set_current_dir(&runtime_dir).expect("set runtime dir");
        let app = TestDownloadApp {
            app_local_data: temp.path().join("app-local"),
        };
        let started = Instant::now();

        download_and_unzip_impl(
            app,
            file_name,
            url,
            destination.to_string_lossy().into_owned(),
            "live-nte-gamebanana-smoke".to_string(),
            true,
            Some(DownloadOptions {
                connect_timeout_sec: Some(20),
                stall_timeout_sec: Some(60),
                request_retries: Some(2),
                progress_interval_ms: Some(1000),
                progress_bytes_threshold: Some(1024 * 1024),
                backoff_base_ms: Some(500),
                max_concurrent_extracts: Some(1),
                wait_for_primary_idle: Some(false),
            }),
            Some("NTE".to_string()),
            preview_url,
            Some(expected_size),
            Some(ExpectedDownloadHash {
                algorithm: "md5".to_string(),
                value: md5.clone(),
            }),
            None,
            None,
        )
        .await
        .expect("live NTE download and extraction");

        let payload_count = count_nte_payloads(&destination);
        assert!(payload_count > 0, "deployed NTE payloads");
        let preview_path = destination.join("preview.jpg");
        let preview_bytes = fs::read(&preview_path).expect("deployed preview.jpg");
        assert!(!preview_bytes.is_empty(), "non-empty preview.jpg");
        let preview = image::load_from_memory(&preview_bytes).expect("decodable preview.jpg");
        assert!(
            preview.width() > 0 && preview.height() > 0,
            "non-zero preview dimensions"
        );
        let wal_path = managed_root.join(".imm-nte-library.wal");
        let wal = nte_wal::validate_or_repair(&wal_path).expect("valid NTE library WAL");
        assert!(wal.valid_records >= 5, "complete library WAL transaction");
        println!(
            "LIVE_NTE_DOWNLOAD_OK bytes={expected_size} md5={md5} payloads={payload_count} preview={}x{} wal_records={} elapsed_ms={}",
            preview.width(),
            preview.height(),
            wal.valid_records,
            started.elapsed().as_millis()
        );
    }
}

#[tauri::command]
fn cancel_extract(key: String) -> Result<(), String> {
    let mut counts = DOWNLOAD_COUNTS.lock().unwrap();
    if let Some(count) = counts.get_mut(&key) {
        if *count > 0 {
            *count -= 1;
            println!("Decreased download count for key '{}': {}", key, *count);

            // Remove key if count reaches 0
            if *count == 0 {
                counts.remove(&key);
                println!("Removed key '{}' from download counts", key);
            }
            Ok(())
        } else {
            Err(format!("Key '{}' already has count of 0", key))
        }
    } else {
        Err(format!("Key '{}' not found in download counts", key))
    }
}

#[tauri::command]
fn cancel_download(key: String) -> Result<(), String> {
    mark_download_cancelled(&key);
    Ok(())
}

#[tauri::command]
async fn fetch_gamebanana_json(
    url: String,
    request_id: String,
    state: tauri::State<'_, GameBananaHttpState>,
) -> Result<serde_json::Value, String> {
    let client = state.client()?;
    let receiver = state.register(&request_id)?;
    let result = tokio::select! {
        _ = receiver => Err(GAMEBANANA_CANCELLED_MESSAGE.to_string()),
        result = fetch_gamebanana_json_value(client, url) => result,
    };
    state.finish(&request_id);
    result
}

#[tauri::command]
fn cancel_gamebanana_request(
    request_id: String,
    state: tauri::State<'_, GameBananaHttpState>,
) -> Result<(), String> {
    state.cancel(&request_id)
}

#[tauri::command]
fn get_username() -> String {
    let new_sid = SESSION_ID.fetch_add(1, Ordering::SeqCst) + 1;
    tracing::info!("Session changed, new session ID: {}", new_sid);

    let username = std::env::var("USERNAME").unwrap_or_else(|_| "Unknown".to_string());
    println!("Username: {}, Session ID: {}", username, new_sid);
    username
}
#[tauri::command]
fn exit_app() {
    std::process::exit(0x0);
}

#[tauri::command]
fn get_session_id() -> u64 {
    SESSION_ID.load(Ordering::SeqCst)
}

#[tauri::command]
fn get_runtime_data_dir() -> Result<String, String> {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|err| err.to_string())
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ManagedPathRoot {
    Source,
    Target,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedGamePaths {
    source_dir: String,
    target_dir: String,
}

fn validate_registered_game_key(game: &str) -> Result<(), String> {
    if REGISTERED_GAME_KEYS.contains(&game) {
        Ok(())
    } else {
        Err("Unknown game identifier".to_string())
    }
}

fn validate_managed_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err("Managed folder path must be relative".to_string());
    }
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) | std::path::Component::CurDir => {}
            _ => return Err("Managed folder path contains an unsafe component".to_string()),
        }
    }
    Ok(path.to_path_buf())
}

fn resolve_managed_folder_from_config_dir(
    config_dir: &Path,
    game: &str,
    root_kind: ManagedPathRoot,
    relative_path: &str,
) -> Result<PathBuf, String> {
    validate_registered_game_key(game)?;
    let config = if game == "NTE" {
        let (source_dir, target_dir) = nte::persisted_nte_game_directories(config_dir)?;
        PersistedGamePaths {
            source_dir,
            target_dir,
        }
    } else {
        let config_path = config_dir.join(format!("config{game}.json"));
        serde_json::from_str(
            &std::fs::read_to_string(&config_path)
                .map_err(|err| format!("Unable to read persisted game configuration: {err}"))?,
        )
        .map_err(|err| format!("Invalid persisted game configuration: {err}"))?
    };
    let configured_root = match root_kind {
        ManagedPathRoot::Source => config.source_dir,
        ManagedPathRoot::Target => config.target_dir,
    };
    if configured_root.trim().is_empty() {
        return Err("The configured game folder is empty".to_string());
    }

    let root = PathBuf::from(configured_root)
        .canonicalize()
        .map_err(|err| format!("Unable to resolve the configured game folder: {err}"))?;
    let relative = validate_managed_relative_path(relative_path)?;
    let candidate = root
        .join(relative)
        .canonicalize()
        .map_err(|err| format!("Unable to resolve the managed folder: {err}"))?;
    if !candidate.starts_with(&root) || !candidate.is_dir() {
        return Err(
            "Managed folder is outside the configured root or is not a directory".to_string(),
        );
    }
    Ok(candidate)
}

fn is_ignored_mod_payload_entry(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.starts_with("preview.")
        || normalized.starts_with(".imm-")
        || normalized.contains(".imm-staging")
        || normalized.contains(".imm-backup")
}

fn measure_mod_payload_size(root: &Path) -> Result<u64, String> {
    let root_metadata = std::fs::symlink_metadata(root)
        .map_err(|err| format!("Unable to inspect the Mod directory: {err}"))?;
    if !root_metadata.is_dir() || deployment_metadata_is_reparse(&root_metadata) {
        return Err("The Mod payload root is not a safe regular directory.".to_string());
    }

    let mut total = 0_u64;
    let mut entry_count = 0_usize;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .map_err(|err| format!("Unable to enumerate the Mod payload: {err}"))?
        {
            let entry =
                entry.map_err(|err| format!("Unable to enumerate the Mod payload: {err}"))?;
            entry_count = entry_count.saturating_add(1);
            if entry_count > MAX_MOD_PAYLOAD_SCAN_ENTRIES {
                return Err(format!(
                    "The Mod payload exceeds the {MAX_MOD_PAYLOAD_SCAN_ENTRIES} entry scan limit."
                ));
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if is_ignored_mod_payload_entry(&name) {
                continue;
            }
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|err| format!("Unable to inspect the Mod payload entry: {err}"))?;
            if deployment_metadata_is_reparse(&metadata) {
                return Err(format!(
                    "The Mod payload contains an unsafe reparse entry: {}",
                    entry.path().display()
                ));
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total
                    .checked_add(metadata.len())
                    .ok_or_else(|| "The Mod payload size overflowed u64.".to_string())?;
            } else {
                return Err(format!(
                    "The Mod payload contains an unsupported entry: {}",
                    entry.path().display()
                ));
            }
        }
    }
    Ok(total)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModPayloadSizeResult {
    bytes: Option<u64>,
    error: Option<String>,
}

#[tauri::command]
async fn measure_mod_payload_sizes(
    game: String,
    relative_paths: Vec<String>,
) -> Result<HashMap<String, ModPayloadSizeResult>, String> {
    validate_registered_game_key(&game)?;
    if relative_paths.len() > MAX_MOD_PAYLOAD_SCAN_PATHS {
        return Err(format!(
            "A payload-size request can include at most {MAX_MOD_PAYLOAD_SCAN_PATHS} Mod paths."
        ));
    }
    let config_dir = std::env::current_dir().map_err(|err| err.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        relative_paths
            .into_iter()
            .map(|relative_path| {
                let result = (|| {
                    let relative = validate_managed_relative_path(&relative_path)?;
                    if relative.as_os_str().is_empty() {
                        return Err("A Mod-relative path is required.".to_string());
                    }
                    let managed_relative = PathBuf::from(MANAGED_SOURCE_DIR).join(relative);
                    let directory = resolve_managed_folder_from_config_dir(
                        &config_dir,
                        &game,
                        ManagedPathRoot::Source,
                        &managed_relative.to_string_lossy(),
                    )?;
                    measure_mod_payload_size(&directory)
                })();
                let value = match result {
                    Ok(bytes) => ModPayloadSizeResult {
                        bytes: Some(bytes),
                        error: None,
                    },
                    Err(error) => ModPayloadSizeResult {
                        bytes: None,
                        error: Some(error),
                    },
                };
                (relative_path, value)
            })
            .collect()
    })
    .await
    .map_err(|err| format!("Mod payload size worker failed: {err}"))
}

#[cfg(test)]
mod managed_folder_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_config(config_dir: &Path, game: &str, source: &Path, target: &Path) {
        let config = serde_json::json!({
            "game": game,
            "sourceDir": source,
            "targetDir": target,
        });
        fs::write(
            config_dir.join(format!("config{game}.json")),
            serde_json::to_vec(&config).expect("serialize config"),
        )
        .expect("write config");
    }

    #[test]
    fn managed_folder_resolves_only_inside_persisted_root() {
        let temp = tempdir().expect("tempdir");
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let managed = source.join(MANAGED_SOURCE_DIR).join("Category");
        fs::create_dir_all(&managed).expect("managed folder");
        fs::create_dir_all(&target).expect("target folder");
        write_config(temp.path(), "NTE", &source, &target);

        let resolved = resolve_managed_folder_from_config_dir(
            temp.path(),
            "NTE",
            ManagedPathRoot::Source,
            &format!("{MANAGED_SOURCE_DIR}/Category"),
        )
        .expect("resolve managed folder");

        assert_eq!(resolved, managed.canonicalize().expect("canonical managed"));
    }

    #[test]
    fn managed_folder_rejects_unknown_game_and_parent_escape() {
        let temp = tempdir().expect("tempdir");
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir_all(&source).expect("source folder");
        fs::create_dir_all(&target).expect("target folder");
        write_config(temp.path(), "WW", &source, &target);

        assert!(resolve_managed_folder_from_config_dir(
            temp.path(),
            "../WW",
            ManagedPathRoot::Source,
            "",
        )
        .is_err());
        assert!(resolve_managed_folder_from_config_dir(
            temp.path(),
            "WW",
            ManagedPathRoot::Source,
            "../target",
        )
        .is_err());
    }

    #[test]
    fn payload_size_excludes_previews_and_imm_transaction_artifacts() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("mod");
        fs::create_dir_all(root.join("payload")).expect("payload dir");
        fs::create_dir_all(root.join(".imm-staging-orphan")).expect("staging dir");
        fs::write(root.join("payload").join("main.pak"), vec![1_u8; 20]).expect("payload");
        fs::write(root.join("preview.jpg"), vec![2_u8; 100]).expect("preview");
        fs::write(root.join(".imm-metadata.json"), vec![3_u8; 200]).expect("metadata");
        fs::write(
            root.join(".imm-staging-orphan").join("partial.pak"),
            vec![4_u8; 300],
        )
        .expect("staging payload");

        assert_eq!(
            measure_mod_payload_size(&root).expect("measure payload"),
            20
        );
    }
}

#[tauri::command]
fn open_managed_folder(
    app_handle: tauri::AppHandle,
    game: String,
    root_kind: ManagedPathRoot,
    relative_path: String,
) -> Result<(), String> {
    let config_dir = std::env::current_dir().map_err(|err| err.to_string())?;
    let path =
        resolve_managed_folder_from_config_dir(&config_dir, &game, root_kind, &relative_path)?;
    app_handle
        .opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|err| format!("Unable to open the managed folder: {err}"))
}

#[tauri::command]
fn open_app_state_folder(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, app_state::AppStateRepository>,
) -> Result<(), String> {
    app_handle
        .opener()
        .open_path(repository.control_root().to_string_lossy(), None::<&str>)
        .map_err(|error| format!("Unable to open the application state folder: {error}"))
}

#[tauri::command]
fn open_wuwa_mod_fixer_folder(app_handle: tauri::AppHandle) -> Result<(), String> {
    let path = std::env::current_dir()
        .map_err(|err| err.to_string())?
        .join("tools")
        .join("Wuwa_Mod_Fixer");
    std::fs::create_dir_all(&path)
        .map_err(|err| format!("Unable to create the Wuwa Mod Fixer folder: {err}"))?;
    app_handle
        .opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|err| format!("Unable to open the Wuwa Mod Fixer folder: {err}"))
}

#[tauri::command]
async fn resolve_preview_assets(
    app_handle: tauri::AppHandle,
    repository: tauri::State<'_, app_state::AppStateRepository>,
    game: String,
    requests: Vec<PreviewCacheRequest>,
) -> Result<Vec<ResolvedPreviewAsset>, String> {
    let cache_root = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Unable to resolve the preview cache root: {err}"))?
        .join(PREVIEW_CACHE_DIR);
    validate_registered_game_key(&game)?;
    let managed_root = persisted_managed_source_root(repository.runtime_root(), &game)?;

    tokio::task::spawn_blocking(move || {
        let mut assets = Vec::with_capacity(requests.len());
        for request in requests {
            match resolve_managed_preview_file(&managed_root, &request.relative_path) {
                Ok(Some(source)) => match copy_preview_to_cache(&source, &cache_root) {
                    Ok(path) => assets.push(ResolvedPreviewAsset {
                        key: request.key,
                        path: path.to_string_lossy().into_owned(),
                    }),
                    Err(err) => tracing::warn!(
                        "Unable to cache preview for {}: {}",
                        request.relative_path,
                        err
                    ),
                },
                Ok(None) => {}
                Err(err) => tracing::warn!(
                    "Unable to resolve preview for {}: {}",
                    request.relative_path,
                    err
                ),
            }
        }
        Ok(assets)
    })
    .await
    .map_err(|err| format!("Preview cache worker failed: {err}"))?
}

#[tauri::command]
fn get_update_install_context() -> Result<UpdateInstallContext, String> {
    let exe_path = std::env::current_exe().map_err(|err| err.to_string())?;
    Ok(build_update_install_context_from_exe(&exe_path))
}

#[tauri::command]
async fn install_portable_update(
    _app_handle: tauri::AppHandle,
    download_url: String,
    version: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = download_url;
        let _ = version;
        return Err("Portable updater is only supported on Windows.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let exe_path = std::env::current_exe().map_err(|err| err.to_string())?;
        let context = build_update_install_context_from_exe(&exe_path);
        if !context.portable {
            return Err("Portable update was requested for a managed install.".to_string());
        }

        let current_pid = std::process::id();
        let temp_root = std::env::temp_dir().join("imm-portable-updater");
        std::fs::create_dir_all(&temp_root).map_err(|err| err.to_string())?;

        let safe_version = version
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' {
                    ch
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let installer_path = temp_root.join(format!(
            "Integrated.Mod.Manager.IMM._{}_x64-setup.exe",
            safe_version
        ));
        let script_path = temp_root.join(format!("install-portable-update-{}.ps1", safe_version));

        download_file_to_path(&download_url, &installer_path).await?;
        let script_contents = build_portable_update_script(
            current_pid,
            &installer_path,
            Path::new(&context.current_exe_dir),
            &exe_path,
        );
        std::fs::write(&script_path, script_contents).map_err(|err| err.to_string())?;

        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("powershell.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script_path.to_string_lossy().as_ref(),
            ])
            .spawn()
            .map_err(|err| err.to_string())?;

        std::process::exit(0);
    }
}

#[tauri::command]
fn request_app_restart(app_handle: tauri::AppHandle) {
    app_handle.request_restart();
}

fn validate_managed_executable(root: &Path, executable: &Path) -> Result<PathBuf, String> {
    let root_metadata = std::fs::symlink_metadata(root)
        .map_err(|err| format!("Unable to inspect the executable root: {err}"))?;
    if !root_metadata.is_dir() || deployment_metadata_is_reparse(&root_metadata) {
        return Err("The executable root must be a regular local directory.".to_string());
    }

    let canonical_root = std::fs::canonicalize(root)
        .map_err(|err| format!("Unable to resolve the executable root: {err}"))?;
    let canonical_executable = std::fs::canonicalize(executable)
        .map_err(|err| format!("Unable to resolve the executable: {err}"))?;
    let relative = canonical_executable
        .strip_prefix(&canonical_root)
        .map_err(|_| "The executable escaped its managed root.".to_string())?;

    let mut cursor = canonical_root.clone();
    for component in relative.components() {
        cursor.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&cursor)
            .map_err(|err| format!("Unable to inspect the executable path: {err}"))?;
        if deployment_metadata_is_reparse(&metadata) {
            return Err("The executable path contains a reparse point.".to_string());
        }
    }
    let executable_metadata = std::fs::metadata(&canonical_executable)
        .map_err(|err| format!("Unable to inspect the executable: {err}"))?;
    if !executable_metadata.is_file()
        || canonical_executable
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
    {
        return Err("The managed executable is not a regular .exe file.".to_string());
    }
    Ok(canonical_executable)
}

fn file_sha256(path: &Path) -> Result<[u8; 32], String> {
    let mut input = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|err| format!("Unable to open the managed executable: {err}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|err| format!("Unable to hash the managed executable: {err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

fn spawn_managed_executable(executable: &Path, args: &[&str]) -> Result<String, String> {
    let child = Command::new(executable)
        .args(args)
        .spawn()
        .map_err(|err| format!("Failed to start the managed executable: {err}"))?;
    tracing::info!(
        "Started managed executable '{}' with PID {}",
        executable.display(),
        child.id()
    );
    Ok(format!(
        "Process started successfully with PID: {}",
        child.id()
    ))
}

fn xxmi_profile_for_game(game: &str) -> Result<&'static str, String> {
    match game {
        "WW" => Ok("WWMI"),
        "ZZ" => Ok("ZZMI"),
        "GI" => Ok("GIMI"),
        "SR" => Ok("SRMI"),
        "EF" => Ok("EFMI"),
        _ => Err("Only registered XXMI games can use the launcher.".to_string()),
    }
}

#[tauri::command]
fn launch_configured_xxmi(
    game: String,
    repository: tauri::State<'_, app_state::AppStateRepository>,
) -> Result<String, String> {
    let profile = xxmi_profile_for_game(&game)?;
    let global = repository.load_global_value()?;
    let root = global
        .get("XXMI")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "The configured XXMI Launcher directory is missing.".to_string())?;
    let executable = root.join("Resources").join("Bin").join("XXMI Launcher.exe");
    let executable = validate_managed_executable(&root, &executable)?;
    spawn_managed_executable(&executable, &["--nogui", "--xxmi", profile])
}

#[tauri::command]
fn launch_bundled_wuwa_mod_fixer(app_handle: tauri::AppHandle) -> Result<String, String> {
    let tool = ensure_bundled_wuwa_mod_fixer(app_handle)?;
    let source_root = PathBuf::from(&tool.source_path);
    let runtime_root = std::env::current_dir()
        .map_err(|err| err.to_string())?
        .join("tools")
        .join("Wuwa_Mod_Fixer");
    let source_executable = find_fixer_exe(&source_root, 5)
        .ok_or_else(|| "Bundled Wuwa Mod Fixer source executable is missing.".to_string())?;
    let source_executable = validate_managed_executable(&source_root, &source_executable)?;
    let runtime_executable = validate_managed_executable(&runtime_root, Path::new(&tool.exe_path))?;
    if file_sha256(&source_executable)? != file_sha256(&runtime_executable)? {
        return Err(
            "The installed Wuwa Mod Fixer does not match the bundled executable.".to_string(),
        );
    }
    spawn_managed_executable(&runtime_executable, &[])
}

#[cfg(test)]
mod managed_process_launch_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn xxmi_profiles_are_fixed_to_registered_legacy_games() {
        assert_eq!(xxmi_profile_for_game("WW"), Ok("WWMI"));
        assert_eq!(xxmi_profile_for_game("ZZ"), Ok("ZZMI"));
        assert_eq!(xxmi_profile_for_game("GI"), Ok("GIMI"));
        assert_eq!(xxmi_profile_for_game("SR"), Ok("SRMI"));
        assert_eq!(xxmi_profile_for_game("EF"), Ok("EFMI"));
        assert!(xxmi_profile_for_game("NTE").is_err());
        assert!(xxmi_profile_for_game("../../cmd").is_err());
    }

    #[test]
    fn managed_executable_must_remain_below_its_regular_root() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path().join("root");
        let outside = temp.path().join("outside.exe");
        std::fs::create_dir_all(root.join("bin")).expect("managed root");
        std::fs::write(root.join("bin").join("tool.exe"), b"managed").expect("managed exe");
        std::fs::write(&outside, b"outside").expect("outside exe");

        let managed = validate_managed_executable(&root, &root.join("bin").join("tool.exe"))
            .expect("regular child executable");
        assert!(managed.ends_with("tool.exe"));
        assert!(validate_managed_executable(&root, &outside).is_err());
        assert!(validate_managed_executable(&root, &root.join("missing.exe")).is_err());
    }

    #[test]
    fn executable_hash_detects_same_size_content_changes() {
        let temp = tempdir().expect("tempdir");
        let first = temp.path().join("first.exe");
        let second = temp.path().join("second.exe");
        std::fs::write(&first, b"AAAA").expect("first");
        std::fs::write(&second, b"BBBB").expect("second");

        assert_ne!(file_sha256(&first).unwrap(), file_sha256(&second).unwrap());
    }
}

#[tauri::command]
async fn set_window_icon(app_handle: tauri::AppHandle, game: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let icon_bytes = match game.as_str() {
            "WW" => include_bytes!("../icons/WW128x128.png").as_slice(),
            "ZZ" => include_bytes!("../icons/ZZ128x128.png").as_slice(),
            "GI" => include_bytes!("../icons/GI128x128.png").as_slice(),
            "SR" => include_bytes!("../icons/SR128x128.png").as_slice(),
            "EF" => include_bytes!("../icons/EF128x128.png").as_slice(),
            _ => include_bytes!("../icons/128x128.png").as_slice(),
        };

        if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.set_icon(icon);
            }
        }
    }
    Ok(())
}

use tauri_plugin_window_state::{Builder, StateFlags};

#[cfg(windows)]
pub fn run_privileged_helper_if_requested() -> Option<i32> {
    match privileged_helper::run_if_requested() {
        Ok(privileged_helper::HelperRunStatus::NotRequested) => None,
        Ok(privileged_helper::HelperRunStatus::Completed) => Some(0),
        Err(error) => {
            eprintln!("Privileged helper rejected the request: {error}");
            Some(1)
        }
    }
}

#[cfg(not(windows))]
pub fn run_privileged_helper_if_requested() -> Option<i32> {
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_rustls_crypto_provider();
    let app_state_repository = app_state::AppStateRepository::from_environment()
        .unwrap_or_else(app_state::AppStateRepository::unavailable);
    let mut log_builder = LogBuilder::new()
        .level(if cfg!(debug_assertions) {
            LevelFilter::Debug
        } else {
            LevelFilter::Info
        })
        .rotation_strategy(RotationStrategy::KeepSome(10))
        .max_file_size(25 * 1024 * 1024)
        .clear_targets()
        .target(Target::new(TargetKind::LogDir {
            file_name: Some("app".into()),
        }));
    if cfg!(debug_assertions) {
        log_builder = log_builder.target(Target::new(TargetKind::Stdout));
    }
    if let Err(err) = tauri::Builder::default()
        .manage(app_state_repository)
        .manage(GameBananaHttpState::new())
        .plugin(log_builder.build())
        .plugin(
            Builder::default()
                // Persist practical window state while avoiding decoration flag churn.
                .with_state_flags(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::VISIBLE
                        | StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|_app, argv, _cwd| {
            println!("a new app instance was opened with {argv:?} and the deep link event was already triggered");
            // when defining deep link schemes at runtime, you must also check `argv` here
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let (bootstrap_status, runtime_root) = {
                let repository = app.state::<app_state::AppStateRepository>();
                (repository.bootstrap(), repository.runtime_root().to_path_buf())
            };
            match bootstrap_status {
                app_state::BootstrapStatus::Ready { .. } => {
                    if let Err(err) = std::env::set_current_dir(&runtime_root) {
                        tracing::error!(
                            "Unable to activate the application state runtime projection '{}': {}",
                            runtime_root.display(),
                            err
                        );
                    }
                }
                app_state::BootstrapStatus::RecoveryRequired { ref error, .. } => {
                    tracing::error!("Application state recovery is required: {}", error);
                }
                app_state::BootstrapStatus::Pending => {
                    tracing::error!("Application state bootstrap did not reach a terminal status");
                }
            }
            match app.path().app_local_data_dir() {
                Ok(app_local_data) => {
                    if let Err(err) = cleanup_stale_nte_download_staging(&app_local_data) {
                        tracing::warn!("Unable to clean stale NTE download staging: {}", err);
                    }
                }
                Err(err) => tracing::warn!("Unable to resolve NTE download staging: {}", err),
            }
            #[cfg(desktop)]
            if let Err(err) = app.deep_link().register_all() {
                tracing::warn!("Unable to register deep-link schemes: {}", err);
            }
            #[cfg(target_os = "windows")]
            match tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")) {
                Ok(icon) => match app.get_webview_window("main") {
                    Some(window) => {
                        if let Err(err) = window.set_icon(icon) {
                            tracing::warn!("Unable to set the main window icon: {}", err);
                        }
                    }
                    None => tracing::warn!("Main window was unavailable while setting the startup icon"),
                },
                Err(err) => tracing::warn!("Unable to decode the startup icon: {}", err),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            exit_app,
            app_state::get_app_state_bootstrap_status,
            app_state::retry_app_state_bootstrap,
            app_state::load_app_config,
            app_state::save_app_config,
            app_state::reset_app_state_with_backup,
            get_username,
            download_and_unzip,
            bind_gamebanana_mod,
            backfill_mod_preview,
            measure_mod_payload_sizes,
            cancel_extract,
            cancel_download,
            fetch_gamebanana_json,
            cancel_gamebanana_request,
            remote_media::resolve_remote_media,
            remote_media::service_health_check,
            get_session_id,
            get_runtime_data_dir,
            managed_fs::managed_path_exists,
            managed_fs::read_managed_dir,
            managed_fs::read_managed_text_file,
            managed_fs::create_managed_dir,
            managed_fs::prepare_managed_source_dir,
            managed_fs::remove_managed_path,
            managed_fs::rename_managed_path,
            managed_fs::copy_managed_file,
            save_managed_preview_data,
            import_managed_preview_file,
            open_managed_folder,
            open_app_state_folder,
            open_wuwa_mod_fixer_folder,
            resolve_preview_assets,
            get_update_install_context,
            managed_text::export_json_document,
            managed_text::pick_json_import_document,
            managed_text::read_d3dx_user_ini,
            managed_text::ensure_d3dx_user_ini_backup,
            managed_text::read_xxmi_launcher_config,
            managed_text::read_xxmi_importer_d3dx,
            managed_text::discover_xxmi_launcher_dir,
            managed_text::set_d3dx_foreground_mode,
            managed_text::write_managed_text_asset,
            managed_text::write_xxmi_launcher_config,
            ensure_bundled_wuwa_mod_fixer,
            install_portable_update,
            request_app_restart,
            launch_configured_xxmi,
            launch_bundled_wuwa_mod_fixer,
            managed_junction::set_managed_mod_enabled,
            extract_archive,
            set_window_icon,
            logger_utils::open_logs_folder,
            privileged_helper::get_wer_local_dumps_status,
            privileged_helper::configure_wer_local_dumps,
            privileged_helper::remove_wer_local_dumps,
            nte::detect_nte_game_roots,
            nte::delete_nte_mod,
            nte::launch_nte_game,
            nte::load_nte_config,
            nte::rename_nte_mod,
            nte::save_nte_config,
            nte::set_nte_mod_enabled,
            nte::validate_nte_game_root,
            nte::validate_nte_mods_root,
            hotreload::set_hotreload,
            hotreload::start_window_monitoring,
            hotreload::stop_window_monitoring,
            hotreload::set_change,
            hotreload::focus_mod_manager_send_f10_return_to_game,
            hotreload::set_window_target,
            hotreload::is_game_process_running,
            ini_watcher::start_ini_state_watch,
            ini_watcher::stop_ini_state_watch
        ])
        .run(tauri::generate_context!())
    {
        tracing::error!("Tauri application stopped with an error: {}", err);
        eprintln!("Tauri application stopped with an error: {err}");
    }
}

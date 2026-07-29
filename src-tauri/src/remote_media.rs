use atomic_write_file::AtomicWriteFile;
use futures_util::StreamExt;
use image::{DynamicImage, ImageFormat, ImageReader, Limits};
use once_cell::sync::Lazy;
use reqwest::header::CONTENT_TYPE;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tokio::sync::{watch, Mutex as AsyncMutex, Semaphore};

const MAX_SOURCE_DIMENSION: u32 = 8192;
const MAX_SOURCE_PIXELS: u64 = 8192 * 4096;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT_DIMENSION: u32 = 2048;
const MAX_REMOTE_MEDIA_BYTES: usize = 20 * 1024 * 1024;
const REMOTE_MEDIA_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const REMOTE_MEDIA_CACHE_SCHEMA: u32 = 1;
const REMOTE_MEDIA_INDEX_FILE: &str = "index.json";
const MAX_REMOTE_MEDIA_URL_BYTES: usize = 4096;
const MAX_REMOTE_MEDIA_INDEX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_REMOTE_MEDIA_INDEX_ENTRIES: usize = 10_000;
const MAX_CACHED_PNG_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REMOTE_MEDIA_REQUESTS: usize = 32;
const REMOTE_MEDIA_TEMP_STALE_AFTER: Duration = Duration::from_secs(60 * 60);

static REMOTE_MEDIA_CACHE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static REMOTE_MEDIA_DOWNLOADS: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(4));
static REMOTE_MEDIA_DECODERS: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(1));
static REMOTE_MEDIA_REQUEST_SLOTS: Lazy<Semaphore> =
    Lazy::new(|| Semaphore::new(MAX_REMOTE_MEDIA_REQUESTS));
type RemoteMediaFlightResult = Result<String, String>;
type RemoteMediaFlightSender = watch::Sender<Option<RemoteMediaFlightResult>>;
static REMOTE_MEDIA_FLIGHTS: Lazy<AsyncMutex<BTreeMap<String, Arc<RemoteMediaFlightSender>>>> =
    Lazy::new(|| AsyncMutex::new(BTreeMap::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMediaCacheEntry {
    content_hash: String,
    size: u64,
    last_access_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMediaCacheIndex {
    schema_version: u32,
    entries: BTreeMap<String, RemoteMediaCacheEntry>,
}

impl Default for RemoteMediaCacheIndex {
    fn default() -> Self {
        Self {
            schema_version: REMOTE_MEDIA_CACHE_SCHEMA,
            entries: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealthResponse {
    client: Option<String>,
}

pub(crate) fn validate_remote_media_url(raw_url: &str) -> Result<Url, String> {
    if raw_url.len() > MAX_REMOTE_MEDIA_URL_BYTES {
        return Err("Remote image URL exceeds the 4096-byte limit.".to_string());
    }
    let url = Url::parse(raw_url).map_err(|err| format!("Invalid remote image URL: {err}"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return Err(
            "Remote images require HTTPS URLs without credentials or fragments.".to_string(),
        );
    }
    let allowed = match url.host_str().unwrap_or_default() {
        "images.gamebanana.com" => {
            url.path().starts_with("/img/") || url.path().starts_with("/static/")
        }
        "api.hakush.in" => url.path().starts_with("/gi/UI/"),
        "flagsapi.com" => {
            let parts = url
                .path()
                .split('/')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            parts.len() == 3
                && parts[0].len() == 2
                && parts[0].chars().all(|ch| ch.is_ascii_uppercase())
                && parts[1] == "flat"
                && parts[2].strip_suffix(".png").is_some_and(|size| {
                    !size.is_empty() && size.chars().all(|ch| ch.is_ascii_digit())
                })
        }
        "huihui.top" | "www.huihui.top" | "www.kekehxl.com" => {
            url.path().starts_with('/') && !url.path().contains("..")
        }
        "pic1.afdiancdn.com" => url.path().starts_with("/user/"),
        _ => false,
    };
    if !allowed {
        return Err("Remote image URL is outside the approved media origins.".to_string());
    }
    Ok(url)
}

fn remote_media_redirect_allowed(url: &Url, previous_hops: usize) -> bool {
    previous_hops < 5 && validate_remote_media_url(url.as_str()).is_ok()
}

fn append_remote_media_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if body.len().saturating_add(chunk.len()) > MAX_REMOTE_MEDIA_BYTES {
        return Err("Remote image exceeds the 20 MiB download limit.".to_string());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

pub(crate) fn validate_remote_media_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > MAX_SOURCE_DIMENSION
        || height > MAX_SOURCE_DIMENSION
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_SOURCE_PIXELS
    {
        return Err("Remote image dimensions exceed the safety limit.".to_string());
    }
    Ok(())
}

fn normalized_mime(content_type: &str) -> &str {
    content_type.split(';').next().unwrap_or_default().trim()
}

fn is_json_content_type(content_type: &str) -> bool {
    let mime = normalized_mime(content_type).to_ascii_lowercase();
    mime == "application/json" || mime.ends_with("+json")
}

fn expected_format(content_type: &str) -> Result<ImageFormat, String> {
    match normalized_mime(content_type) {
        "image/png" => Ok(ImageFormat::Png),
        "image/jpeg" | "image/jpg" => Ok(ImageFormat::Jpeg),
        "image/webp" => Ok(ImageFormat::WebP),
        _ => Err("Remote response is not an approved PNG, JPEG, or WebP image.".to_string()),
    }
}

fn webp_is_animated(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return false;
    }
    let mut offset = 12usize;
    while offset.saturating_add(8) <= bytes.len() {
        let chunk_name = &bytes[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let data_start = offset + 8;
        let Some(data_end) = data_start.checked_add(chunk_size) else {
            return true;
        };
        if data_end > bytes.len() {
            break;
        }
        if chunk_name == b"ANIM" || chunk_name == b"ANMF" {
            return true;
        }
        if chunk_name == b"VP8X" && chunk_size > 0 && bytes[data_start] & 0x02 != 0 {
            return true;
        }
        let padded_size = chunk_size.saturating_add(chunk_size & 1);
        let Some(next) = data_start.checked_add(padded_size) else {
            return true;
        };
        if next <= offset {
            return true;
        }
        offset = next;
    }
    false
}

fn image_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_DIMENSION);
    limits.max_image_height = Some(MAX_SOURCE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits
}

pub(crate) fn decode_and_reencode_remote_media(
    bytes: &[u8],
    content_type: &str,
) -> Result<Vec<u8>, String> {
    let format = expected_format(content_type)?;
    let detected = image::guess_format(bytes)
        .map_err(|err| format!("Unable to identify remote image bytes: {err}"))?;
    if detected != format {
        return Err("Remote image MIME type does not match its file signature.".to_string());
    }
    if format == ImageFormat::WebP && webp_is_animated(bytes) {
        return Err("Remote animated WebP images are not supported.".to_string());
    }

    let mut dimension_reader = ImageReader::with_format(Cursor::new(bytes), format);
    dimension_reader.limits(image_limits());
    let (width, height) = dimension_reader
        .into_dimensions()
        .map_err(|err| format!("Unable to inspect remote image dimensions: {err}"))?;
    validate_remote_media_dimensions(width, height)?;

    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(image_limits());
    let decoded = reader
        .decode()
        .map_err(|err| format!("Unable to decode remote image safely: {err}"))?;
    let normalized: DynamicImage = if width > MAX_OUTPUT_DIMENSION || height > MAX_OUTPUT_DIMENSION
    {
        decoded.thumbnail(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION)
    } else {
        decoded
    };
    let mut output = Cursor::new(Vec::new());
    normalized
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|err| format!("Unable to encode normalized remote image: {err}"))?;
    Ok(output.into_inner())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn cache_index_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(REMOTE_MEDIA_INDEX_FILE)
}

fn cached_content_path(cache_dir: &Path, content_hash: &str) -> PathBuf {
    cache_dir.join(format!("{content_hash}.png"))
}

fn is_lower_hex_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn atomic_write_temp_target(file_name: &str) -> Option<&str> {
    let temporary = file_name.strip_prefix('.')?;
    let (target, suffix) = temporary.rsplit_once('.')?;
    if suffix.len() != 6 || !suffix.is_ascii() {
        return None;
    }
    if target == REMOTE_MEDIA_INDEX_FILE
        || target.strip_suffix(".png").is_some_and(is_lower_hex_hash)
    {
        Some(target)
    } else {
        None
    }
}

fn cache_index_is_valid(index: &RemoteMediaCacheIndex) -> bool {
    index.schema_version == REMOTE_MEDIA_CACHE_SCHEMA
        && index.entries.len() <= MAX_REMOTE_MEDIA_INDEX_ENTRIES
        && index.entries.iter().all(|(url_key, entry)| {
            is_lower_hex_hash(url_key)
                && is_lower_hex_hash(&entry.content_hash)
                && entry.size > 0
                && entry.size <= MAX_CACHED_PNG_BYTES
        })
}

fn read_cache_index(cache_dir: &Path) -> RemoteMediaCacheIndex {
    let path = cache_index_path(cache_dir);
    let Ok(metadata) = fs::metadata(&path) else {
        return RemoteMediaCacheIndex::default();
    };
    if !metadata.is_file() || metadata.len() > MAX_REMOTE_MEDIA_INDEX_BYTES {
        log::warn!("Ignoring oversized or non-file remote media cache index");
        return RemoteMediaCacheIndex::default();
    }
    let Ok(payload) = fs::read(path) else {
        return RemoteMediaCacheIndex::default();
    };
    match serde_json::from_slice::<RemoteMediaCacheIndex>(&payload) {
        Ok(index) if cache_index_is_valid(&index) => index,
        Ok(_) => {
            log::warn!("Ignoring unsafe or unsupported remote media cache index");
            RemoteMediaCacheIndex::default()
        }
        Err(err) => {
            log::warn!("Ignoring invalid remote media cache index: {}", err);
            RemoteMediaCacheIndex::default()
        }
    }
}

fn write_cache_index(cache_dir: &Path, index: &RemoteMediaCacheIndex) -> Result<(), String> {
    if !cache_index_is_valid(index) {
        return Err("Refusing to write an invalid remote media cache index.".to_string());
    }
    fs::create_dir_all(cache_dir).map_err(|err| err.to_string())?;
    let payload = serde_json::to_vec(index).map_err(|err| err.to_string())?;
    if payload.len() as u64 > MAX_REMOTE_MEDIA_INDEX_BYTES {
        return Err("Remote media cache index exceeds the 4 MiB limit.".to_string());
    }
    let mut output =
        AtomicWriteFile::open(cache_index_path(cache_dir)).map_err(|err| err.to_string())?;
    output.write_all(&payload).map_err(|err| err.to_string())?;
    output.commit().map_err(|err| err.to_string())
}

fn write_cached_content(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        let size = fs::metadata(path).map_err(|err| err.to_string())?.len();
        if size == bytes.len() as u64 {
            return Ok(());
        }
        fs::remove_file(path).map_err(|err| err.to_string())?;
    }
    let mut output = AtomicWriteFile::open(path).map_err(|err| err.to_string())?;
    output.write_all(bytes).map_err(|err| err.to_string())?;
    output.commit().map_err(|err| err.to_string())
}

fn lookup_cached_remote_media(
    cache_dir: &Path,
    source_url: &str,
    last_access_ms: u64,
) -> Result<Option<PathBuf>, String> {
    let mut index = read_cache_index(cache_dir);
    let url_hash = sha256_hex(source_url.as_bytes());
    let Some(entry) = index.entries.get_mut(&url_hash) else {
        return Ok(None);
    };
    let path = cached_content_path(cache_dir, &entry.content_hash);
    let is_valid = fs::metadata(&path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() == entry.size);
    if !is_valid {
        index.entries.remove(&url_hash);
        write_cache_index(cache_dir, &index)?;
        return Ok(None);
    }
    entry.last_access_ms = last_access_ms;
    write_cache_index(cache_dir, &index)?;
    Ok(Some(path))
}

fn store_cached_remote_media(
    cache_dir: &Path,
    source_url: &str,
    normalized_png: &[u8],
    last_access_ms: u64,
    quota_bytes: u64,
) -> Result<PathBuf, String> {
    fs::create_dir_all(cache_dir).map_err(|err| err.to_string())?;
    let content_hash = sha256_hex(normalized_png);
    let content_path = cached_content_path(cache_dir, &content_hash);
    let new_size = normalized_png.len() as u64;
    if new_size > quota_bytes {
        return Err(format!(
            "Remote media cache quota could not be enforced ({} bytes remain over the limit).",
            new_size.saturating_sub(quota_bytes)
        ));
    }
    let existing_size = match fs::symlink_metadata(&content_path) {
        Ok(metadata) if metadata.file_type().is_file() => metadata.len(),
        Ok(_) => {
            return Err("Remote media cache payload is not a regular file.".to_string());
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
        Err(err) => return Err(err.to_string()),
    };
    let additional_size = new_size.saturating_sub(existing_size);
    enforce_remote_media_cache_quota(
        cache_dir,
        quota_bytes.saturating_sub(additional_size),
        Some(&content_hash),
    )?;
    write_cached_content(&content_path, normalized_png)?;

    let mut index = read_cache_index(cache_dir);
    let url_key = sha256_hex(source_url.as_bytes());
    if !index.entries.contains_key(&url_key) {
        while index.entries.len() >= MAX_REMOTE_MEDIA_INDEX_ENTRIES {
            let Some(oldest_key) = index
                .entries
                .iter()
                .min_by_key(|(key, entry)| (entry.last_access_ms, *key))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            index.entries.remove(&oldest_key);
        }
    }
    let previous_entry = index.entries.insert(
        url_key.clone(),
        RemoteMediaCacheEntry {
            content_hash: content_hash.clone(),
            size: normalized_png.len() as u64,
            last_access_ms,
        },
    );
    write_cache_index(cache_dir, &index)?;
    if let Err(error) =
        enforce_remote_media_cache_quota(cache_dir, quota_bytes, Some(&content_hash))
    {
        let mut rollback = read_cache_index(cache_dir);
        if rollback
            .entries
            .get(&url_key)
            .is_some_and(|entry| entry.content_hash == content_hash)
        {
            rollback.entries.remove(&url_key);
        }
        if let Some(previous) = previous_entry {
            let previous_path = cached_content_path(cache_dir, &previous.content_hash);
            if fs::metadata(previous_path)
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() == previous.size)
            {
                rollback.entries.insert(url_key, previous);
            }
        }
        let content_is_still_referenced = rollback
            .entries
            .values()
            .any(|entry| entry.content_hash == content_hash);
        write_cache_index(cache_dir, &rollback)?;
        if !content_is_still_referenced {
            match fs::remove_file(&content_path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => log::warn!(
                    "Unable to roll back remote media cache payload '{}': {}",
                    content_hash,
                    err
                ),
            }
        }
        return Err(error);
    }
    if !content_path.is_file() {
        return Err("Remote media cache did not retain the current payload.".to_string());
    }
    Ok(content_path)
}

fn enforce_remote_media_cache_quota(
    cache_dir: &Path,
    quota_bytes: u64,
    protected_content_hash: Option<&str>,
) -> Result<(), String> {
    enforce_remote_media_cache_quota_with(
        cache_dir,
        quota_bytes,
        protected_content_hash,
        |path| fs::remove_file(path),
        SystemTime::now(),
    )
}

fn enforce_remote_media_cache_quota_with<F>(
    cache_dir: &Path,
    quota_bytes: u64,
    protected_content_hash: Option<&str>,
    mut remove_file: F,
    now: SystemTime,
) -> Result<(), String>
where
    F: FnMut(&Path) -> std::io::Result<()>,
{
    let mut index = read_cache_index(cache_dir);
    let mut disk_payloads = BTreeMap::new();
    let mut atomic_temporary_files = Vec::new();
    let entries = fs::read_dir(cache_dir)
        .map_err(|err| format!("Unable to enumerate the remote media cache: {err}"))?;
    for entry in entries {
        let entry = entry
            .map_err(|err| format!("Unable to enumerate a remote media cache entry: {err}"))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let final_content_hash = name
            .strip_suffix(".png")
            .filter(|content_hash| is_lower_hex_hash(content_hash));
        let is_atomic_temporary = atomic_write_temp_target(name).is_some();
        if final_content_hash.is_none() && !is_atomic_temporary {
            continue;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => {
                return Err(format!(
                    "Unable to inspect remote media cache entry '{name}': {err}"
                ));
            }
        };
        if !metadata.file_type().is_file() {
            return Err(format!(
                "Remote media cache entry '{name}' is not a regular file."
            ));
        }
        if let Some(content_hash) = final_content_hash {
            disk_payloads.insert(content_hash.to_string(), metadata.len());
        } else {
            let is_stale = metadata
                .modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age >= REMOTE_MEDIA_TEMP_STALE_AFTER);
            atomic_temporary_files.push((path, metadata.len(), is_stale));
        }
    }

    let mut missing_url_keys = Vec::new();
    let mut content_groups: BTreeMap<String, (u64, u64, Vec<String>)> = BTreeMap::new();
    for (url_key, entry) in &index.entries {
        let Some(size) = disk_payloads.get(&entry.content_hash).copied() else {
            missing_url_keys.push(url_key.clone());
            continue;
        };
        if size != entry.size {
            missing_url_keys.push(url_key.clone());
            continue;
        }
        let group = content_groups.entry(entry.content_hash.clone()).or_insert((
            size,
            entry.last_access_ms,
            Vec::new(),
        ));
        group.1 = group.1.max(entry.last_access_ms);
        group.2.push(url_key.clone());
    }
    for key in missing_url_keys {
        index.entries.remove(&key);
    }

    let mut total = disk_payloads
        .values()
        .copied()
        .chain(atomic_temporary_files.iter().map(|(_, size, _)| *size))
        .fold(0_u64, u64::saturating_add);
    for (path, size, is_stale) in atomic_temporary_files {
        if !is_stale {
            continue;
        }
        match remove_file(&path) {
            Ok(()) => total = total.saturating_sub(size),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                total = total.saturating_sub(size);
            }
            Err(err) => log::warn!(
                "Unable to remove stale remote media atomic-write temporary file '{}': {}",
                path.display(),
                err
            ),
        }
    }
    for (content_hash, size) in &disk_payloads {
        if content_groups.contains_key(content_hash) {
            continue;
        }
        if protected_content_hash == Some(content_hash.as_str()) {
            continue;
        }
        match remove_file(&cached_content_path(cache_dir, content_hash)) {
            Ok(()) => total = total.saturating_sub(*size),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                total = total.saturating_sub(*size);
            }
            Err(err) => log::warn!(
                "Unable to remove orphaned remote media cache payload '{}': {}",
                content_hash,
                err
            ),
        }
    }

    let mut groups = content_groups.into_iter().collect::<Vec<_>>();
    groups.sort_by_key(|(_, (_, last_access_ms, _))| *last_access_ms);
    for (content_hash, (size, _, url_keys)) in groups {
        if total <= quota_bytes {
            break;
        }
        if protected_content_hash == Some(content_hash.as_str()) {
            continue;
        }
        match remove_file(&cached_content_path(cache_dir, &content_hash)) {
            Ok(()) => {
                total = total.saturating_sub(size);
                for key in url_keys {
                    index.entries.remove(&key);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                total = total.saturating_sub(size);
                for key in url_keys {
                    index.entries.remove(&key);
                }
            }
            Err(err) => log::warn!(
                "Unable to evict remote media cache payload '{}': {}",
                content_hash,
                err
            ),
        }
    }
    if total > quota_bytes {
        return Err(format!(
            "Remote media cache quota could not be enforced ({} bytes remain over the limit).",
            total.saturating_sub(quota_bytes)
        ));
    }
    write_cache_index(cache_dir, &index)?;
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn remote_media_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if remote_media_redirect_allowed(attempt.url(), attempt.previous().len()) {
                attempt.follow()
            } else {
                attempt.error("redirect left the remote media allowlist")
            }
        }))
        .build()
        .map_err(|err| format!("Unable to create remote media client: {err}"))
}

async fn download_remote_media(url: Url) -> Result<(Vec<u8>, String), String> {
    let response = remote_media_client()?
        .get(url)
        .header("accept", "image/png,image/jpeg,image/webp")
        .header("user-agent", "IntegratedModManager/3.2")
        .send()
        .await
        .map_err(|err| format!("Remote image request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Remote image returned HTTP {}", response.status()));
    }
    validate_remote_media_url(response.url().as_str())?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REMOTE_MEDIA_BYTES as u64)
    {
        return Err("Remote image exceeds the 20 MiB download limit.".to_string());
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Remote image response has no Content-Type.".to_string())?
        .to_string();
    expected_format(&content_type)?;

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("Remote image read failed: {err}"))?;
        append_remote_media_chunk(&mut body, &chunk)?;
    }
    Ok((body, content_type))
}

fn lookup_remote_media_path(
    cache_dir: &Path,
    normalized_url: &str,
) -> Result<Option<String>, String> {
    let _guard = REMOTE_MEDIA_CACHE_LOCK
        .lock()
        .map_err(|_| "Remote media cache lock is poisoned.".to_string())?;
    lookup_cached_remote_media(cache_dir, normalized_url, now_millis())
        .map(|path| path.map(|path| path.to_string_lossy().to_string()))
}

async fn resolve_remote_media_leader(
    cache_dir: &Path,
    normalized_url: &str,
    validated: Url,
) -> RemoteMediaFlightResult {
    let download_permit = REMOTE_MEDIA_DOWNLOADS
        .acquire()
        .await
        .map_err(|_| "Remote media download queue is unavailable.".to_string())?;
    if let Some(path) = lookup_remote_media_path(cache_dir, normalized_url)? {
        return Ok(path);
    }
    let (body, content_type) = download_remote_media(validated).await?;

    let decoder_permit = REMOTE_MEDIA_DECODERS
        .acquire()
        .await
        .map_err(|_| "Remote media decoder queue is unavailable.".to_string())?;
    drop(download_permit);
    let normalized_png = tauri::async_runtime::spawn_blocking(move || {
        decode_and_reencode_remote_media(&body, &content_type)
    })
    .await
    .map_err(|err| format!("Remote image decoder task failed: {err}"))??;

    let path = {
        let _guard = REMOTE_MEDIA_CACHE_LOCK
            .lock()
            .map_err(|_| "Remote media cache lock is poisoned.".to_string())?;
        if let Some(path) = lookup_cached_remote_media(cache_dir, normalized_url, now_millis())? {
            path
        } else {
            store_cached_remote_media(
                cache_dir,
                normalized_url,
                &normalized_png,
                now_millis(),
                REMOTE_MEDIA_CACHE_BYTES,
            )?
        }
    };
    drop(decoder_permit);
    Ok(path.to_string_lossy().to_string())
}

async fn wait_for_remote_media_flight(
    mut receiver: watch::Receiver<Option<RemoteMediaFlightResult>>,
) -> RemoteMediaFlightResult {
    if let Some(result) = receiver.borrow().clone() {
        return result;
    }
    tokio::time::timeout(Duration::from_secs(60), receiver.changed())
        .await
        .map_err(|_| "Remote media single-flight timed out.".to_string())?
        .map_err(|_| "Remote media single-flight ended unexpectedly.".to_string())?;
    receiver
        .borrow()
        .clone()
        .unwrap_or_else(|| Err("Remote media single-flight returned no result.".to_string()))
}

#[tauri::command]
pub async fn resolve_remote_media(
    app_handle: tauri::AppHandle,
    url: String,
) -> Result<String, String> {
    let validated = validate_remote_media_url(&url)?;
    let normalized_url = validated.to_string();
    if normalized_url.len() > MAX_REMOTE_MEDIA_URL_BYTES {
        return Err("Remote image URL exceeds the 4096-byte limit.".to_string());
    }
    let cache_dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Unable to resolve remote media cache: {err}"))?
        .join("preview-cache")
        .join("remote-media");

    if let Some(path) = lookup_remote_media_path(&cache_dir, &normalized_url)? {
        return Ok(path);
    }

    let _request_slot = REMOTE_MEDIA_REQUEST_SLOTS
        .try_acquire()
        .map_err(|_| "Remote media request queue is full.".to_string())?;
    let (leader, follower) = {
        let mut flights = REMOTE_MEDIA_FLIGHTS.lock().await;
        if let Some(sender) = flights.get(&normalized_url) {
            (None, Some(sender.subscribe()))
        } else {
            let (sender, _receiver) = watch::channel(None);
            let sender = Arc::new(sender);
            flights.insert(normalized_url.clone(), Arc::clone(&sender));
            (Some(sender), None)
        }
    };
    if let Some(receiver) = follower {
        return wait_for_remote_media_flight(receiver).await;
    }

    let result = resolve_remote_media_leader(&cache_dir, &normalized_url, validated).await;
    if let Some(sender) = leader {
        let _ = sender.send(Some(result.clone()));
    }
    REMOTE_MEDIA_FLIGHTS.lock().await.remove(&normalized_url);
    result
}

fn validate_health_segment(value: &str, label: &str, max_len: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max_len
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(format!("Invalid health check {label}."));
    }
    Ok(())
}

#[tauri::command]
pub async fn service_health_check(
    version: String,
    game: String,
    client: Option<String>,
) -> Result<ServiceHealthResponse, String> {
    validate_health_segment(&version, "version", 32)?;
    validate_health_segment(&game, "game", 16)?;
    if let Some(client) = client.as_deref() {
        validate_health_segment(client, "client", 128)?;
    }
    let client_segment = client
        .as_deref()
        .map(str::to_string)
        .unwrap_or_else(|| format!("_{}", now_millis()));
    let mut url = Url::parse("https://health.wwmm.bhatt.jp/health")
        .map_err(|err| format!("Unable to build health check URL: {err}"))?;
    url.path_segments_mut()
        .map_err(|_| "Unable to build health check URL.".to_string())?
        .extend([version.as_str(), game.as_str(), client_segment.as_str()]);

    let response = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| format!("Unable to create health check client: {err}"))?
        .get(url)
        .header("accept", "application/json")
        .header("user-agent", "IntegratedModManager/3.2")
        .send()
        .await
        .map_err(|err| format!("Health check failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Health check returned HTTP {}", response.status()));
    }
    if client.is_some() {
        return Ok(ServiceHealthResponse::default());
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Health check response has no Content-Type.".to_string())?;
    if !is_json_content_type(content_type) {
        return Err("Health check response is not JSON.".to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > 64 * 1024)
    {
        return Err("Health check response is too large.".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("Unable to read health check response: {err}"))?;
    if bytes.len() > 64 * 1024 {
        return Err("Health check response is too large.".to_string());
    }
    let result = serde_json::from_slice::<ServiceHealthResponse>(&bytes)
        .map_err(|err| format!("Invalid health check response: {err}"))?;
    if let Some(value) = result.client.as_deref() {
        validate_health_segment(value, "response client", 128)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use std::io::Cursor;

    #[test]
    fn remote_media_urls_are_limited_to_known_image_origins() {
        for url in [
            "https://images.gamebanana.com/img/ss/mods/demo.png",
            "https://images.gamebanana.com/static/img/demo.webp",
            "https://api.hakush.in/gi/UI/demo.webp",
            "https://flagsapi.com/CN/flat/64.png",
            "https://www.huihui.top/images/demo.jpg",
            "https://huihui.top/images/demo.jpg",
            "https://www.kekehxl.com/images/demo.jpg",
            "https://pic1.afdiancdn.com/user/demo/cover.png",
        ] {
            assert!(validate_remote_media_url(url).is_ok(), "{url}");
        }
        for url in [
            "http://images.gamebanana.com/img/demo.png",
            "https://files.gamebanana.com/mods/demo.zip",
            "https://images.gamebanana.com/other/demo.png",
            "https://user:pass@images.gamebanana.com/img/demo.png",
            "https://images.gamebanana.com:444/img/demo.png",
            "https://127.0.0.1/demo.png",
            "https://example.com/demo.png",
        ] {
            assert!(validate_remote_media_url(url).is_err(), "{url}");
        }

        let oversized = format!(
            "https://images.gamebanana.com/img/{}.png",
            "a".repeat(MAX_REMOTE_MEDIA_URL_BYTES)
        );
        assert!(validate_remote_media_url(&oversized).is_err());
    }

    #[test]
    fn health_content_type_requires_json() {
        assert!(is_json_content_type("application/json"));
        assert!(is_json_content_type(
            "application/problem+json; charset=utf-8"
        ));
        assert!(!is_json_content_type("text/html"));
        assert!(!is_json_content_type("image/png"));
    }

    #[test]
    fn redirects_revalidate_the_complete_media_allowlist() {
        let allowed = Url::parse("https://images.gamebanana.com/img/demo.png").unwrap();
        let wrong_path = Url::parse("https://images.gamebanana.com/other/demo.png").unwrap();
        let wrong_host = Url::parse("https://example.com/demo.png").unwrap();

        assert!(remote_media_redirect_allowed(&allowed, 0));
        assert!(!remote_media_redirect_allowed(&wrong_path, 0));
        assert!(!remote_media_redirect_allowed(&wrong_host, 0));
        assert!(!remote_media_redirect_allowed(&allowed, 5));
    }

    #[test]
    fn streamed_source_bytes_are_bounded_even_without_content_length() {
        let mut body = vec![0_u8; MAX_REMOTE_MEDIA_BYTES - 2];
        append_remote_media_chunk(&mut body, &[1, 2]).unwrap();
        let error = append_remote_media_chunk(&mut body, &[3]).unwrap_err();
        assert!(error.contains("20 MiB"));
    }

    #[test]
    fn dimensions_are_bounded_before_decode() {
        assert!(validate_remote_media_dimensions(2048, 2048).is_ok());
        assert!(validate_remote_media_dimensions(8192, 4096).is_ok());
        assert!(validate_remote_media_dimensions(8193, 1).is_err());
        assert!(validate_remote_media_dimensions(8192, 4097).is_err());
        assert!(validate_remote_media_dimensions(0, 100).is_err());
    }

    #[test]
    fn static_images_are_reencoded_as_bounded_png() {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 2, Rgba([1, 2, 3, 255])));
        let mut source = Cursor::new(Vec::new());
        image.write_to(&mut source, ImageFormat::Png).unwrap();

        let output = decode_and_reencode_remote_media(source.get_ref(), "image/png").unwrap();
        assert!(output.starts_with(&[0x89, b'P', b'N', b'G']));
        let decoded = image::load_from_memory_with_format(&output, ImageFormat::Png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2, 2));
    }

    #[test]
    fn animated_webp_is_rejected_before_decode() {
        let animated =
            b"RIFF\x14\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00\x00";
        let error = decode_and_reencode_remote_media(animated, "image/webp").unwrap_err();
        assert!(error.contains("animated WebP"));
    }

    #[test]
    fn content_hash_cache_evicts_the_least_recently_used_payload() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path();
        let first = store_cached_remote_media(
            cache_dir,
            "https://images.gamebanana.com/img/first.png",
            b"first-png",
            1,
            1024,
        )
        .unwrap();
        let second = store_cached_remote_media(
            cache_dir,
            "https://images.gamebanana.com/img/second.png",
            b"second-png",
            2,
            1024,
        )
        .unwrap();
        assert!(first.exists());
        assert!(second.exists());

        let hit =
            lookup_cached_remote_media(cache_dir, "https://images.gamebanana.com/img/first.png", 3)
                .unwrap();
        assert_eq!(hit.as_deref(), Some(first.as_path()));

        enforce_remote_media_cache_quota(cache_dir, b"first-png".len() as u64, None).unwrap();
        assert!(first.exists());
        assert!(!second.exists());
        assert!(lookup_cached_remote_media(
            cache_dir,
            "https://images.gamebanana.com/img/second.png",
            4,
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn cache_store_rolls_back_when_the_current_payload_cannot_fit() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path();
        let source_url = "https://images.gamebanana.com/img/oversized.png";

        let error = store_cached_remote_media(cache_dir, source_url, b"new-png", 1, 1)
            .expect_err("protected current payload must not be evicted and returned");

        assert!(error.contains("quota could not be enforced"));
        assert!(lookup_cached_remote_media(cache_dir, source_url, 2)
            .unwrap()
            .is_none());
        assert_eq!(
            fs::read_dir(cache_dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "png"))
                .count(),
            0
        );
    }

    #[test]
    fn undeletable_orphan_payload_still_counts_toward_the_quota() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path();
        let orphan_hash = sha256_hex(b"orphan-png");
        let orphan_path = cached_content_path(cache_dir, &orphan_hash);
        fs::write(&orphan_path, b"orphan-png").unwrap();
        let blocked_path = orphan_path.clone();

        let error = enforce_remote_media_cache_quota_with(
            cache_dir,
            1,
            None,
            move |path| {
                if path == blocked_path {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "simulated Windows file lock",
                    ))
                } else {
                    fs::remove_file(path)
                }
            },
            SystemTime::now(),
        )
        .expect_err("an orphan that remains on disk must count toward the hard quota");

        assert!(error.contains("quota could not be enforced"));
        assert!(orphan_path.exists());
    }

    #[test]
    fn recent_atomic_write_temporary_files_count_toward_the_quota() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path();
        let payload_temp = cache_dir.join(format!(".{}.png.ABC123", sha256_hex(b"payload")));
        let index_temp = cache_dir.join(".index.json.XYZ789");
        fs::write(&payload_temp, b"payload-temp").unwrap();
        fs::write(&index_temp, b"index-temp").unwrap();

        let error = enforce_remote_media_cache_quota_with(
            cache_dir,
            1,
            None,
            |_| panic!("recent atomic-write temporary files must not be deleted"),
            SystemTime::now(),
        )
        .expect_err("recent atomic-write temporary files must consume the hard quota");

        assert!(error.contains("quota could not be enforced"));
        assert!(payload_temp.exists());
        assert!(index_temp.exists());
    }

    #[test]
    fn cache_store_preflight_blocks_before_writing_when_recent_temps_fill_the_quota() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path();
        let payload_temp = cache_dir.join(format!(".{}.png.ABC123", sha256_hex(b"payload")));
        fs::write(&payload_temp, b"payload-temp").unwrap();
        let source_url = "https://images.gamebanana.com/img/preflight.png";

        let error = store_cached_remote_media(
            cache_dir,
            source_url,
            b"new-png",
            1,
            b"payload-temp".len() as u64,
        )
        .expect_err("preflight must reserve quota before opening a new atomic payload write");

        assert!(error.contains("quota could not be enforced"));
        assert!(payload_temp.exists());
        assert!(lookup_cached_remote_media(cache_dir, source_url, 2)
            .unwrap()
            .is_none());
    }

    #[test]
    fn stale_atomic_write_temporary_files_are_safely_reclaimed() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path();
        let payload_temp = cache_dir.join(format!(".{}.png.ABC123", sha256_hex(b"payload")));
        let index_temp = cache_dir.join(".index.json.XYZ789");
        fs::write(&payload_temp, b"payload-temp").unwrap();
        fs::write(&index_temp, b"index-temp").unwrap();
        let modified = fs::metadata(&payload_temp).unwrap().modified().unwrap();
        let after_stale_threshold =
            modified + REMOTE_MEDIA_TEMP_STALE_AFTER + Duration::from_secs(1);

        enforce_remote_media_cache_quota_with(
            cache_dir,
            1,
            None,
            |path| fs::remove_file(path),
            after_stale_threshold,
        )
        .unwrap();

        assert!(!payload_temp.exists());
        assert!(!index_temp.exists());
    }

    #[test]
    fn invalid_cache_hash_cannot_escape_the_cache_directory() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path().join("cache");
        fs::create_dir_all(&cache_dir).unwrap();
        let outside = temp.path().join("outside.png");
        fs::write(&outside, b"keep").unwrap();
        let malicious = serde_json::json!({
            "schemaVersion": REMOTE_MEDIA_CACHE_SCHEMA,
            "entries": {
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {
                    "contentHash": "../outside",
                    "size": 4,
                    "lastAccessMs": 1
                }
            }
        });
        fs::write(
            cache_index_path(&cache_dir),
            serde_json::to_vec(&malicious).unwrap(),
        )
        .unwrap();

        enforce_remote_media_cache_quota(&cache_dir, REMOTE_MEDIA_CACHE_BYTES, None).unwrap();

        assert_eq!(fs::read(outside).unwrap(), b"keep");
        assert!(read_cache_index(&cache_dir).entries.is_empty());
    }

    #[test]
    fn oversized_or_overpopulated_cache_indexes_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path();
        let index_path = cache_index_path(cache_dir);
        fs::File::create(&index_path)
            .unwrap()
            .set_len(MAX_REMOTE_MEDIA_INDEX_BYTES + 1)
            .unwrap();
        assert!(read_cache_index(cache_dir).entries.is_empty());

        let entries = (0..=MAX_REMOTE_MEDIA_INDEX_ENTRIES)
            .map(|index| {
                let key = format!("{index:064x}");
                (
                    key.clone(),
                    RemoteMediaCacheEntry {
                        content_hash: key,
                        size: 1,
                        last_access_ms: index as u64,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        let overpopulated = RemoteMediaCacheIndex {
            schema_version: REMOTE_MEDIA_CACHE_SCHEMA,
            entries,
        };
        fs::write(&index_path, serde_json::to_vec(&overpopulated).unwrap()).unwrap();
        assert!(read_cache_index(cache_dir).entries.is_empty());
    }

    #[tokio::test]
    async fn single_flight_followers_receive_the_leader_result() {
        let (sender, receiver) = watch::channel(None);
        sender
            .send(Some(Ok("cached.png".to_string())))
            .expect("publish leader result");

        assert_eq!(
            wait_for_remote_media_flight(receiver).await.unwrap(),
            "cached.png"
        );
    }

    #[test]
    fn remote_media_request_and_decoder_queues_are_hard_bounded() {
        let request_slots = Semaphore::new(MAX_REMOTE_MEDIA_REQUESTS);
        let permits = (0..MAX_REMOTE_MEDIA_REQUESTS)
            .map(|_| request_slots.try_acquire().expect("request slot"))
            .collect::<Vec<_>>();
        assert!(request_slots.try_acquire().is_err());
        drop(permits);

        let decoders = Semaphore::new(1);
        let decoder = decoders.try_acquire().expect("decoder slot");
        assert!(decoders.try_acquire().is_err());
        drop(decoder);
    }
}

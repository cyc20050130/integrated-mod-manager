use futures_util::StreamExt;
use once_cell::sync::Lazy;
use reqwest::Client;
use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;
use std::collections::{HashMap, HashSet};
use std::fs::{remove_file, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_tracing::{tracing, Builder as Tracing, LevelFilter, MaxFileSize, Rotation, RotationStrategy};
use tokio::time::{sleep, timeout};

mod hotreload;
mod image_server;
mod logger_utils;

const PROGRESS_UPDATE_THRESHOLD: u64 = 1024;
const BUFFER_SIZE: usize = 8192;
const IMAGE_SERVER_PORT: u16 = 1469;
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 10;
const DEFAULT_STALL_TIMEOUT_SECS: u64 = 25;
const DEFAULT_REQUEST_RETRIES: u32 = 3;
const DEFAULT_PROGRESS_INTERVAL_MS: u64 = 700;
const DEFAULT_BACKOFF_BASE_MS: u64 = 2000;
const DEFAULT_MAX_CONCURRENT_EXTRACTS: usize = 2;
const PREVIEW_IDLE_WAIT_TIMEOUT_SECS: u64 = 90;
const PREVIEW_IDLE_POLL_MS: u64 = 250;
const LOW_SPEED_THRESHOLD_BPS: f64 = 48.0 * 1024.0;
const LOW_SPEED_GRACE_SECS: u64 = 12;

#[derive(Serialize, Clone)]
struct DownloadProgress {
    downloaded: f64,
    total: f64,
    speed: String,
    eta: String,
    key: String,
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

/// Check if a directory is empty
fn is_directory_empty(path: &Path) -> Result<bool, std::io::Error> {
    if !path.exists() || !path.is_dir() {
        return Ok(true); // Consider non-existent or non-directory as "empty"
    }

    let mut entries = std::fs::read_dir(path)?;
    Ok(entries.next().is_none())
}

/// Safely remove a file, only if the parent directory would become empty
fn safe_remove_file(file_path: &Path) -> Result<(), String> {
    if !file_path.exists() {
        return Ok(());
    }

    // Get the parent directory
    if let Some(parent_dir) = file_path.parent() {
        // First remove the file
        remove_file(file_path).map_err(|e| e.to_string())?;

        // Then check if the parent directory is empty and remove it if so
        if is_directory_empty(parent_dir).map_err(|e| e.to_string())? {
            if let Err(e) = std::fs::remove_dir(parent_dir) {
                tracing::warn!("Could not remove empty directory {:?}: {}", parent_dir, e);
                // Don't return error here, as the main file removal succeeded
            }
        }
    } else {
        // No parent directory, just remove the file
        remove_file(file_path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Clean folder before extraction, keeping only preview files and the target archive
fn clean_folder_before_extraction(
    folder_path: &Path,
    archive_file_name: &str,
) -> Result<(), String> {
    let entries = std::fs::read_dir(folder_path).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_path = entry.path();

        if file_path.is_file() {
            let file_name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("");

            // Keep the archive file itself
            if file_name == archive_file_name {
                continue;
            }

            // Keep preview files (preview.* with any extension)
            if file_name.starts_with("preview.") {
                continue;
            }

            // Delete everything else
            tracing::info!("Cleaning up file before extraction: {}", file_name);
            if let Err(e) = std::fs::remove_file(&file_path) {
                tracing::warn!("Failed to remove file {}: {}", file_name, e);
            }
        } else if file_path.is_dir() {
            let dir_name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("");

            // Delete all directories
            tracing::info!("Cleaning up directory before extraction: {}", dir_name);
            if let Err(e) = std::fs::remove_dir_all(&file_path) {
                tracing::warn!("Failed to remove directory {}: {}", dir_name, e);
            }
        }
    }

    Ok(())
}

static SESSION_ID: AtomicU64 = AtomicU64::new(0);
static DOWNLOAD_COUNTS: Lazy<Mutex<HashMap<String, u64>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static CANCELLED_DOWNLOADS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static ACTIVE_EXTRACTIONS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_PREVIEW_DOWNLOADS: AtomicUsize = AtomicUsize::new(0);

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
        let cmp = left_parts.get(index).copied().unwrap_or(0).cmp(
            &right_parts.get(index).copied().unwrap_or(0),
        );
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

    let exe_path = find_fixer_exe(&runtime_version_dir, 5)
        .ok_or_else(|| format!("Bundled Wuwa Mod Fixer executable not found in {:?}", runtime_version_dir))?;

    Ok(BundledToolInfo {
        version,
        exe_path: exe_path.to_string_lossy().to_string(),
        source_path: bundled_version_dir.to_string_lossy().to_string(),
    })
}

async fn decompress_file(app_handle: tauri::AppHandle, file_path: &str, save_path: &str) -> Result<(), String> {
   let program_path = app_handle
    .path()
    .resolve("ext/7z.exe", tauri::path::BaseDirectory::Resource)
    .map_err(|e| e.to_string())?;

let output = app_handle
    .shell()
    .command(program_path.to_str().unwrap())
    .args([
        "x", 
        file_path, 
        &format!("-o{}", save_path),
        "-y"
    ])
    .output()
    .await
    .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        Err(if err.is_empty() { 
            String::from_utf8_lossy(&output.stdout).to_string() 
        } else { 
            err.to_string() 
        })
    }
}
/// Extract archive file (zip, rar, or 7z) to the specified path
#[tauri::command]
async fn extract_archive(
    app_handle: tauri::AppHandle,
    file_path: String,
    save_path: String,
    file_name: String,
    emit: bool,
    key: String,
    current_sid: u64,
    del: bool,
    max_concurrent_extracts: Option<usize>,
) -> Result<(), String> {
    let file_path = Path::new(&file_path);
    let save_path = save_path.as_str();
    let file_name = file_name.as_str();

    let _extract_slot = acquire_extraction_slot(
        max_concurrent_extracts.unwrap_or(DEFAULT_MAX_CONCURRENT_EXTRACTS),
    )
    .await;

    // Clean folder before extraction
    println!("Cleaning folder before extracting archive");
    clean_folder_before_extraction(Path::new(&save_path), &file_name)?;
    println!("Starting extraction");
    let before = Instant::now();
    decompress_file(app_handle.clone(), file_path.to_str().unwrap(), &save_path)
        .await
        .map_err(|e| format!("Extraction failed: {}", e))?;
    let duration = before.elapsed();
    println!("extraction completed in: {:.2?}", duration);
    if del {
        safe_remove_file(&file_path)?;
        println!("Archive file removed after extraction");
    }
    
    if !del {
        app_handle
            .emit("fin", serde_json::json!({ "key": key, "type": "manual" }))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    if emit {
        // let global_sid = SESSION_ID.load(Ordering::SeqCst);
        let mut valid = false;
        {
            let counts = DOWNLOAD_COUNTS.lock().unwrap();
            if let Some(&count) = counts.get(&key) {
                if count >= 1 {
                    valid = true;
                }
            }
        }
        if valid {
            decrement_download_count(&key);
        }
        tracing::info!(
            "Emitting completion event for session {}: {}",
            current_sid,
            file_name
        );
        if !valid {
            println!(
                "Session {} invalid after extraction for key '{}'",
                valid, key
            );
            return Err(format!(
                "Session changed during processing, operation cancelled (file: {})",
                file_name
            ));
        }
        app_handle
            .emit("fin", serde_json::json!({ "key": key , "type": "auto" }))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
async fn download_and_unzip(
    app_handle: tauri::AppHandle,
    file_name: String,
    download_url: String,
    save_path: String,
    key: String,
    emit: bool,
    download_options: Option<DownloadOptions>,
) -> Result<(), String> {
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
        wait_for_primary_downloads_to_idle(Duration::from_secs(
            PREVIEW_IDLE_WAIT_TIMEOUT_SECS,
        ))
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
        options.request_retries.unwrap_or(DEFAULT_REQUEST_RETRIES).max(1)
    } else {
        options
            .request_retries
            .unwrap_or(DEFAULT_REQUEST_RETRIES)
            .max(1)
            .min(2)
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
    let backoff_base_ms = options.backoff_base_ms.unwrap_or(DEFAULT_BACKOFF_BASE_MS).max(100);
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
    let save_dir_path = Path::new(&save_path);
    if let Err(e) = std::fs::create_dir_all(save_dir_path) {
        last_error = format!(
            "Failed to create download directory '{}': {}",
            save_path, e
        );
        last_error_stage = "filesystem".to_string();
    }
    let temp_file_path = Path::new(&save_path).join(format!("{}.part", file_name));

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

        if let Err(e) = std::fs::create_dir_all(save_dir_path) {
            last_error = format!(
                "Failed to ensure download directory '{}' exists: {}",
                save_path, e
            );
            last_error_stage = "filesystem".to_string();
            break;
        }

        let client = match Client::builder()
            .connect_timeout(connect_timeout)
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

        let resume_from = std::fs::metadata(&temp_file_path)
            .map(|m| m.len())
            .unwrap_or(0);

        let mut request = client.get(&download_url);
        if resume_from > 0 {
            request = request.header(RANGE, format!("bytes={}-", resume_from));
        }

        let response = match request.send().await {
            Ok(res) => res,
            Err(e) => {
                last_error = e.to_string();
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

        let ext = response
            .url()
            .path_segments()
            .and_then(|segments| segments.last())
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

        let final_file_path = Path::new(&save_path).join(&resolved_file_name);
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
        let mut low_speed_since: Option<Instant> = None;
        let mut emit_window_start = Instant::now();
        let mut emit_window_bytes: u64 = 0;
        let mut attempt_error: Option<String> = None;
        let mut attempt_error_stage = "download".to_string();
        let mut resume_retry_requested = false;

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

                let transferred_since_resume = downloaded.saturating_sub(effective_resume_from);
                if transferred_since_resume > 128 * 1024 && rolling_speed_bps > 0.0 {
                    if rolling_speed_bps < LOW_SPEED_THRESHOLD_BPS {
                        if let Some(since) = low_speed_since {
                            if since.elapsed() >= Duration::from_secs(LOW_SPEED_GRACE_SECS) {
                                attempt_error = Some(format!(
                                    "Low speed persisted below {:.0} KB/s, reconnecting",
                                    LOW_SPEED_THRESHOLD_BPS / 1024.0
                                ));
                                resume_retry_requested = true;
                                break;
                            }
                        } else {
                            low_speed_since = Some(Instant::now());
                        }
                    } else {
                        low_speed_since = None;
                    }
                }
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
                let _ = app_handle.emit("download-progress", progress_data);
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
                break;
            }
            if last_error.contains("session change") {
                let _ = remove_file(&temp_file_path);
                break;
            }

            if attempt < retries && last_error_stage == "download" {
                let backoff = compute_backoff_ms(attempt, resume_retry_requested);
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

        tracing::info!(
            "Download completed for '{}': {} in {:.2}s (Avg Speed: {})",
            resolved_file_name,
            format_bytes(downloaded),
            total_elapsed,
            format_speed(avg_speed)
        );

        if !emit {
            clear_cancelled_download(&key);
            return Ok(());
        }

        if emit {
            let final_total = if total_size > 0 { total_size } else { downloaded };
            let _ = app_handle.emit(
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

        if let Err(e) = extract_archive(
            app_handle.clone(),
            final_file_path.to_string_lossy().to_string(),
            save_path.clone(),
            resolved_file_name.clone(),
            emit,
            key.clone(),
            current_sid,
            true,
            Some(max_extracts),
        )
        .await
        {
            last_error = e;
            if emit {
                let _ = app_handle.emit(
                    "download-error",
                    DownloadErrorEvent {
                        key: key.clone(),
                        message: last_error.clone(),
                        stage: "extract".to_string(),
                        attempt,
                        max_attempts: retries,
                    },
                );
            }
            decrement_download_count(&key);
            clear_cancelled_download(&key);
            return Err(last_error);
        }

        clear_cancelled_download(&key);
        return Ok(());
    }

    if emit {
        let _ = app_handle.emit(
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
    decrement_download_count(&key);
    clear_cancelled_download(&key);
    Err(last_error)
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
fn get_image_server_url() -> String {
    format!("http://127.0.0.1:{}", IMAGE_SERVER_PORT)
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

#[tauri::command]
fn request_app_restart(app_handle: tauri::AppHandle) {
    app_handle.request_restart();
}

#[tauri::command]
fn execute_with_args(exe_path: String, args: Vec<String>) -> Result<String, String> {
    if !Path::new(&exe_path).exists() {
        return Err(format!("Executable not found: {}", exe_path));
    }

    let mut command = Command::new(&exe_path);

    for arg in &args {
        command.arg(arg);
    }

    match command.spawn() {
        Ok(child) => {
            tracing::info!(
                "Successfully started process: {} with args: {:?}",
                exe_path,
                args
            );
            Ok(format!(
                "Process started successfully with PID: {}",
                child.id()
            ))
        }
        Err(e) => {
            tracing::error!("Failed to start process {}: {}", exe_path, e);
            Err(format!("Failed to start process: {}", e))
        }
    }
}

#[tauri::command]
async fn create_symlink(link_path: String, target_path: String) -> Result<(), String> {
    // First, check if the target path exists
    let target_metadata = std::fs::metadata(&target_path).map_err(|e| e.to_string())?;

    // Use platform-specific functions
    #[cfg(windows)]
    {
        if target_metadata.is_dir() {
            // On Windows, use symlink_dir for directories
            std::os::windows::fs::symlink_dir(&target_path, &link_path)
                .map_err(|e| e.to_string())?;
        } else {
            // and symlink_file for files
            std::os::windows::fs::symlink_file(&target_path, &link_path)
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(unix)]
    {
        // On Unix-like systems, symlink works for both files and directories
        std::os::unix::fs::symlink(&target_path, &link_path).map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(windows, unix)))]
    {
        return Err("Symbolic links are not supported on this platform.".to_string());
    }

    Ok(())
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
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            Tracing::new()
                .with_max_level(
                    if cfg!(debug_assertions) {
                        LevelFilter::DEBUG
                    } else {
                        LevelFilter::INFO
                    }
                )
                .with_file_logging()
                .with_rotation(Rotation::Daily)
                .with_rotation_strategy(RotationStrategy::KeepSome(10))
                .with_max_file_size(MaxFileSize::mb(25))
                .with_default_subscriber()
                .build()
        )
        .plugin(
            Builder::default()
                // sets the flags to only track and restore size
                .with_state_flags(StateFlags::SIZE)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|_app, argv, _cwd| {
            println!("a new app instance was opened with {argv:?} and the deep link event was already triggered");
            // when defining deep link schemes at runtime, you must also check `argv` here
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            #[cfg(desktop)]
            app.deep_link().register_all()?;
            tauri::async_runtime::spawn(async move {
                if let Err(e) = image_server::start_image_server(IMAGE_SERVER_PORT).await {
                    tracing::error!("Failed to start image server: {}", e);

                    if let Err(emit_err) = app_handle.emit(
                        "image-server-error",
                        format!("Failed to start image server: {}", e),
                    ) {
                        tracing::error!("Failed to emit image server error: {}", emit_err);
                    }
                } else {
                    tracing::info!(
                        "Image server started successfully on port {}",
                        IMAGE_SERVER_PORT
                    );

                    if let Err(emit_err) =
                        app_handle.emit("image-server-ready", get_image_server_url())
                    {
                        tracing::error!("Failed to emit image server ready event: {}", emit_err);
                    }
                }
            });
            #[cfg(target_os = "windows")]
            if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")) { let _ = app.get_webview_window("main").unwrap().set_icon(icon); }
            // let tray_icon = if cfg!(target_os = "windows") { tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))? } else { app.default_window_icon().unwrap().clone() };
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            exit_app,
            get_username,
            download_and_unzip,
            cancel_extract,
            cancel_download,
            get_image_server_url,
            get_session_id,
            get_runtime_data_dir,
            ensure_bundled_wuwa_mod_fixer,
            request_app_restart,
            execute_with_args,
            create_symlink,
            extract_archive,
            set_window_icon,
            logger_utils::open_logs_folder,
            hotreload::set_hotreload,
            hotreload::start_window_monitoring,
            hotreload::stop_window_monitoring,
            hotreload::set_change,
            hotreload::focus_mod_manager_send_f10_return_to_game,
            hotreload::set_window_target,
            hotreload::is_game_process_running
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

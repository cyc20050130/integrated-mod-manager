// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(not(dev))]
use std::env;
#[cfg(all(not(dev), target_os = "windows"))]
use serde_json::{Map, Value};
#[cfg(all(not(dev), target_os = "windows"))]
use std::collections::HashSet;
#[cfg(all(not(dev), target_os = "windows"))]
use std::fs;
#[cfg(all(not(dev), target_os = "windows"))]
use std::io;
#[cfg(all(not(dev), target_os = "windows"))]
use std::path::{Path, PathBuf};
#[cfg(all(not(dev), target_os = "windows"))]
use std::time::UNIX_EPOCH;
#[cfg(all(not(dev), not(target_os = "windows")))]
use std::path::{Path, PathBuf};

#[cfg(all(not(dev), target_os = "windows"))]
const RUNTIME_DATA_DIR_NAME: &str = "Integrated Mod Manager (IMM) Data";
#[cfg(all(not(dev), target_os = "windows"))]
const LEGACY_RUNTIME_DIR_NAME: &str = "Integrated Mod Manager (IMM)";
#[cfg(all(not(dev), target_os = "windows"))]
fn path_priority(path: &Path, preferred_sources: &[PathBuf], backup_roots: &[PathBuf]) -> usize {
    if let Some(index) = preferred_sources.iter().position(|source| path.starts_with(source)) {
        return index;
    }
    preferred_sources.len()
        + backup_roots
            .iter()
            .position(|source| path.starts_with(source))
            .unwrap_or(backup_roots.len())
}

#[cfg(all(not(dev), target_os = "windows"))]
fn collect_backup_paths(file_name: &str, backup_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let exact_matches = [
        format!("AUTO_{file_name}.bak"),
        format!("AUTO_{file_name}.bak.bak"),
    ];

    for backup_root in backup_roots {
        let entries = match fs::read_dir(backup_root) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(file_type) if file_type.is_file() => file_type,
                _ => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let matches_exact = exact_matches.iter().any(|candidate| candidate == &name);
            let matches_manual =
                name.ends_with(&format!("_{file_name}.bak")) || name.ends_with(&format!("_{file_name}.bak.bak"));
            if file_type.is_file() && (matches_exact || matches_manual) {
                candidates.push(entry.path());
            }
        }
    }

    candidates.sort_by(|left, right| modified_secs(right).cmp(&modified_secs(left)));
    candidates
}

#[cfg(all(not(dev), target_os = "windows"))]
fn collect_config_paths(file_name: &str, preferred_sources: &[PathBuf], backup_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for source in preferred_sources {
        let path = source.join(file_name);
        if path.exists() {
            candidates.push(path);
        }
    }
    candidates.extend(collect_backup_paths(file_name, backup_roots));
    candidates
}

#[cfg(all(not(dev), target_os = "windows"))]
fn modified_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(all(not(dev), target_os = "windows"))]
fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(all(not(dev), target_os = "windows"))]
fn write_json(path: &Path, value: &Value) -> io::Result<()> {
    let payload =
        serde_json::to_vec_pretty(value).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    fs::write(path, payload)
}

#[cfg(all(not(dev), target_os = "windows"))]
fn is_non_empty_string(value: &Value) -> bool {
    value
        .as_str()
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false)
}

#[cfg(all(not(dev), target_os = "windows"))]
fn value_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
}

#[cfg(all(not(dev), target_os = "windows"))]
fn merge_fill_missing(dst: &mut Value, src: &Value) {
    if dst.is_null() {
        *dst = src.clone();
        return;
    }

    match (dst, src) {
        (Value::Object(dst_obj), Value::Object(src_obj)) => {
            for (key, src_value) in src_obj {
                match dst_obj.get_mut(key) {
                    Some(dst_value) => merge_fill_missing(dst_value, src_value),
                    None => {
                        dst_obj.insert(key.clone(), src_value.clone());
                    }
                }
            }
        }
        (Value::Array(dst_arr), Value::Array(src_arr)) => {
            if dst_arr.is_empty() && !src_arr.is_empty() {
                *dst_arr = src_arr.clone();
            }
        }
        (Value::String(dst_str), Value::String(src_str)) => {
            if dst_str.trim().is_empty() && !src_str.trim().is_empty() {
                *dst_str = src_str.clone();
            }
        }
        _ => {}
    }
}

#[cfg(all(not(dev), target_os = "windows"))]
fn merge_string_array(dst: &mut Value, src: &Value) {
    match (dst, src) {
        (Value::Array(dst_arr), Value::Array(src_arr)) => {
            let mut seen = HashSet::new();
            for entry in dst_arr.iter() {
                if let Some(text) = entry.as_str() {
                    seen.insert(text.to_string());
                }
            }
            for entry in src_arr {
                if let Some(text) = entry.as_str() {
                    if seen.insert(text.to_string()) {
                        dst_arr.push(Value::String(text.to_string()));
                    }
                }
            }
        }
        (slot @ Value::Null, Value::Array(_)) => *slot = src.clone(),
        _ => {}
    }
}

#[cfg(all(not(dev), target_os = "windows"))]
fn merge_mod_data_entry(dst: &mut Value, src: &Value) {
    let Some(src_obj) = src.as_object() else {
        return;
    };
    if !dst.is_object() {
        *dst = src.clone();
        return;
    }
    let dst_obj = dst.as_object_mut().expect("validated object");

    for key in ["source", "note", "namespace"] {
        if let Some(src_value) = src_obj.get(key) {
            merge_fill_missing(dst_obj.entry(key.to_string()).or_insert(Value::Null), src_value);
        }
    }

    for key in ["updatedAt", "viewedAt"] {
        if let Some(src_value) = src_obj.get(key).and_then(value_to_i64) {
            let replace = dst_obj
                .get(key)
                .and_then(value_to_i64)
                .map(|dst_value| src_value > dst_value)
                .unwrap_or(true);
            if replace {
                dst_obj.insert(key.to_string(), Value::from(src_value));
            }
        }
    }

    if let Some(src_tags) = src_obj.get("tags") {
        merge_string_array(dst_obj.entry("tags".to_string()).or_insert(Value::Null), src_tags);
    }
    if let Some(src_vars) = src_obj.get("vars") {
        merge_fill_missing(dst_obj.entry("vars".to_string()).or_insert(Value::Null), src_vars);
    }
    if let Some(src_crop) = src_obj.get("crop") {
        merge_fill_missing(dst_obj.entry("crop".to_string()).or_insert(Value::Null), src_crop);
    }
}

#[cfg(all(not(dev), target_os = "windows"))]
fn merge_mod_data_map(dst: &mut Value, src: &Value) {
    let Some(src_obj) = src.as_object() else {
        return;
    };
    if !dst.is_object() {
        *dst = src.clone();
        return;
    }
    let dst_obj = dst.as_object_mut().expect("validated object");
    for (mod_path, src_entry) in src_obj {
        match dst_obj.get_mut(mod_path) {
            Some(dst_entry) => merge_mod_data_entry(dst_entry, src_entry),
            None => {
                dst_obj.insert(mod_path.clone(), src_entry.clone());
            }
        }
    }
}

#[cfg(all(not(dev), target_os = "windows"))]
fn merge_named_array(dst: &mut Value, src: &Value, field: &str) {
    let Some(src_arr) = src.as_array() else {
        return;
    };
    if !dst.is_array() {
        *dst = src.clone();
        return;
    }
    let dst_arr = dst.as_array_mut().expect("validated array");
    let mut seen = HashSet::new();
    for entry in dst_arr.iter() {
        if let Some(key) = entry
            .as_object()
            .and_then(|obj| obj.get(field))
            .and_then(Value::as_str)
        {
            seen.insert(key.to_string());
        }
    }
    for entry in src_arr {
        let Some(key) = entry
            .as_object()
            .and_then(|obj| obj.get(field))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if seen.insert(key.to_string()) {
            dst_arr.push(entry.clone());
        }
    }
}

#[cfg(all(not(dev), target_os = "windows"))]
fn download_item_key(item: &Value) -> String {
    let Some(obj) = item.as_object() else {
        return item.to_string();
    };
    let source = obj.get("source").and_then(Value::as_str).unwrap_or("");
    let file = obj.get("file").and_then(Value::as_str).unwrap_or("");
    let fname = obj.get("fname").and_then(Value::as_str).unwrap_or("");
    let path = obj.get("path").and_then(Value::as_str).unwrap_or("");
    let updated = obj.get("updated").and_then(value_to_i64).unwrap_or_default();
    format!("{source}::{file}::{fname}::{path}::{updated}")
}

#[cfg(all(not(dev), target_os = "windows"))]
fn merge_download_item(dst: &mut Value, src: &Value) {
    let Some(src_obj) = src.as_object() else {
        return;
    };
    if !dst.is_object() {
        *dst = src.clone();
        return;
    }
    let dst_obj = dst.as_object_mut().expect("validated object");

    for key in [
        "displayName",
        "safeName",
        "source",
        "file",
        "fname",
        "path",
        "dlPath",
        "key",
        "lastError",
    ] {
        if let Some(src_value) = src_obj.get(key) {
            merge_fill_missing(dst_obj.entry(key.to_string()).or_insert(Value::Null), src_value);
        }
    }

    for key in ["updatedAt", "updated", "requeueRounds", "createdAt", "lastTriedAt"] {
        if let Some(src_value) = src_obj.get(key).and_then(value_to_i64) {
            let replace = dst_obj
                .get(key)
                .and_then(value_to_i64)
                .map(|dst_value| src_value > dst_value)
                .unwrap_or(true);
            if replace {
                dst_obj.insert(key.to_string(), Value::from(src_value));
            }
        }
    }

    for key in ["status", "category", "name", "preview"] {
        if let Some(src_value) = src_obj.get(key) {
            merge_fill_missing(dst_obj.entry(key.to_string()).or_insert(Value::Null), src_value);
        }
    }
}

#[cfg(all(not(dev), target_os = "windows"))]
fn merge_download_section(dst: &mut Value, src: &Value) {
    let Some(src_arr) = src.as_array() else {
        return;
    };
    if !dst.is_array() {
        *dst = src.clone();
        return;
    }
    let dst_arr = dst.as_array_mut().expect("validated array");
    for src_item in src_arr {
        let src_key = download_item_key(src_item);
        if let Some(dst_item) = dst_arr.iter_mut().find(|item| download_item_key(item) == src_key) {
            merge_download_item(dst_item, src_item);
        } else {
            dst_arr.push(src_item.clone());
        }
    }
}

#[cfg(all(not(dev), target_os = "windows"))]
fn merge_downloads(dst: &mut Value, src: &Value) {
    let Some(src_obj) = src.as_object() else {
        return;
    };
    if !dst.is_object() {
        *dst = src.clone();
        return;
    }
    let dst_obj = dst.as_object_mut().expect("validated object");
    for key in ["queue", "downloading", "extracting", "completed", "failed"] {
        if let Some(src_value) = src_obj.get(key) {
            merge_download_section(dst_obj.entry(key.to_string()).or_insert(Value::Array(Vec::new())), src_value);
        }
    }
}

#[cfg(all(not(dev), target_os = "windows"))]
fn merge_game_config(dst: &mut Value, src: &Value) {
    let Some(src_obj) = src.as_object() else {
        return;
    };
    if !dst.is_object() {
        *dst = src.clone();
        return;
    }
    let dst_obj = dst.as_object_mut().expect("validated object");

    for key in ["version", "game", "custom", "sourceDir", "targetDir", "updatedAt"] {
        if let Some(src_value) = src_obj.get(key) {
            merge_fill_missing(dst_obj.entry(key.to_string()).or_insert(Value::Null), src_value);
        }
    }
    if let Some(src_settings) = src_obj.get("settings") {
        merge_fill_missing(dst_obj.entry("settings".to_string()).or_insert(Value::Null), src_settings);
    }
    if let Some(src_data) = src_obj.get("data") {
        merge_mod_data_map(dst_obj.entry("data".to_string()).or_insert(Value::Object(Map::new())), src_data);
    }
    if let Some(src_downloads) = src_obj.get("downloads") {
        merge_downloads(
            dst_obj.entry("downloads".to_string()).or_insert(Value::Object(Map::new())),
            src_downloads,
        );
    }
    if let Some(src_presets) = src_obj.get("presets") {
        merge_named_array(
            dst_obj.entry("presets".to_string()).or_insert(Value::Array(Vec::new())),
            src_presets,
            "name",
        );
    }
    if let Some(src_categories) = src_obj.get("categories") {
        merge_named_array(
            dst_obj.entry("categories".to_string()).or_insert(Value::Array(Vec::new())),
            src_categories,
            "_sName",
        );
    }
}

#[cfg(all(not(dev), target_os = "windows"))]
fn merge_config_file(path: &Path, preferred_sources: &[PathBuf], backup_roots: &[PathBuf], global_file: bool) {
    let file_name = match path.file_name().and_then(|name| name.to_str()) {
        Some(file_name) => file_name,
        None => return,
    };
    let mut candidates = collect_config_paths(file_name, preferred_sources, backup_roots)
        .into_iter()
        .filter_map(|source_path| {
            let is_backup = backup_roots.iter().any(|root| source_path.starts_with(root));
            let mut value = read_json(&source_path)?;
            if is_backup && !global_file {
                if let Some(obj) = value.as_object_mut() {
                    obj.remove("downloads");
                }
            }
            let score = if global_file {
                usize::from(is_non_empty_string(value.get("game").unwrap_or(&Value::Null))) * 100
                    + usize::from(is_non_empty_string(value.get("lang").unwrap_or(&Value::Null))) * 10
            } else {
                value
                    .get("data")
                    .and_then(Value::as_object)
                    .map(|entries| entries.len())
                    .unwrap_or(0)
                    * 10_000
                    + if is_backup {
                        0
                    } else {
                        value
                            .get("downloads")
                            .and_then(Value::as_object)
                            .map(|downloads| {
                                ["queue", "downloading", "extracting", "completed", "failed"]
                                    .iter()
                                    .map(|key| {
                                        downloads
                                            .get(*key)
                                            .and_then(Value::as_array)
                                            .map(|items| items.len())
                                            .unwrap_or(0)
                                    })
                                    .sum::<usize>()
                            })
                            .unwrap_or(0)
                            * 100
                    }
                    + value
                        .get("presets")
                        .and_then(Value::as_array)
                        .map(|items| items.len())
                        .unwrap_or(0)
                        * 10
                    + value
                        .get("categories")
                        .and_then(Value::as_array)
                        .map(|items| items.len())
                        .unwrap_or(0)
            };
            Some((
                value,
                score,
                modified_secs(&source_path),
                path_priority(&source_path, preferred_sources, backup_roots),
            ))
        })
        .collect::<Vec<_>>();

    let mut merged = read_json(path).or_else(|| {
        candidates
            .iter()
            .min_by(|left, right| {
                left.3
                    .cmp(&right.3)
                    .then_with(|| right.1.cmp(&left.1))
                    .then_with(|| right.2.cmp(&left.2))
            })
            .map(|candidate| candidate.0.clone())
    });

    let Some(mut merged_value) = merged.take() else {
        return;
    };

    candidates.sort_by(|left, right| {
        left.3
            .cmp(&right.3)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| right.2.cmp(&left.2))
    });
    for (value, _, _, _) in candidates {
        if global_file {
            merge_fill_missing(&mut merged_value, &value);
        } else {
            merge_game_config(&mut merged_value, &value);
        }
    }

    let _ = write_json(path, &merged_value);
}

#[cfg(all(not(dev), target_os = "windows"))]
fn copy_dir_missing(src: &Path, dst: &Path) -> io::Result<()> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = match entry {
            Ok(v) => v,
            Err(_) => continue,
        };
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let file_type = match entry.file_type() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            let _ = copy_dir_missing(&src_path, &dst_path);
            continue;
        }
        if !dst_path.exists() {
            let _ = fs::copy(&src_path, &dst_path);
        }
    }
    Ok(())
}

#[cfg(all(not(dev), target_os = "windows"))]
fn migrate_legacy_runtime_files(sources: &[PathBuf], data_dir: &Path) {
    let runtime_files = [
        "config.json",
        "configWW.json",
        "configZZ.json",
        "configGI.json",
        "configSR.json",
        "configEF.json",
    ];

    let mut backup_roots = vec![data_dir.join("backups")];
    for source in sources {
        backup_roots.push(source.join("backups"));
    }

    for file in runtime_files {
        let dst = data_dir.join(file);
        merge_config_file(&dst, sources, &backup_roots, file == "config.json");
    }

    for source in sources {
        let _ = copy_dir_missing(&source.join("backups"), &data_dir.join("backups"));
    }
}

#[cfg(all(not(dev), target_os = "windows"))]
fn resolve_runtime_dir(exe_dir: &Path) -> PathBuf {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| exe_dir.to_path_buf());
    // Keep runtime state out of the install folder so updater installs do not overwrite configs.
    let data_dir = local_app_data.join(RUNTIME_DATA_DIR_NAME);
    if let Err(e) = fs::create_dir_all(&data_dir) {
        eprintln!("Failed to create runtime data directory: {e}");
        return exe_dir.to_path_buf();
    }
    let legacy_runtime_dir = local_app_data.join(LEGACY_RUNTIME_DIR_NAME);
    let mut sources = Vec::new();
    for candidate in [legacy_runtime_dir, exe_dir.to_path_buf()] {
        if candidate != data_dir && candidate.exists() && !sources.iter().any(|existing| existing == &candidate) {
            sources.push(candidate);
        }
    }
    migrate_legacy_runtime_files(&sources, &data_dir);
    data_dir
}

#[cfg(all(not(dev), not(target_os = "windows")))]
fn resolve_runtime_dir(exe_dir: &Path) -> PathBuf {
    exe_dir.to_path_buf()
}

fn main() {
    #[cfg(not(dev))]
    if let Ok(exe_path) = env::current_exe() {
        // Get the directory containing the executable
        if let Some(exe_dir) = exe_path.parent() {
            // Persist runtime state under local app data so updater installs don't wipe configs.
            let runtime_dir = resolve_runtime_dir(exe_dir);
            if let Err(e) = env::set_current_dir(runtime_dir) {
                eprintln!("Failed to set working directory: {}", e);
            }
        }
    }
    wuwa_mod_manager_lib::run()
}

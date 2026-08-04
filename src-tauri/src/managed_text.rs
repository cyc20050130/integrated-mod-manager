use atomic_write_file::AtomicWriteFile;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::OpenOptions as CapOpenOptions;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MANAGED_TARGET_DIR: &str = "DO NOT MODIFY (Managed by IMM)";
const PREFERENCES_DIR: &str = ".USER_PREFS";
const PRESETS_DIR: &str = "Presets";
const MAX_MANAGED_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_JSON_EXPORT_BYTES: usize = 8 * 1024 * 1024;
const MAX_JSON_IMPORT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ManagedTextPurpose {
    D3dxUserIni,
    ModMetadata,
    PresetExport,
    CollisionChecklist,
    ModPreference,
    ModIni,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum JsonExportKind {
    GameConfig,
    LinkAudit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedGamePaths {
    source_dir: String,
    target_dir: String,
}

#[derive(Deserialize)]
struct PersistedGlobalPaths {
    #[serde(rename = "XXMI")]
    xxmi_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct XxmiLauncherConfigDocument {
    root: String,
    contents: String,
}

fn persisted_global_paths(config_dir: &Path) -> Result<PersistedGlobalPaths, String> {
    serde_json::from_str(
        &fs::read_to_string(config_dir.join("config.json"))
            .map_err(|error| format!("Unable to read persisted global configuration: {error}"))?,
    )
    .map_err(|error| format!("Invalid persisted global configuration: {error}"))
}

fn read_xxmi_launcher_document(config_dir: &Path) -> Result<XxmiLauncherConfigDocument, String> {
    let config = persisted_global_paths(config_dir)?;
    let root = safe_configured_root(&config.xxmi_dir, "XXMI Launcher directory")?;
    let path = root.join("XXMI Launcher Config.json");
    let contents = read_managed_text_optional(&path, "XXMI Launcher configuration")?
        .ok_or_else(|| "XXMI Launcher configuration does not exist".to_string())?;
    let _: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|error| format!("XXMI Launcher configuration is not valid JSON: {error}"))?;
    Ok(XxmiLauncherConfigDocument {
        root: root.to_string_lossy().into_owned(),
        contents,
    })
}

fn persisted_game_paths(config_dir: &Path, game: &str) -> Result<PersistedGamePaths, String> {
    crate::validate_registered_game_key(game)?;
    if game == "NTE" {
        let (source_dir, target_dir) = crate::nte::persisted_nte_game_directories(config_dir)?;
        return Ok(PersistedGamePaths {
            source_dir,
            target_dir,
        });
    }
    let path = config_dir.join(format!("config{game}.json"));
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read persisted game configuration: {error}"))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Invalid persisted game configuration: {error}"))
}

fn safe_configured_root(raw: &str, label: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err(format!("The configured {label} is empty"));
    }
    let path = PathBuf::from(raw);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Unable to inspect the configured {label}: {error}"))?;
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        return Err(format!(
            "The configured {label} is not a safe regular directory"
        ));
    }
    path.canonicalize()
        .map_err(|error| format!("Unable to resolve the configured {label}: {error}"))
}

fn safe_relative_path(raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(format!("A relative {label} is required"));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            _ => return Err(format!("The {label} contains an unsafe path component")),
        }
    }
    Ok(normalized)
}

fn mod_identity(raw: &str) -> Result<(PathBuf, String), String> {
    let path = safe_relative_path(raw, "Mod identity")?;
    let components = path.components().collect::<Vec<_>>();
    if components.len() != 2 {
        return Err("A Mod identity must contain exactly a category and Mod name".to_string());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The Mod name is not valid Unicode".to_string())?
        .to_string();
    Ok((path, name))
}

fn single_file_stem(raw: &str, label: &str) -> Result<String, String> {
    let path = safe_relative_path(raw, label)?;
    if path.components().count() != 1 {
        return Err(format!("The {label} must be a single file name"));
    }
    let value = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("The {label} is not valid Unicode"))?;
    if value.is_empty()
        || value.ends_with('.')
        || value.ends_with(' ')
        || value
            .chars()
            .any(|character| character.is_control() || "<>:\"/\\|?*".contains(character))
        || is_windows_reserved_file_stem(value)
    {
        return Err(format!("The {label} contains unsupported characters"));
    }
    Ok(value.to_string())
}

fn is_windows_reserved_file_stem(value: &str) -> bool {
    let base = value
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || base
        .strip_prefix("COM")
        .or_else(|| base.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            suffix.len() == 1 && matches!(suffix.as_bytes().first(), Some(b'1'..=b'9'))
        })
}

fn prepare_directory(root: &Path, relative: &Path, create: bool) -> Result<PathBuf, String> {
    let mut directory = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("The managed directory contains an unsafe component".to_string());
        };
        directory.push(name);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata_is_reparse(&metadata) {
                    return Err(
                        "A managed directory component is not a safe regular directory".to_string(),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                fs::create_dir(&directory)
                    .map_err(|error| format!("Unable to create a managed directory: {error}"))?;
            }
            Err(error) => {
                return Err(format!("Unable to inspect a managed directory: {error}"));
            }
        }
    }
    let canonical = directory
        .canonicalize()
        .map_err(|error| format!("Unable to resolve a managed directory: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("The managed directory resolves outside its configured root".to_string());
    }
    Ok(canonical)
}

fn ensure_safe_target_if_present(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata_is_reparse(&metadata) {
                return Err("The managed text target is not a safe regular file".to_string());
            }
            if metadata_has_multiple_links(path, &metadata)? {
                return Err("The managed text target has multiple hard links".to_string());
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Unable to inspect the managed text target: {error}"
        )),
    }
}

fn atomic_write_text(path: &Path, contents: &str) -> Result<(), String> {
    if contents.len() > MAX_MANAGED_TEXT_BYTES {
        return Err(format!(
            "Managed text exceeds the {MAX_MANAGED_TEXT_BYTES} byte limit"
        ));
    }
    if contents.contains('\0') {
        return Err("Managed text contains a null character".to_string());
    }
    ensure_safe_target_if_present(path)?;
    let mut output = AtomicWriteFile::open(path)
        .map_err(|error| format!("Unable to stage managed text: {error}"))?;
    output
        .write_all(contents.as_bytes())
        .map_err(|error| format!("Unable to write managed text: {error}"))?;
    output
        .commit()
        .map_err(|error| format!("Unable to publish managed text: {error}"))
}

fn read_managed_text_optional(path: &Path, label: &str) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => ensure_safe_target_if_present(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Unable to inspect {label}: {error}")),
    }
    let bytes = fs::read(path).map_err(|error| format!("Unable to read {label}: {error}"))?;
    if bytes.len() > MAX_MANAGED_TEXT_BYTES {
        return Err(format!("{label} exceeds the managed text limit"));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| format!("{label} is not valid UTF-8: {error}"))
}

fn managed_text_target(
    config_dir: &Path,
    game: &str,
    purpose: ManagedTextPurpose,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let paths = persisted_game_paths(config_dir, game)?;
    let source = safe_configured_root(&paths.source_dir, "source directory")?;
    let target = safe_configured_root(&paths.target_dir, "target directory")?;
    match purpose {
        ManagedTextPurpose::D3dxUserIni => {
            if !relative_path.is_empty() {
                return Err("d3dx_user.ini does not accept a renderer path".to_string());
            }
            let parent = target
                .parent()
                .ok_or_else(|| "The configured target has no parent directory".to_string())?;
            let parent = safe_configured_root(&parent.to_string_lossy(), "target parent")?;
            Ok(parent.join("d3dx_user.ini"))
        }
        ManagedTextPurpose::ModMetadata => {
            let (identity, _) = mod_identity(relative_path)?;
            let parent = prepare_directory(
                &source,
                &PathBuf::from(crate::MANAGED_SOURCE_DIR).join(identity),
                false,
            )?;
            Ok(parent.join("mod.json"))
        }
        ManagedTextPurpose::PresetExport => {
            let name = single_file_stem(relative_path, "preset name")?;
            let parent = prepare_directory(&target, Path::new(PRESETS_DIR), true)?;
            Ok(parent.join(format!("{name}.txt")))
        }
        ManagedTextPurpose::CollisionChecklist => {
            let (identity, _) = mod_identity(relative_path)?;
            let parent = prepare_directory(
                &source,
                &PathBuf::from(crate::MANAGED_SOURCE_DIR).join(identity),
                false,
            )?;
            Ok(parent.join(".imm-collision-checklist"))
        }
        ManagedTextPurpose::ModPreference => {
            let (identity, name) = mod_identity(relative_path)?;
            let category = identity
                .parent()
                .ok_or_else(|| "The Mod preference has no category".to_string())?;
            let parent = prepare_directory(
                &target,
                &PathBuf::from(MANAGED_TARGET_DIR)
                    .join(PREFERENCES_DIR)
                    .join(category),
                true,
            )?;
            Ok(parent.join(format!("{name}.ini")))
        }
        ManagedTextPurpose::ModIni => {
            let relative = safe_relative_path(relative_path, "Mod INI path")?;
            if relative.components().count() < 3
                || relative
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_none_or(|extension| !extension.eq_ignore_ascii_case("ini"))
            {
                return Err(
                    "A Mod INI must be an .ini file inside a category and Mod directory"
                        .to_string(),
                );
            }
            let parent_relative = PathBuf::from(crate::MANAGED_SOURCE_DIR).join(
                relative
                    .parent()
                    .ok_or_else(|| "The Mod INI has no parent directory".to_string())?,
            );
            let parent = prepare_directory(&source, &parent_relative, false)?;
            let file_name = relative
                .file_name()
                .ok_or_else(|| "The Mod INI has no file name".to_string())?;
            Ok(parent.join(file_name))
        }
    }
}

#[tauri::command]
pub(crate) fn write_managed_text_asset(
    game: String,
    purpose: ManagedTextPurpose,
    relative_path: String,
    contents: String,
) -> Result<(), String> {
    let config_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    if matches!(purpose, ManagedTextPurpose::ModMetadata) {
        let value: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|error| format!("Mod metadata is not valid JSON: {error}"))?;
        if !value.is_object() {
            return Err("Mod metadata must be a JSON object".to_string());
        }
    }
    let target = managed_text_target(&config_dir, &game, purpose, &relative_path)?;
    atomic_write_text(&target, &contents)
}

#[tauri::command]
pub(crate) fn read_d3dx_user_ini(game: String) -> Result<Option<String>, String> {
    let config_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    let target = managed_text_target(&config_dir, &game, ManagedTextPurpose::D3dxUserIni, "")?;
    read_managed_text_optional(&target, "d3dx_user.ini")
}

#[tauri::command]
pub(crate) fn ensure_d3dx_user_ini_backup(game: String) -> Result<bool, String> {
    let config_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    let source = managed_text_target(&config_dir, &game, ManagedTextPurpose::D3dxUserIni, "")?;
    let backup = source.with_file_name("d3dx_user_pre_imm.ini.bak");
    if fs::symlink_metadata(&backup).is_ok() {
        ensure_safe_target_if_present(&backup)?;
        return Ok(false);
    }
    let Some(contents) = read_managed_text_optional(&source, "d3dx_user.ini")? else {
        return Err("d3dx_user.ini does not exist".to_string());
    };
    atomic_write_text(&backup, &contents)?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn write_xxmi_launcher_config(contents: String) -> Result<(), String> {
    let config_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    let config = persisted_global_paths(&config_dir)?;
    let _: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|error| format!("XXMI Launcher configuration is not valid JSON: {error}"))?;
    let root = safe_configured_root(&config.xxmi_dir, "XXMI Launcher directory")?;
    atomic_write_text(&root.join("XXMI Launcher Config.json"), &contents)
}

#[tauri::command]
pub(crate) fn read_xxmi_launcher_config() -> Result<XxmiLauncherConfigDocument, String> {
    let config_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    read_xxmi_launcher_document(&config_dir)
}

#[tauri::command]
pub(crate) fn read_xxmi_importer_d3dx(game: String) -> Result<String, String> {
    crate::validate_registered_game_key(&game)?;
    if game == "NTE" {
        return Err("NTE does not use an XXMI importer.".to_string());
    }
    let config_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    let document = read_xxmi_launcher_document(&config_dir)?;
    let launcher: serde_json::Value = serde_json::from_str(&document.contents)
        .map_err(|error| format!("XXMI Launcher configuration is not valid JSON: {error}"))?;
    let importer_key = format!("{game}MI");
    let configured = launcher
        .get("Importers")
        .and_then(|value| value.get(&importer_key))
        .and_then(|value| value.get("Importer"))
        .and_then(|value| value.get("importer_folder"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    let root = PathBuf::from(&document.root);
    let importer_relative = if configured.is_empty() {
        PathBuf::from(&importer_key)
    } else {
        safe_relative_path(configured, "XXMI importer directory")?
    };
    let importer = prepare_directory(&root, &importer_relative, false)?;
    read_managed_text_optional(&importer.join("d3dx.ini"), "XXMI importer d3dx.ini")?
        .ok_or_else(|| "XXMI importer d3dx.ini does not exist".to_string())
}

#[tauri::command]
pub(crate) fn discover_xxmi_launcher_dir() -> Result<Option<String>, String> {
    let Some(app_data) = std::env::var_os("APPDATA").map(PathBuf::from) else {
        return Ok(None);
    };
    let mut candidates = vec![app_data.join("XXMI Launcher")];
    if let Some(parent) = app_data.parent() {
        candidates.push(parent.join("XXMI Launcher"));
    }
    for candidate in candidates {
        let Ok(root) =
            safe_configured_root(&candidate.to_string_lossy(), "XXMI Launcher candidate")
        else {
            continue;
        };
        match read_managed_text_optional(
            &root.join("XXMI Launcher Config.json"),
            "XXMI Launcher configuration",
        ) {
            Ok(Some(contents)) if serde_json::from_str::<serde_json::Value>(&contents).is_ok() => {
                return Ok(Some(root.to_string_lossy().into_owned()));
            }
            Ok(_) | Err(_) => continue,
        }
    }
    Ok(None)
}

#[tauri::command]
pub(crate) fn set_d3dx_foreground_mode(game: String, foreground: u8) -> Result<(), String> {
    if foreground > 1 {
        return Err("The d3dx foreground mode must be 0 or 1".to_string());
    }
    let config_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    let paths = persisted_game_paths(&config_dir, &game)?;
    let target = safe_configured_root(&paths.target_dir, "target directory")?;
    let parent = target
        .parent()
        .ok_or_else(|| "The configured target has no parent directory".to_string())?;
    let parent = safe_configured_root(&parent.to_string_lossy(), "target parent")?;
    let path = parent.join("d3dx.ini");
    ensure_safe_target_if_present(&path)?;
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("Unable to read d3dx.ini: {error}"))?;
    if contents.len() > MAX_MANAGED_TEXT_BYTES {
        return Err("d3dx.ini exceeds the managed text limit".to_string());
    }
    let mut changed = false;
    let replacement = foreground.to_string();
    let lines = contents
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("check_foreground_window") && !trimmed.ends_with(&replacement) {
                changed = true;
                format!("check_foreground_window = {foreground}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>();
    if changed {
        atomic_write_text(&path, &lines.join("\n"))?;
    }
    Ok(())
}

fn protected_export_roots(app_handle: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(path) = app_handle.path().app_local_data_dir() {
        roots.push(path);
    }
    if let Ok(path) = std::env::current_dir() {
        roots.push(path);
    }
    if let Ok(path) = std::env::current_exe() {
        if let Some(parent) = path.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    roots
        .into_iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect()
}

fn write_json_export_file(
    path: &Path,
    contents: &str,
    protected_roots: &[PathBuf],
) -> Result<(), String> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("json"))
    {
        return Err("JSON exports must use the .json extension".to_string());
    }
    if contents.len() > MAX_JSON_EXPORT_BYTES {
        return Err(format!(
            "JSON export exceeds the {MAX_JSON_EXPORT_BYTES} byte limit"
        ));
    }
    let _: serde_json::Value = serde_json::from_str(contents)
        .map_err(|error| format!("Export content is not valid JSON: {error}"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "The export destination has no file name".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "The export destination has no parent directory".to_string())?;
    let parent = canonicalize_directory_without_reparse_chain(parent, "export destination")?;
    if protected_roots.iter().any(|root| parent.starts_with(root)) {
        return Err("Exports cannot replace files in an IMM-controlled directory".to_string());
    }
    let target = parent.join(file_name);
    ensure_safe_target_if_present(&target)?;
    atomic_write_text(&target, contents)
}

fn canonicalize_directory_without_reparse_chain(
    path: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("The {label} directory must be absolute"));
    }
    let mut cursor = PathBuf::new();
    for component in path.components() {
        cursor.push(component.as_os_str());
        if !matches!(component, Component::Normal(_)) {
            continue;
        }
        let metadata = fs::symlink_metadata(&cursor)
            .map_err(|error| format!("Unable to inspect the {label} directory chain: {error}"))?;
        if !metadata.is_dir() || metadata_is_reparse(&metadata) {
            return Err(format!(
                "The {label} directory chain contains a reparse point or unsupported entry"
            ));
        }
    }
    path.canonicalize()
        .map_err(|error| format!("Unable to resolve the {label} directory: {error}"))
}

fn is_supported_json_import_name(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let normalized = file_name.to_ascii_lowercase();
    normalized.ends_with(".json")
        || normalized.ends_with(".json.bak")
        || normalized.ends_with(".json.bak.bak")
}

#[cfg(windows)]
fn open_file_has_multiple_links(file: &cap_std::fs::File) -> Result<bool, String> {
    use std::mem::zeroed;
    use std::os::windows::io::AsRawHandle;
    use winapi::um::fileapi::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};

    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    let result =
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
    if result == 0 {
        return Err(format!(
            "Unable to inspect configuration import hard links: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(information.nNumberOfLinks > 1)
}

#[cfg(not(windows))]
fn open_file_has_multiple_links(_file: &cap_std::fs::File) -> Result<bool, String> {
    Ok(false)
}

fn decode_json_import_text(bytes: Vec<u8>) -> Result<String, String> {
    if let Some(payload) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(payload.to_vec())
            .map_err(|error| format!("Configuration import is not valid UTF-8: {error}"));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let payload = &bytes[2..];
        if !payload.len().is_multiple_of(2) {
            return Err("Configuration import contains truncated UTF-16LE text.".to_string());
        }
        let units = payload
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&units)
            .map_err(|error| format!("Configuration import is not valid UTF-16LE: {error}"));
    }
    String::from_utf8(bytes)
        .map_err(|error| format!("Configuration import is not valid UTF-8: {error}"))
}

fn read_json_import_file(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("The configuration import path must be absolute.".to_string());
    }
    if !is_supported_json_import_name(path) {
        return Err(
            "Configuration imports must use .json or a supported .json.bak name.".to_string(),
        );
    }
    let parent = path
        .parent()
        .ok_or_else(|| "The configuration import has no parent directory.".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "The configuration import has no file name.".to_string())?;
    let parent = crate::nte::bind_absolute_directory(parent, "configuration import directory")?;
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = parent
        .leaf()
        .open_with(Path::new(file_name), &options)
        .map_err(|error| format!("Unable to open the configuration import: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect the configuration import: {error}"))?;
    if !metadata.is_file() || metadata_is_reparse_cap(&metadata) {
        return Err("The configuration import is not a safe regular file.".to_string());
    }
    if open_file_has_multiple_links(&file)? {
        return Err("The configuration import has multiple hard links.".to_string());
    }
    if metadata.len() > MAX_JSON_IMPORT_BYTES {
        return Err(format!(
            "Configuration import exceeds the {MAX_JSON_IMPORT_BYTES} byte limit."
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_JSON_IMPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Unable to read the configuration import: {error}"))?;
    if bytes.len() as u64 > MAX_JSON_IMPORT_BYTES {
        return Err(format!(
            "Configuration import exceeds the {MAX_JSON_IMPORT_BYTES} byte limit."
        ));
    }
    let contents = decode_json_import_text(bytes)?;
    let value: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|error| format!("Configuration import is not valid JSON: {error}"))?;
    if !value.is_object() {
        return Err("Configuration import must contain a JSON object.".to_string());
    }
    serde_json::to_string(&value)
        .map_err(|error| format!("Unable to normalize the configuration import: {error}"))
}

#[tauri::command]
pub(crate) async fn pick_json_import_document(
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app_handle
            .dialog()
            .file()
            .set_title("Import IMM configuration")
            .add_filter("JSON files", &["json", "bak"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("Unable to resolve the configuration import: {error}"))?;
        read_json_import_file(&path).map(Some)
    })
    .await
    .map_err(|error| format!("Configuration import worker failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn export_json_document(
    app_handle: tauri::AppHandle,
    kind: JsonExportKind,
    game: Option<String>,
    contents: String,
) -> Result<bool, String> {
    if matches!(kind, JsonExportKind::GameConfig) {
        crate::validate_registered_game_key(game.as_deref().unwrap_or_default())?;
    }
    let (title, file_name) = match kind {
        JsonExportKind::GameConfig => (
            "Export IMM configuration",
            format!("config{}.json", game.unwrap_or_default()),
        ),
        JsonExportKind::LinkAudit => ("Export link audit", "IMM-link-audit.json".to_string()),
    };
    let protected_roots = protected_export_roots(&app_handle);
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app_handle
            .dialog()
            .file()
            .set_title(title)
            .set_file_name(file_name)
            .add_filter("JSON files", &["json"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(false);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("Unable to resolve the export destination: {error}"))?;
        write_json_export_file(&path, &contents, &protected_roots)?;
        Ok(true)
    })
    .await
    .map_err(|error| format!("JSON export worker failed: {error}"))?
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(windows)]
fn metadata_is_reparse_cap(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;
    metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_cap(metadata: &cap_std::fs::Metadata) -> bool {
    metadata.is_symlink()
}

#[cfg(not(windows))]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn metadata_has_multiple_links(path: &Path, _metadata: &fs::Metadata) -> Result<bool, String> {
    use std::mem::zeroed;
    use std::os::windows::io::AsRawHandle;
    use winapi::um::fileapi::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};

    let file = fs::File::open(path)
        .map_err(|error| format!("Unable to open the managed text target: {error}"))?;
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    let result =
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
    if result == 0 {
        return Err(format!(
            "Unable to inspect managed text hard links: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(information.nNumberOfLinks > 1)
}

#[cfg(not(windows))]
fn metadata_has_multiple_links(_path: &Path, _metadata: &fs::Metadata) -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_game_config(config_dir: &Path, source: &Path, target: &Path) {
        fs::write(
            config_dir.join("configWW.json"),
            serde_json::json!({ "sourceDir": source, "targetDir": target }).to_string(),
        )
        .expect("game config");
    }

    #[test]
    fn managed_targets_are_derived_from_persisted_roots() {
        let temp = tempdir().expect("temp");
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir_all(
            source
                .join(crate::MANAGED_SOURCE_DIR)
                .join("Category")
                .join("Mod"),
        )
        .expect("source");
        fs::create_dir_all(&target).expect("target");
        write_game_config(temp.path(), &source, &target);

        let metadata = managed_text_target(
            temp.path(),
            "WW",
            ManagedTextPurpose::ModMetadata,
            r"Category\Mod",
        )
        .expect("metadata target");
        assert_eq!(
            metadata,
            source
                .canonicalize()
                .expect("canonical source")
                .join(crate::MANAGED_SOURCE_DIR)
                .join("Category")
                .join("Mod")
                .join("mod.json")
        );

        let preset =
            managed_text_target(temp.path(), "WW", ManagedTextPurpose::PresetExport, "Daily")
                .expect("preset target");
        assert_eq!(
            preset,
            target
                .canonicalize()
                .expect("canonical target")
                .join("Presets")
                .join("Daily.txt")
        );
    }

    #[test]
    fn managed_targets_reject_path_escape_and_wrong_file_types() {
        let temp = tempdir().expect("temp");
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir_all(
            source
                .join(crate::MANAGED_SOURCE_DIR)
                .join("Category")
                .join("Mod"),
        )
        .expect("source");
        fs::create_dir_all(&target).expect("target");
        write_game_config(temp.path(), &source, &target);

        assert!(managed_text_target(
            temp.path(),
            "WW",
            ManagedTextPurpose::PresetExport,
            "../outside",
        )
        .is_err());
        assert!(managed_text_target(
            temp.path(),
            "WW",
            ManagedTextPurpose::ModIni,
            r"Category\Mod\payload.exe",
        )
        .is_err());
        let uppercase_ini = managed_text_target(
            temp.path(),
            "WW",
            ManagedTextPurpose::ModIni,
            r"Category\Mod\payload.INI",
        )
        .expect("uppercase INI extension");
        assert_eq!(
            uppercase_ini.file_name().and_then(|name| name.to_str()),
            Some("payload.INI")
        );
        for name in ["CON", "aux.backup", "LPT9", "bad\u{1f}name"] {
            assert!(
                managed_text_target(temp.path(), "WW", ManagedTextPurpose::PresetExport, name,)
                    .is_err()
            );
        }
    }

    #[test]
    fn atomic_text_write_rejects_hard_link_targets() {
        let temp = tempdir().expect("temp");
        let first = temp.path().join("first.json");
        let second = temp.path().join("second.json");
        fs::write(&first, "{}").expect("first");
        fs::hard_link(&first, &second).expect("hard link");

        let error = atomic_write_text(&second, "{\"changed\":true}").unwrap_err();
        assert!(error.contains("hard links"));
        assert_eq!(fs::read_to_string(&first).expect("first contents"), "{}");
    }

    #[test]
    fn json_import_reads_bom_and_utf16_documents_through_a_bound_handle() {
        let temp = tempdir().expect("temp");
        let utf8 = temp.path().join("configWW.json.bak");
        fs::write(&utf8, b"\xEF\xBB\xBF{\"game\":\"WW\"}").expect("UTF-8 import");
        assert_eq!(
            read_json_import_file(&utf8).expect("read UTF-8 import"),
            r#"{"game":"WW"}"#
        );

        let utf16 = temp.path().join("configNTE.json");
        let mut bytes = vec![0xFF, 0xFE];
        for unit in r#"{"game":"NTE"}"#.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(&utf16, bytes).expect("UTF-16LE import");
        assert_eq!(
            read_json_import_file(&utf16).expect("read UTF-16LE import"),
            r#"{"game":"NTE"}"#
        );
    }

    #[test]
    fn json_import_rejects_unsupported_invalid_and_oversized_documents() {
        let temp = tempdir().expect("temp");
        let unsupported = temp.path().join("config.txt");
        fs::write(&unsupported, "{}").expect("unsupported import");
        assert!(read_json_import_file(&unsupported)
            .expect_err("unsupported extension")
            .contains(".json"));

        let invalid = temp.path().join("config.json");
        fs::write(&invalid, "[]").expect("invalid import");
        assert!(read_json_import_file(&invalid)
            .expect_err("JSON object required")
            .contains("JSON object"));

        let oversized = temp.path().join("oversized.json");
        fs::write(&oversized, vec![b' '; MAX_JSON_IMPORT_BYTES as usize + 1])
            .expect("oversized import");
        assert!(read_json_import_file(&oversized)
            .expect_err("size limit")
            .contains("byte limit"));
    }

    #[cfg(windows)]
    #[test]
    fn json_import_rejects_hard_link_sources() {
        let temp = tempdir().expect("temp");
        let first = temp.path().join("first.json");
        let second = temp.path().join("second.json.bak");
        fs::write(&first, "{}").expect("first import");
        fs::hard_link(&first, &second).expect("hard link import");

        assert!(read_json_import_file(&second)
            .expect_err("hard linked imports must fail")
            .contains("hard links"));
    }

    #[test]
    fn json_export_uses_a_regular_canonical_parent() {
        let temp = tempdir().expect("temp");
        let parent = temp.path().join("exports");
        fs::create_dir(&parent).expect("export parent");
        let target = parent.join("report.JSON");

        write_json_export_file(&target, "{\"ok\":true}", &[]).expect("write JSON export");

        assert_eq!(
            fs::read_to_string(target).expect("export contents"),
            "{\"ok\":true}"
        );
    }

    #[test]
    fn json_export_rejects_a_reparse_parent() {
        let temp = tempdir().expect("temp");
        let real = temp.path().join("real");
        let linked = temp.path().join("linked");
        fs::create_dir(&real).expect("real export parent");

        #[cfg(windows)]
        let link_result = junction::create(&real, &linked);
        #[cfg(unix)]
        let link_result = std::os::unix::fs::symlink(&real, &linked);
        #[cfg(not(any(windows, unix)))]
        let link_result: std::io::Result<()> = Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "directory links are unavailable",
        ));
        if link_result.is_err() {
            return;
        }

        let error = write_json_export_file(&linked.join("report.json"), "{}", &[])
            .expect_err("reparse parent must be rejected");
        assert!(error.contains("reparse point"));
        assert!(!real.join("report.json").exists());
    }
}

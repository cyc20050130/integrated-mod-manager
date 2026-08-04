use once_cell::sync::Lazy;
use serde::Deserialize;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use crate::app_state::AppStateRepository;

const MANAGED_SOURCE_DIR: &str = "DISABLED - ALL MODS ARE STORED HERE (Managed by IMM)";
const MANAGED_TARGET_DIR: &str = "DO NOT MODIFY (Managed by IMM)";
const LEGACY_MANAGED_SOURCE_DIR: &str = "DISABLED (Managed by IMM)";
const SUPPORTED_JUNCTION_GAMES: &[&str] = &["WW", "ZZ", "GI", "SR", "EF"];
static MANAGED_JUNCTION_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedGamePaths {
    source_dir: String,
    target_dir: String,
}

#[derive(Debug)]
struct ManagedJunctionPaths {
    source_managed_root: PathBuf,
    source: PathBuf,
    legacy_source: PathBuf,
    target_root: PathBuf,
    target: PathBuf,
}

#[tauri::command]
pub(crate) fn set_managed_mod_enabled(
    repository: tauri::State<'_, AppStateRepository>,
    game: String,
    relative_path: String,
    enabled: bool,
) -> Result<(), String> {
    if !SUPPORTED_JUNCTION_GAMES.contains(&game.as_str()) {
        return Err(format!(
            "{game} does not use managed junctions. NTE Mod state is handled by its WAL transaction."
        ));
    }

    crate::mod_mutation::with_global_lock(repository.control_root(), |registry| {
        crate::recover_generic_mod_mutation_registry(repository.runtime_root(), registry)?;
        let config: PersistedGamePaths = serde_json::from_value(repository.load_game_value(&game)?)
            .map_err(|err| format!("Invalid persisted {game} path configuration: {err}"))?;
        let paths = resolve_managed_junction_paths(
            Path::new(&config.source_dir),
            Path::new(&config.target_dir),
            &relative_path,
            enabled,
        )?;
        crate::mod_mutation::with_library_lock(&paths.source_managed_root, |_| {
            apply_managed_junction(&paths, enabled)
        })
    })
}

fn validate_mod_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.trim().is_empty() {
        return Err("A Mod-relative path is required.".to_string());
    }
    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err("The managed Mod path must be relative.".to_string());
    }
    let mut count = 0_usize;
    for component in path.components() {
        match component {
            Component::Normal(name) if !name.is_empty() => count = count.saturating_add(1),
            _ => return Err("The managed Mod path contains an unsafe component.".to_string()),
        }
    }
    if count < 2 {
        return Err("The managed Mod path must include a category and Mod directory.".to_string());
    }
    Ok(path.to_path_buf())
}

fn resolve_managed_junction_paths(
    configured_source: &Path,
    configured_target: &Path,
    relative_path: &str,
    require_source: bool,
) -> Result<ManagedJunctionPaths, String> {
    let relative = validate_mod_relative_path(relative_path)?;
    let source_root = canonical_regular_directory(configured_source, "configured source root")?;
    let target_root = canonical_regular_directory(configured_target, "configured target root")?;
    ensure_local_ntfs(&source_root, "source root")?;
    ensure_local_ntfs(&target_root, "target root")?;

    let source_managed_root = walk_existing_regular_directories(
        &source_root,
        Path::new(MANAGED_SOURCE_DIR),
        "managed source root",
    )?;
    let source_relative = Path::new(MANAGED_SOURCE_DIR).join(&relative);
    let source = if require_source {
        walk_existing_regular_directories(&source_root, &source_relative, "managed Mod source")?
    } else {
        source_root.join(source_relative)
    };
    let target = target_root.join(MANAGED_TARGET_DIR).join(relative);
    let legacy_source = source_root
        .join(LEGACY_MANAGED_SOURCE_DIR)
        .join(relative_path);

    Ok(ManagedJunctionPaths {
        source_managed_root,
        source,
        legacy_source,
        target_root,
        target,
    })
}

fn canonical_regular_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("The {label} must be an absolute local path."));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Unable to inspect the {label} '{}': {err}", path.display()))?;
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        return Err(format!(
            "The {label} must be a regular directory, not a symbolic link or reparse point."
        ));
    }
    path.canonicalize()
        .map_err(|err| format!("Unable to resolve the {label} '{}': {err}", path.display()))
}

fn walk_existing_regular_directories(
    root: &Path,
    relative: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(format!("The {label} contains an unsafe component."));
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current).map_err(|err| {
            format!(
                "Unable to inspect the {label} '{}': {err}",
                current.display()
            )
        })?;
        if !metadata.is_dir() || metadata_is_reparse(&metadata) {
            return Err(format!(
                "The {label} contains a symbolic link, reparse point, or non-directory entry."
            ));
        }
    }
    let canonical = current.canonicalize().map_err(|err| {
        format!(
            "Unable to resolve the {label} '{}': {err}",
            current.display()
        )
    })?;
    if !canonical.starts_with(root) {
        return Err(format!("The {label} escapes its configured root."));
    }
    Ok(canonical)
}

fn ensure_regular_parent_directories(root: &Path, destination: &Path) -> Result<(), String> {
    let relative = destination
        .strip_prefix(root)
        .map_err(|_| "The managed junction destination escapes its target root.".to_string())?;
    let parent = relative
        .parent()
        .ok_or_else(|| "The managed junction destination has no parent.".to_string())?;
    let mut current = root.to_path_buf();
    for component in parent.components() {
        let Component::Normal(name) = component else {
            return Err("The managed junction parent contains an unsafe component.".to_string());
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata_is_reparse(&metadata) => {}
            Ok(_) => {
                return Err(format!(
                    "Refusing to replace an unsafe managed junction parent: {}",
                    current.display()
                ));
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|err| {
                    format!(
                        "Unable to create the managed junction parent '{}': {err}",
                        current.display()
                    )
                })?;
            }
            Err(err) => {
                return Err(format!(
                    "Unable to inspect the managed junction parent '{}': {err}",
                    current.display()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn apply_managed_junction(paths: &ManagedJunctionPaths, enabled: bool) -> Result<(), String> {
    let _process_guard = MANAGED_JUNCTION_LOCK
        .lock()
        .map_err(|_| "The managed junction process lock is poisoned.".to_string())?;
    ensure_regular_parent_directories(&paths.target_root, &paths.target)?;

    let existing = inspect_destination(&paths.target)?;
    if enabled {
        match existing {
            ManagedDestination::Missing => junction::create(&paths.source, &paths.target)
                .map_err(|err| format_junction_error("create", &paths.target, err)),
            ManagedDestination::Junction(target) if target_is_managed(&target, paths) => Ok(()),
            ManagedDestination::LegacySymlink(target)
                if target_is_managed(&target, paths) =>
            {
                remove_directory_symlink(&paths.target)?;
                junction::create(&paths.source, &paths.target)
                    .map_err(|err| format_junction_error("replace the legacy symbolic link with", &paths.target, err))
            }
            ManagedDestination::Junction(target) | ManagedDestination::LegacySymlink(target) => Err(format!(
                "Refusing to replace the managed link '{}' because it points to '{}', not the configured Mod source.",
                paths.target.display(),
                target.display()
            )),
            ManagedDestination::OtherReparse => Err(format!(
                "Refusing to replace the unknown reparse point '{}'.",
                paths.target.display()
            )),
            ManagedDestination::Regular => Err(format!(
                "Refusing to replace the existing file or directory '{}'.",
                paths.target.display()
            )),
        }
    } else {
        match existing {
            ManagedDestination::Missing => Ok(()),
            ManagedDestination::Junction(target) if target_is_managed(&target, paths) => {
                junction::delete(&paths.target)
                    .map_err(|err| format_junction_error("delete", &paths.target, err))?;
                fs::remove_dir(&paths.target).map_err(|err| {
                    format!(
                        "Unable to remove the empty managed junction leaf '{}': {err}",
                        paths.target.display()
                    )
                })
            }
            ManagedDestination::LegacySymlink(target)
                if target_is_managed(&target, paths) =>
            {
                remove_directory_symlink(&paths.target)
            }
            ManagedDestination::Junction(target) | ManagedDestination::LegacySymlink(target) => Err(format!(
                "Refusing to delete the managed link '{}' because it points to '{}', not the configured Mod source.",
                paths.target.display(),
                target.display()
            )),
            ManagedDestination::OtherReparse => Err(format!(
                "Refusing to delete the unknown reparse point '{}'.",
                paths.target.display()
            )),
            ManagedDestination::Regular => Err(format!(
                "Refusing to delete the existing file or directory '{}'.",
                paths.target.display()
            )),
        }
    }
}

#[cfg(not(windows))]
fn apply_managed_junction(_paths: &ManagedJunctionPaths, _enabled: bool) -> Result<(), String> {
    Err("Managed Mod junctions are only supported on Windows.".to_string())
}

#[cfg(windows)]
enum ManagedDestination {
    Missing,
    Junction(PathBuf),
    LegacySymlink(PathBuf),
    OtherReparse,
    Regular,
}

#[cfg(windows)]
fn inspect_destination(path: &Path) -> Result<ManagedDestination, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok(ManagedDestination::Missing)
        }
        Err(err) => {
            return Err(format!(
                "Unable to inspect the managed junction destination '{}': {err}",
                path.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() {
        return fs::read_link(path)
            .map(ManagedDestination::LegacySymlink)
            .map_err(|err| {
                format!(
                    "Unable to read legacy symbolic link '{}': {err}",
                    path.display()
                )
            });
    }
    if !metadata_is_reparse(&metadata) {
        return Ok(ManagedDestination::Regular);
    }
    if junction::exists(path).map_err(|err| format_junction_error("inspect", path, err))? {
        return junction::get_target(path)
            .map(ManagedDestination::Junction)
            .map_err(|err| format_junction_error("read", path, err));
    }
    Ok(ManagedDestination::OtherReparse)
}

#[cfg(windows)]
fn targets_match(actual: &Path, expected: &Path, link: &Path) -> bool {
    let actual = if actual.is_absolute() {
        actual.to_path_buf()
    } else {
        link.parent().unwrap_or_else(|| Path::new("")).join(actual)
    };
    normalize_windows_path(&actual) == normalize_windows_path(expected)
}

#[cfg(windows)]
fn target_is_managed(actual: &Path, paths: &ManagedJunctionPaths) -> bool {
    targets_match(actual, &paths.source, &paths.target)
        || targets_match(actual, &paths.legacy_source, &paths.target)
}

#[cfg(windows)]
fn normalize_windows_path(path: &Path) -> String {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let normalized = resolved.to_string_lossy().replace('/', "\\");
    normalized
        .strip_prefix(r"\\?\UNC\")
        .map(|tail| format!(r"\\{tail}"))
        .or_else(|| normalized.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or(normalized)
        .trim_end_matches('\\')
        .to_lowercase()
}

#[cfg(windows)]
fn remove_directory_symlink(path: &Path) -> Result<(), String> {
    fs::remove_dir(path)
        .or_else(|directory_error| {
            fs::remove_file(path).map_err(|file_error| {
                io::Error::new(
                    file_error.kind(),
                    format!("directory error: {directory_error}; file error: {file_error}"),
                )
            })
        })
        .map_err(|err| {
            format!(
                "Unable to delete legacy symbolic link '{}': {err}",
                path.display()
            )
        })
}

#[cfg(windows)]
fn format_junction_error(operation: &str, path: &Path, error: io::Error) -> String {
    format!(
        "Unable to {operation} NTFS junction '{}': {error}. Verify that both configured roots are local NTFS directories.",
        path.display()
    )
}

#[cfg(windows)]
fn ensure_local_ntfs(path: &Path, label: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Prefix;
    use std::ptr::null_mut;
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;

    let drive = match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter,
            Prefix::UNC(..) | Prefix::VerbatimUNC(..) => {
                return Err(format!(
                    "The configured {label} is a UNC path. Managed junctions require a local NTFS volume."
                ));
            }
            _ => {
                return Err(format!(
                    "The configured {label} is not on a supported local drive."
                ));
            }
        },
        _ => return Err(format!("The configured {label} has no local drive prefix.")),
    };
    let volume = format!("{}:\\", char::from(drive));
    let volume_wide = std::ffi::OsStr::new(&volume)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut file_system = [0_u16; 32];
    let result = unsafe {
        GetVolumeInformationW(
            volume_wide.as_ptr(),
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            null_mut(),
            file_system.as_mut_ptr(),
            file_system.len() as u32,
        )
    };
    if result == 0 {
        return Err(format!(
            "Unable to query the configured {label} volume '{volume}': {}",
            io::Error::last_os_error()
        ));
    }
    let length = file_system
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(file_system.len());
    let name = String::from_utf16_lossy(&file_system[..length]);
    if !name.eq_ignore_ascii_case("NTFS") {
        return Err(format!(
            "The configured {label} uses {name}, but managed Mod junctions require NTFS."
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_local_ntfs(_path: &Path, _label: &str) -> Result<(), String> {
    Err("Managed Mod junctions are only supported on Windows.".to_string())
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf, PathBuf) {
        let temp = tempdir().expect("tempdir");
        let source_root = temp.path().join("source");
        let target_root = temp.path().join("target");
        let source = source_root
            .join(MANAGED_SOURCE_DIR)
            .join("Category")
            .join("Mod");
        let target = target_root
            .join(MANAGED_TARGET_DIR)
            .join("Category")
            .join("Mod");
        fs::create_dir_all(&source).expect("source Mod");
        fs::create_dir_all(&target_root).expect("target root");
        fs::write(source.join("mod.ini"), "enabled").expect("payload");
        (temp, source_root, target_root, source, target)
    }

    #[test]
    fn creates_and_deletes_managed_junction_without_touching_source() {
        let (_temp, source_root, target_root, source, target) = fixture();
        let paths =
            resolve_managed_junction_paths(&source_root, &target_root, r"Category\Mod", true)
                .expect("managed paths");

        apply_managed_junction(&paths, true).expect("enable Mod");
        assert!(junction::exists(&target).expect("junction check"));
        assert_eq!(
            fs::read_to_string(target.join("mod.ini")).expect("linked payload"),
            "enabled"
        );

        apply_managed_junction(&paths, false).expect("disable Mod");
        assert!(fs::symlink_metadata(&target).is_err());
        assert!(source.join("mod.ini").is_file());
    }

    #[test]
    fn rejects_parent_escape_and_incomplete_mod_identity() {
        let (_temp, source_root, target_root, _source, _target) = fixture();
        assert!(
            resolve_managed_junction_paths(&source_root, &target_root, r"..\outside", true)
                .is_err()
        );
        assert!(
            resolve_managed_junction_paths(&source_root, &target_root, "ModOnly", true).is_err()
        );
    }

    #[test]
    fn preserves_regular_destination_entries() {
        let (_temp, source_root, target_root, _source, target) = fixture();
        fs::create_dir_all(&target).expect("user directory");
        fs::write(target.join("keep.txt"), "user").expect("user file");
        let paths =
            resolve_managed_junction_paths(&source_root, &target_root, r"Category\Mod", true)
                .expect("managed paths");

        let error =
            apply_managed_junction(&paths, true).expect_err("regular directory must be preserved");
        assert!(error.contains("Refusing to replace"));
        assert_eq!(
            fs::read_to_string(target.join("keep.txt")).expect("kept file"),
            "user"
        );
    }

    #[test]
    fn preserves_junction_that_targets_another_directory() {
        let (_temp, source_root, target_root, _source, target) = fixture();
        let other = target_root.join("other");
        fs::create_dir_all(target.parent().expect("target parent")).expect("target parent");
        fs::create_dir_all(&other).expect("other target");
        junction::create(&other, &target).expect("foreign junction");
        let paths =
            resolve_managed_junction_paths(&source_root, &target_root, r"Category\Mod", true)
                .expect("managed paths");

        let error =
            apply_managed_junction(&paths, false).expect_err("foreign junction must be preserved");
        assert!(error.contains("Refusing to delete"));
        assert!(junction::exists(&target).expect("foreign junction remains"));
        junction::delete(&target).expect("test cleanup");
    }

    #[test]
    fn replaces_only_a_legacy_imm_junction_with_the_current_target() {
        let (_temp, source_root, target_root, source, target) = fixture();
        let legacy_source = source_root
            .join(LEGACY_MANAGED_SOURCE_DIR)
            .join("Category")
            .join("Mod");
        fs::create_dir_all(target.parent().expect("target parent")).expect("target parent");
        junction::create(&legacy_source, &target).expect("legacy junction");
        let paths =
            resolve_managed_junction_paths(&source_root, &target_root, r"Category\Mod", true)
                .expect("managed paths");

        apply_managed_junction(&paths, true).expect("migrate legacy junction");
        assert_eq!(
            normalize_windows_path(&junction::get_target(&target).expect("new target")),
            normalize_windows_path(&source)
        );
        apply_managed_junction(&paths, false).expect("test cleanup");
    }
}

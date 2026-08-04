use crate::app_state::AppStateRepository;
use crate::nte::{self, BoundDirectoryLeaf};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::OpenOptions as CapOpenOptions;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::State;

const MAX_MANAGED_TEXT_BYTES: u64 = 16 * 1024 * 1024;
const MANAGED_SOURCE_DIR: &str = "DISABLED - ALL MODS ARE STORED HERE (Managed by IMM)";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ManagedRootKind {
    Source,
    Target,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedDirEntry {
    name: String,
    is_directory: bool,
}

#[derive(Debug)]
struct ManagedGamePaths {
    source: PathBuf,
    target: PathBuf,
}

impl ManagedGamePaths {
    fn load(repository: &AppStateRepository, game: &str) -> Result<Self, String> {
        crate::validate_registered_game_key(game)?;
        let config = repository.load_game_value(game)?;
        let configured_path = |field: &str| {
            config
                .get(field)
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .ok_or_else(|| format!("The persisted {game} {field} is unavailable."))
        };
        Ok(Self {
            source: configured_path("sourceDir")?,
            target: configured_path("targetDir")?,
        })
    }

    fn root(&self, kind: ManagedRootKind) -> &Path {
        match kind {
            ManagedRootKind::Source => &self.source,
            ManagedRootKind::Target => &self.target,
        }
    }
}

fn validate_relative_path(raw: &str, allow_root: bool) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if path.as_os_str().is_empty() {
        return allow_root
            .then(PathBuf::new)
            .ok_or_else(|| "A managed relative path is required.".to_string());
    }
    if path.is_absolute() {
        return Err("Managed filesystem paths must be relative.".to_string());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            _ => return Err("Managed filesystem path contains an unsafe component.".to_string()),
        }
    }
    if normalized.as_os_str().is_empty() && !allow_root {
        return Err("A managed relative path is required.".to_string());
    }
    Ok(normalized)
}

fn safe_existing_root(root: &Path, label: &str) -> Result<PathBuf, String> {
    nte::bind_absolute_directory(root, label)?;
    root.canonicalize()
        .map_err(|error| format!("Unable to resolve the {label}: {error}"))
}

fn safe_managed_path(
    paths: &ManagedGamePaths,
    kind: ManagedRootKind,
    relative: &str,
    allow_root: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let root = safe_existing_root(paths.root(kind), "persisted managed root")?;
    let relative = validate_relative_path(relative, allow_root)?;
    Ok((root.clone(), root.join(&relative)))
}

fn bind_parent(path: &Path, label: &str) -> Result<(nte::BoundDirectoryChain, PathBuf), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("The {label} has no parent directory."))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("The {label} has no final component."))?;
    Ok((
        nte::bind_absolute_directory(parent, label)?,
        PathBuf::from(name),
    ))
}

#[cfg(windows)]
fn cap_metadata_is_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;
    metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
fn cap_metadata_is_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    metadata.is_symlink()
}

fn create_directory_tree(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = safe_existing_root(root, "managed directory root")?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("Managed directory contains an unsafe component.".to_string());
        };
        let bound = nte::bind_absolute_directory(&current, "managed directory parent")?;
        match nte::open_bound_directory_optional(bound.leaf(), name, "managed directory")? {
            Some(_) => {}
            None => {
                bound
                    .leaf()
                    .create_dir(Path::new(name))
                    .map_err(|error| format!("Unable to create managed directory: {error}"))?;
            }
        }
        current.push(name);
        nte::bind_absolute_directory(&current, "created managed directory")?;
    }
    Ok(())
}

fn ensure_configured_root(root: &Path) -> Result<(), String> {
    if nte::bind_absolute_directory_optional(root, "configured managed root")?.is_some() {
        return Ok(());
    }
    let (parent, name) = bind_parent(root, "configured managed root")?;
    parent
        .leaf()
        .create_dir(&name)
        .map_err(|error| format!("Unable to create configured managed root: {error}"))?;
    nte::bind_absolute_directory(root, "created configured managed root")?;
    Ok(())
}

fn path_exists(
    paths: &ManagedGamePaths,
    kind: ManagedRootKind,
    relative: &str,
) -> Result<bool, String> {
    let (_, path) = safe_managed_path(paths, kind, relative, true)?;
    if relative.is_empty() {
        return Ok(true);
    }
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return Ok(false),
    };
    let Some(parent) = nte::bind_absolute_directory_optional(parent, "managed path parent")? else {
        return Ok(false);
    };
    let Some(name) = path.file_name() else {
        return Ok(false);
    };
    match parent.leaf().symlink_metadata(name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Unable to inspect managed path: {error}")),
    }
}

fn read_directory(
    paths: &ManagedGamePaths,
    kind: ManagedRootKind,
    relative: &str,
) -> Result<Vec<ManagedDirEntry>, String> {
    let (_, path) = safe_managed_path(paths, kind, relative, true)?;
    let directory = nte::bind_absolute_directory(&path, "managed read directory")?;
    directory
        .leaf()
        .read_dir(".")
        .map_err(|error| format!("Unable to enumerate managed directory: {error}"))?
        .map(|entry| {
            let entry =
                entry.map_err(|error| format!("Unable to enumerate managed entry: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("Unable to inspect managed entry: {error}"))?;
            Ok(ManagedDirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_directory: file_type.is_dir(),
            })
        })
        .collect()
}

fn read_text(
    paths: &ManagedGamePaths,
    kind: ManagedRootKind,
    relative: &str,
) -> Result<String, String> {
    let (_, path) = safe_managed_path(paths, kind, relative, false)?;
    let (parent, name) = bind_parent(&path, "managed text file")?;
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = parent
        .leaf()
        .open_with(&name, &options)
        .map_err(|error| format!("Unable to open managed text file: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect managed text file: {error}"))?;
    if !metadata.is_file() || cap_metadata_is_reparse(&metadata) {
        return Err("Managed text target is not a safe regular file.".to_string());
    }
    if metadata.len() > MAX_MANAGED_TEXT_BYTES {
        return Err(format!(
            "Managed text exceeds the {MAX_MANAGED_TEXT_BYTES} byte limit."
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_MANAGED_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Unable to read managed text file: {error}"))?;
    if bytes.len() as u64 > MAX_MANAGED_TEXT_BYTES {
        return Err(format!(
            "Managed text exceeds the {MAX_MANAGED_TEXT_BYTES} byte limit."
        ));
    }
    String::from_utf8(bytes).map_err(|error| format!("Managed text is not valid UTF-8: {error}"))
}

fn remove_path(
    paths: &ManagedGamePaths,
    kind: ManagedRootKind,
    relative: &str,
    recursive: bool,
) -> Result<(), String> {
    let (_, path) = safe_managed_path(paths, kind, relative, false)?;
    let (parent, name) = bind_parent(&path, "managed removal target")?;
    let metadata = match parent.leaf().symlink_metadata(&name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Unable to inspect managed removal target: {error}")),
    };
    if cap_metadata_is_reparse(&metadata) {
        return if metadata.is_dir() {
            parent.leaf().remove_dir(&name)
        } else {
            parent.leaf().remove_file(&name)
        }
        .map_err(|error| format!("Unable to remove managed reparse entry: {error}"));
    }
    if metadata.is_dir() {
        if recursive {
            let directory = BoundDirectoryLeaf::open_optional(&path, "managed removal target")?
                .ok_or_else(|| "Managed removal target disappeared.".to_string())?;
            directory.remove("managed directory")
        } else {
            parent
                .leaf()
                .remove_dir(&name)
                .map_err(|error| format!("Unable to remove managed directory: {error}"))
        }
    } else if metadata.is_file() {
        parent
            .leaf()
            .remove_file(&name)
            .map_err(|error| format!("Unable to remove managed file: {error}"))
    } else {
        Err("Managed removal target is an unsupported filesystem entry.".to_string())
    }
}

fn rename_path(
    paths: &ManagedGamePaths,
    from_kind: ManagedRootKind,
    from_relative: &str,
    to_kind: ManagedRootKind,
    to_relative: &str,
) -> Result<(), String> {
    let (_, from) = safe_managed_path(paths, from_kind, from_relative, false)?;
    let (_, to) = safe_managed_path(paths, to_kind, to_relative, false)?;
    let (from_parent, from_name) = bind_parent(&from, "managed rename source")?;
    let (to_parent, to_name) = bind_parent(&to, "managed rename destination")?;
    match to_parent.leaf().symlink_metadata(&to_name) {
        Ok(_) => return Err("Managed rename destination already exists.".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Unable to inspect managed rename destination: {error}"
            ))
        }
    }
    let metadata = from_parent
        .leaf()
        .symlink_metadata(&from_name)
        .map_err(|error| format!("Unable to inspect managed rename source: {error}"))?;
    if cap_metadata_is_reparse(&metadata) {
        return Err("Managed rename source is a reparse entry.".to_string());
    }
    if metadata.is_dir() {
        BoundDirectoryLeaf::open_optional(&from, "managed rename source")?
            .ok_or_else(|| "Managed rename source disappeared.".to_string())?
            .rename_to(&to, "managed directory")?;
        Ok(())
    } else if metadata.is_file() {
        from_parent
            .leaf()
            .rename(&from_name, to_parent.leaf(), &to_name)
            .map_err(|error| format!("Unable to rename managed file: {error}"))
    } else {
        Err("Managed rename source is an unsupported filesystem entry.".to_string())
    }
}

fn copy_file(
    paths: &ManagedGamePaths,
    from_kind: ManagedRootKind,
    from_relative: &str,
    to_kind: ManagedRootKind,
    to_relative: &str,
) -> Result<(), String> {
    let (_, from) = safe_managed_path(paths, from_kind, from_relative, false)?;
    let (_, to) = safe_managed_path(paths, to_kind, to_relative, false)?;
    let (from_parent, from_name) = bind_parent(&from, "managed copy source")?;
    let (to_parent, to_name) = bind_parent(&to, "managed copy destination")?;
    let mut read_options = CapOpenOptions::new();
    read_options.read(true).follow(FollowSymlinks::No);
    let mut source = from_parent
        .leaf()
        .open_with(&from_name, &read_options)
        .map_err(|error| format!("Unable to open managed copy source: {error}"))?;
    let metadata = source
        .metadata()
        .map_err(|error| format!("Unable to inspect managed copy source: {error}"))?;
    if !metadata.is_file() || cap_metadata_is_reparse(&metadata) {
        return Err("Managed copy source is not a safe regular file.".to_string());
    }
    let mut write_options = CapOpenOptions::new();
    write_options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut destination = to_parent
        .leaf()
        .open_with(&to_name, &write_options)
        .map_err(|error| format!("Unable to create managed copy destination: {error}"))?;
    std::io::copy(&mut source, &mut destination)
        .map_err(|error| format!("Unable to copy managed file: {error}"))?;
    destination
        .flush()
        .and_then(|_| destination.sync_all())
        .map_err(|error| format!("Unable to flush managed copy destination: {error}"))
}

fn with_managed_write<T>(
    repository: &AppStateRepository,
    game: &str,
    operation: impl FnOnce(&ManagedGamePaths) -> Result<T, String>,
) -> Result<T, String> {
    crate::mod_mutation::with_global_lock(repository.control_root(), |registry| {
        crate::recover_generic_mod_mutation_registry(repository.runtime_root(), registry)?;
        let paths = ManagedGamePaths::load(repository, game)?;
        operation(&paths)
    })
}

#[tauri::command]
pub(crate) fn managed_path_exists(
    repository: State<'_, AppStateRepository>,
    game: String,
    root_kind: ManagedRootKind,
    relative_path: String,
) -> Result<bool, String> {
    let paths = ManagedGamePaths::load(&repository, &game)?;
    path_exists(&paths, root_kind, &relative_path)
}

#[tauri::command]
pub(crate) fn read_managed_dir(
    repository: State<'_, AppStateRepository>,
    game: String,
    root_kind: ManagedRootKind,
    relative_path: String,
) -> Result<Vec<ManagedDirEntry>, String> {
    let paths = ManagedGamePaths::load(&repository, &game)?;
    read_directory(&paths, root_kind, &relative_path)
}

#[tauri::command]
pub(crate) fn read_managed_text_file(
    repository: State<'_, AppStateRepository>,
    game: String,
    root_kind: ManagedRootKind,
    relative_path: String,
) -> Result<String, String> {
    let paths = ManagedGamePaths::load(&repository, &game)?;
    read_text(&paths, root_kind, &relative_path)
}

#[tauri::command]
pub(crate) fn create_managed_dir(
    repository: State<'_, AppStateRepository>,
    game: String,
    root_kind: ManagedRootKind,
    relative_path: String,
) -> Result<(), String> {
    with_managed_write(&repository, &game, |paths| {
        let root = safe_existing_root(paths.root(root_kind), "persisted managed root")?;
        let relative = validate_relative_path(&relative_path, false)?;
        create_directory_tree(&root, &relative)
    })
}

#[tauri::command]
pub(crate) fn prepare_managed_source_dir(
    repository: State<'_, AppStateRepository>,
    game: String,
) -> Result<(), String> {
    with_managed_write(&repository, &game, |paths| {
        ensure_configured_root(&paths.source)?;
        create_directory_tree(&paths.source, Path::new(MANAGED_SOURCE_DIR))
    })
}

#[tauri::command]
pub(crate) fn remove_managed_path(
    repository: State<'_, AppStateRepository>,
    game: String,
    root_kind: ManagedRootKind,
    relative_path: String,
    recursive: bool,
) -> Result<(), String> {
    with_managed_write(&repository, &game, |paths| {
        remove_path(paths, root_kind, &relative_path, recursive)
    })
}

#[tauri::command]
pub(crate) fn rename_managed_path(
    repository: State<'_, AppStateRepository>,
    game: String,
    from_root_kind: ManagedRootKind,
    from_relative_path: String,
    to_root_kind: ManagedRootKind,
    to_relative_path: String,
) -> Result<(), String> {
    with_managed_write(&repository, &game, |paths| {
        rename_path(
            paths,
            from_root_kind,
            &from_relative_path,
            to_root_kind,
            &to_relative_path,
        )
    })
}

#[tauri::command]
pub(crate) fn copy_managed_file(
    repository: State<'_, AppStateRepository>,
    game: String,
    from_root_kind: ManagedRootKind,
    from_relative_path: String,
    to_root_kind: ManagedRootKind,
    to_relative_path: String,
) -> Result<(), String> {
    with_managed_write(&repository, &game, |paths| {
        copy_file(
            paths,
            from_root_kind,
            &from_relative_path,
            to_root_kind,
            &to_relative_path,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn paths(root: &Path) -> ManagedGamePaths {
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        ManagedGamePaths { source, target }
    }

    #[test]
    fn relative_paths_reject_absolute_and_parent_traversal() {
        assert!(validate_relative_path(r"C:\\outside", true).is_err());
        assert!(validate_relative_path(r"..\\outside", true).is_err());
        assert!(validate_relative_path("", false).is_err());
        assert_eq!(
            validate_relative_path(r"Category\\Demo", false).unwrap(),
            PathBuf::from(r"Category\\Demo")
        );
    }

    #[test]
    fn managed_operations_stay_inside_persisted_roots() {
        let temp = tempdir().unwrap();
        let paths = paths(temp.path());
        create_directory_tree(&paths.source, Path::new(r"Mods\\Demo")).unwrap();
        fs::write(paths.source.join(r"Mods\\Demo\\mod.ini"), "ok").unwrap();

        assert!(path_exists(&paths, ManagedRootKind::Source, r"Mods\\Demo\\mod.ini").unwrap());
        assert_eq!(
            read_text(&paths, ManagedRootKind::Source, r"Mods\\Demo\\mod.ini").unwrap(),
            "ok"
        );
        copy_file(
            &paths,
            ManagedRootKind::Source,
            r"Mods\\Demo\\mod.ini",
            ManagedRootKind::Target,
            "copy.ini",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(paths.target.join("copy.ini")).unwrap(),
            "ok"
        );
        remove_path(&paths, ManagedRootKind::Source, r"Mods\\Demo", true).unwrap();
        assert!(!paths.source.join(r"Mods\\Demo").exists());
    }

    #[cfg(windows)]
    #[test]
    fn managed_directory_read_rejects_junction_escape() {
        use std::os::windows::fs::symlink_dir;

        let temp = tempdir().unwrap();
        let paths = paths(temp.path());
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        let link = paths.source.join("linked");
        if symlink_dir(&outside, &link).is_err() {
            return;
        }

        assert!(read_directory(&paths, ManagedRootKind::Source, "linked").is_err());
        assert_eq!(
            fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "secret"
        );
    }
}

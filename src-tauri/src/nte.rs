use atomic_write_file::AtomicWriteFile;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir as CapDir, OpenOptions as CapOpenOptions};
use fd_lock::RwLock as FileRwLock;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[cfg(windows)]
pub(crate) fn durable_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::winbase::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source = source.canonicalize()?;
    let destination_name = destination.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "NTE durable rename destination has no name",
        )
    })?;
    let destination_parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "NTE durable rename destination has no parent",
        )
    })?;
    let destination = destination_parent.canonicalize()?.join(destination_name);
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn durable_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)?;
    if let Some(parent) = destination.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

const SHARED_GAME_EXE: &[&str] = &[
    "Client",
    "WindowsNoEditor",
    "HT",
    "Binaries",
    "Win64",
    "HTGame.exe",
];
const PAKS_COMPONENTS: &[&str] = &["Client", "WindowsNoEditor", "HT", "Content", "Paks"];
const MODS_COMPONENTS: &[&str] = &[
    "Client",
    "WindowsNoEditor",
    "HT",
    "Content",
    "Paks",
    "~mods",
];
const ALLOWED_PAYLOAD_EXTENSIONS: &[&str] = &["pak", "utoc", "ucas"];
const NTE_TARGET_LOCK_FILE: &str = ".imm-nte-operation.lock";
const NTE_LIBRARY_LOCK_FILE: &str = ".imm-nte-library.lock";
const NTE_CONFIG_LOCK_FILE: &str = ".imm-nte-config.lock";
const NTE_TARGET_WAL_FILE: &str = ".imm-nte-transactions.wal";
const NTE_LIBRARY_WAL_FILE: &str = ".imm-nte-library.wal";
const MANAGED_SOURCE_DIR: &str = "DISABLED - ALL MODS ARE STORED HERE (Managed by IMM)";

pub(crate) struct BoundDirectoryChain {
    handles: Vec<CapDir>,
}

pub(crate) struct BoundDirectoryLeaf {
    parent: BoundDirectoryChain,
    name: OsString,
    directory: CapDir,
}

impl BoundDirectoryChain {
    pub(crate) fn leaf(&self) -> &CapDir {
        self.handles
            .last()
            .expect("a bound directory chain always contains its filesystem anchor")
    }
}

impl BoundDirectoryLeaf {
    pub(crate) fn from_open(
        parent: BoundDirectoryChain,
        name: OsString,
        directory: CapDir,
    ) -> Self {
        Self {
            parent,
            name,
            directory,
        }
    }

    pub(crate) fn open_optional(path: &Path, label: &str) -> Result<Option<Self>, String> {
        let parent_path = path
            .parent()
            .ok_or_else(|| format!("The {label} path has no parent."))?;
        let name = path
            .file_name()
            .ok_or_else(|| format!("The {label} path has no directory name."))?
            .to_os_string();
        let Some(parent) = bind_absolute_directory_optional(parent_path, label)? else {
            return Ok(None);
        };
        let Some(directory) =
            open_bound_directory_for_rename_optional(parent.leaf(), &name, label)?
        else {
            return Ok(None);
        };
        Ok(Some(Self {
            parent,
            name,
            directory,
        }))
    }

    pub(crate) fn rename_to(mut self, destination: &Path, label: &str) -> Result<Self, String> {
        let destination_parent_path = destination
            .parent()
            .ok_or_else(|| format!("The {label} destination has no parent."))?;
        let destination_name = destination
            .file_name()
            .ok_or_else(|| format!("The {label} destination has no directory name."))?
            .to_os_string();
        let destination_parent = bind_absolute_directory(destination_parent_path, label)?;
        durable_rename_bound_directory(
            &self.directory,
            self.parent.leaf(),
            &self.name,
            destination_parent.leaf(),
            &destination_name,
        )
        .map_err(|err| format!("Unable to rename the bound {label}: {err}"))?;
        self.parent = destination_parent;
        self.name = destination_name;
        Ok(self)
    }

    pub(crate) fn remove(self, label: &str) -> Result<(), String> {
        remove_open_bound_directory_tree(self.directory, self.parent.leaf(), &self.name, label)
    }
}

fn absolute_directory_parts(path: &Path) -> Result<(PathBuf, Vec<OsString>), String> {
    if !path.is_absolute() {
        return Err("Trusted directory path must be absolute.".to_string());
    }
    let mut anchor = PathBuf::new();
    let mut descendants = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => anchor.push(prefix.as_os_str()),
            Component::RootDir => anchor.push(component.as_os_str()),
            Component::Normal(name) => descendants.push(name.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("Trusted directory path contains a parent traversal.".to_string());
            }
        }
    }
    if anchor.as_os_str().is_empty() {
        return Err("Trusted directory path has no filesystem anchor.".to_string());
    }
    Ok((anchor, descendants))
}

pub(crate) fn bind_absolute_directory_optional(
    path: &Path,
    label: &str,
) -> Result<Option<BoundDirectoryChain>, String> {
    let (anchor, descendants) = absolute_directory_parts(path)?;
    let anchor_handle = match CapDir::open_ambient_dir(&anchor, ambient_authority()) {
        Ok(handle) => handle,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(format!(
                "Unable to bind the {label} filesystem anchor: {err}"
            ))
        }
    };
    let mut handles = vec![anchor_handle];
    for component in descendants {
        let child = match handles
            .last()
            .expect("filesystem anchor is present")
            .open_dir_nofollow(&component)
        {
            Ok(child) => child,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(format!(
                    "Unable to bind the {label} directory component '{}': {err}",
                    component.to_string_lossy()
                ))
            }
        };
        let metadata = child
            .metadata(".")
            .map_err(|err| format!("Unable to inspect the bound {label} directory: {err}"))?;
        if !metadata.is_dir() || cap_metadata_is_reparse(&metadata) {
            return Err(format!(
                "The {label} directory chain contains a symbolic link or unsupported entry."
            ));
        }
        handles.push(child);
    }
    Ok(Some(BoundDirectoryChain { handles }))
}

pub(crate) fn bind_absolute_directory(
    path: &Path,
    label: &str,
) -> Result<BoundDirectoryChain, String> {
    bind_absolute_directory_optional(path, label)?
        .ok_or_else(|| format!("Unable to bind the {label} directory because it does not exist."))
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

pub(crate) fn open_bound_directory_optional(
    parent: &CapDir,
    name: &std::ffi::OsStr,
    label: &str,
) -> Result<Option<CapDir>, String> {
    let relative = Path::new(name);
    if relative.components().count() != 1
        || !matches!(relative.components().next(), Some(Component::Normal(_)))
    {
        return Err(format!("The {label} directory name is unsafe."));
    }
    let child = match parent.open_dir_nofollow(relative) {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Unable to bind the {label} directory leaf: {err}")),
    };
    let metadata = child
        .metadata(".")
        .map_err(|err| format!("Unable to inspect the bound {label} directory leaf: {err}"))?;
    if !metadata.is_dir() || cap_metadata_is_reparse(&metadata) {
        return Err(format!(
            "The {label} directory leaf is unsafe: reparse point or unsupported entry."
        ));
    }
    Ok(Some(child))
}

fn open_bound_directory_for_rename_io(
    parent: &CapDir,
    name: &std::ffi::OsStr,
    label: &str,
) -> std::io::Result<CapDir> {
    let relative = Path::new(name);
    if relative.components().count() != 1
        || !matches!(relative.components().next(), Some(Component::Normal(_)))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("The {label} directory name is unsafe."),
        ));
    }
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use winapi::um::winbase::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};
        use winapi::um::winnt::{
            DELETE, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
            FILE_WRITE_ATTRIBUTES, SYNCHRONIZE,
        };
        options
            .access_mode(
                DELETE
                    | FILE_LIST_DIRECTORY
                    | FILE_READ_ATTRIBUTES
                    | FILE_WRITE_ATTRIBUTES
                    | SYNCHRONIZE,
            )
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let directory = parent.open_with(relative, &options)?;
    let metadata = directory.metadata()?;
    if !metadata.is_dir() || cap_metadata_is_reparse(&metadata) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("The {label} directory leaf is unsafe: reparse point or unsupported entry."),
        ));
    }
    Ok(CapDir::from_std_file(directory.into_std()))
}

pub(crate) fn open_bound_directory_for_rename(
    parent: &CapDir,
    name: &std::ffi::OsStr,
    label: &str,
) -> Result<CapDir, String> {
    open_bound_directory_for_rename_optional(parent, name, label)?.ok_or_else(|| {
        format!("Unable to bind the {label} directory leaf because it does not exist.")
    })
}

pub(crate) fn open_bound_directory_for_rename_optional(
    parent: &CapDir,
    name: &std::ffi::OsStr,
    label: &str,
) -> Result<Option<CapDir>, String> {
    match open_bound_directory_for_rename_io(parent, name, label) {
        Ok(directory) => Ok(Some(directory)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Unable to bind the {label} directory leaf: {err}")),
    }
}

#[cfg(windows)]
pub(crate) fn durable_rename_bound_directory(
    source: &CapDir,
    _source_parent: &CapDir,
    _source_name: &std::ffi::OsStr,
    destination_parent: &CapDir,
    destination_name: &std::ffi::OsStr,
) -> std::io::Result<()> {
    use std::mem::{offset_of, size_of};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::ptr;
    use windows_sys::Wdk::Storage::FileSystem::{
        FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
    };
    use windows_sys::Win32::Foundation::{RtlNtStatusToDosError, HANDLE};
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    let destination = Path::new(destination_name);
    if destination.components().count() != 1
        || !matches!(destination.components().next(), Some(Component::Normal(_)))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "NTE bound rename destination name is unsafe",
        ));
    }
    let destination_parent_handle = destination_parent.as_raw_handle() as HANDLE;
    let encoded = destination_name.encode_wide().collect::<Vec<_>>();
    if encoded.is_empty() || encoded.len() > (u32::MAX as usize / size_of::<u16>()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "NTE bound rename destination name is too long",
        ));
    }
    let header_bytes = offset_of!(FILE_RENAME_INFORMATION, FileName);
    let payload_bytes = encoded
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|bytes| header_bytes.checked_add(bytes))
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "NTE bound rename payload is too large",
            )
        })?;
    let word_bytes = size_of::<usize>();
    let mut storage = vec![0usize; payload_bytes.div_ceil(word_bytes)];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = destination_parent_handle;
        (*info).FileNameLength = (encoded.len() * size_of::<u16>()) as u32;
        ptr::copy_nonoverlapping(
            encoded.as_ptr(),
            (*info).FileName.as_mut_ptr(),
            encoded.len(),
        );
    }
    let mut status = IO_STATUS_BLOCK::default();
    let renamed = unsafe {
        NtSetInformationFile(
            source.as_raw_handle() as HANDLE,
            &mut status,
            info.cast(),
            payload_bytes as u32,
            FileRenameInformation,
        )
    };
    if renamed < 0 {
        let code = unsafe { RtlNtStatusToDosError(renamed) };
        Err(std::io::Error::from_raw_os_error(code as i32))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn durable_rename_bound_directory(
    _source: &CapDir,
    source_parent: &CapDir,
    source_name: &std::ffi::OsStr,
    destination_parent: &CapDir,
    destination_name: &std::ffi::OsStr,
) -> std::io::Result<()> {
    source_parent.rename(source_name, destination_parent, destination_name)?;
    destination_parent.open(".")?.sync_all()
}

#[cfg(windows)]
fn delete_open_directory_handle(directory: &fs::File) -> std::io::Result<()> {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use winapi::shared::minwindef::{DWORD, TRUE};
    use winapi::um::fileapi::{SetFileInformationByHandle, FILE_DISPOSITION_INFO};
    use winapi::um::minwinbase::FileDispositionInfo;
    use winapi::um::winnt::HANDLE;

    let mut disposition = FILE_DISPOSITION_INFO {
        DeleteFile: TRUE as u8,
    };
    let deleted = unsafe {
        SetFileInformationByHandle(
            directory.as_raw_handle() as HANDLE,
            FileDispositionInfo,
            (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as DWORD,
        )
    };
    if deleted == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(crate) fn remove_bound_directory_tree(
    parent: &CapDir,
    name: &std::ffi::OsStr,
    label: &str,
) -> Result<(), String> {
    let Some(directory) = open_bound_directory_for_rename_optional(parent, name, label)? else {
        return Ok(());
    };

    remove_open_bound_directory_tree(directory, parent, name, label)
}

pub(crate) fn remove_open_bound_directory_tree(
    directory: CapDir,
    _parent: &CapDir,
    _name: &std::ffi::OsStr,
    label: &str,
) -> Result<(), String> {
    use remove_dir_all::RemoveDir;
    let mut directory = directory.into_std_file();
    directory
        .remove_dir_contents(None)
        .map_err(|err| format!("Unable to empty {label} safely: {err}"))?;

    #[cfg(windows)]
    delete_open_directory_handle(&directory)
        .map_err(|err| format!("Unable to remove the bound {label} leaf: {err}"))?;

    #[cfg(not(windows))]
    {
        drop(directory);
        _parent
            .remove_dir(_name)
            .map_err(|err| format!("Unable to remove the bound {label} leaf: {err}"))?;
    }

    Ok(())
}

fn remove_bound_directory_path(path: &Path, label: &str) -> Result<(), String> {
    let parent_path = path
        .parent()
        .ok_or_else(|| format!("The {label} path has no parent."))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("The {label} path has no directory name."))?;
    let Some(parent) = bind_absolute_directory_optional(parent_path, label)? else {
        return Ok(());
    };
    remove_bound_directory_tree(parent.leaf(), name, label)
}

fn remove_bound_empty_directory_path(path: &Path, label: &str) -> Result<(), String> {
    let parent_path = path
        .parent()
        .ok_or_else(|| format!("The {label} path has no parent."))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("The {label} path has no directory name."))?;
    let Some(parent) = bind_absolute_directory_optional(parent_path, label)? else {
        return Ok(());
    };
    let Some(directory) = open_bound_directory_for_rename_optional(parent.leaf(), name, label)?
    else {
        return Ok(());
    };

    #[cfg(windows)]
    match delete_open_directory_handle(&directory.into_std_file()) {
        Ok(()) => {}
        Err(err) if err.raw_os_error() == Some(145) => {}
        Err(err) => return Err(format!("Unable to remove the empty bound {label}: {err}")),
    }

    #[cfg(not(windows))]
    {
        drop(directory);
        parent
            .leaf()
            .remove_dir(name)
            .map_err(|err| format!("Unable to remove the empty bound {label}: {err}"))?;
    }

    Ok(())
}

fn read_nte_config_value_optional(
    config_dir: &Path,
    context: &str,
) -> Result<Option<serde_json::Value>, String> {
    let config_guard = bind_absolute_directory(config_dir, "NTE configuration")?;
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = match config_guard.leaf().open_with("configNTE.json", &options) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            if config_guard
                .leaf()
                .symlink_metadata("configNTE.json")
                .is_ok()
            {
                return Err(format!("NTE configuration {context} is not a safe file."));
            }
            return Err(format!(
                "Unable to open NTE configuration {context} without following links: {err}"
            ));
        }
    };
    let metadata = file
        .metadata()
        .map_err(|err| format!("Unable to inspect NTE configuration {context}: {err}"))?;
    if !metadata.is_file() || metadata.is_symlink() {
        return Err(format!("NTE configuration {context} is not a safe file."));
    }
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        use winapi::um::winnt::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("NTE configuration {context} is a reparse point."));
        }
    }
    let mut payload = Vec::new();
    file.read_to_end(&mut payload)
        .map_err(|err| format!("Unable to read NTE configuration {context}: {err}"))?;
    let config: serde_json::Value = serde_json::from_slice(&payload)
        .map_err(|err| format!("Invalid NTE configuration {context}: {err}"))?;
    if !config.is_object() {
        return Err(format!("NTE configuration {context} is not an object."));
    }
    if config.get("game").and_then(serde_json::Value::as_str) != Some("NTE") {
        return Err(format!(
            "NTE configuration {context} has the wrong game identity."
        ));
    }
    Ok(Some(config))
}

fn read_nte_config_value(config_dir: &Path, context: &str) -> Result<serde_json::Value, String> {
    read_nte_config_value_optional(config_dir, context)?
        .ok_or_else(|| format!("NTE configuration {context} does not exist."))
}

static NTE_OPERATION_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static NTE_OPERATION_COUNTER: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
thread_local! {
    static NTE_PROCESS_TEST_REMAINING_CLEAR_CHECKS: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
    static NTE_PROCESS_TEST_PAUSE_AT_STEP: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    static NTE_CLEANUP_TEST_FAIL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static NTE_CONFIG_CLEANUP_TEST_FAIL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(crate) fn lock_nte_operation() -> Result<MutexGuard<'static, ()>, String> {
    NTE_OPERATION_LOCK
        .lock()
        .map_err(|_| "NTE Mod operation lock is poisoned.".to_string())
}

fn open_nte_lock_handle(lock_path: &Path) -> Result<FileRwLock<fs::File>, String> {
    let parent = lock_path
        .parent()
        .ok_or_else(|| "NTE operation lock has no parent directory.".to_string())?;
    if !is_directory_without_reparse(parent) {
        return Err("NTE operation lock parent is missing or unsafe.".to_string());
    }
    match fs::symlink_metadata(lock_path) {
        Ok(metadata) if metadata_is_reparse(&metadata) || !metadata.is_file() => {
            return Err("NTE operation lock path is unsafe.".to_string());
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("Unable to inspect NTE operation lock: {err}")),
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|err| format!("Unable to open NTE operation lock: {err}"))?;
    let metadata = file
        .metadata()
        .map_err(|err| format!("Unable to inspect opened NTE operation lock: {err}"))?;
    if !metadata.is_file() {
        return Err("Opened NTE operation lock is not a regular file.".to_string());
    }
    Ok(FileRwLock::new(file))
}

fn validate_nte_wal_path(wal_path: &Path) -> Result<(), String> {
    let parent = wal_path
        .parent()
        .ok_or_else(|| "NTE transaction WAL has no parent directory.".to_string())?;
    if !is_directory_without_reparse(parent) {
        return Err("NTE transaction WAL parent is missing or unsafe.".to_string());
    }
    match fs::symlink_metadata(wal_path) {
        Ok(metadata) if metadata_is_reparse(&metadata) || !metadata.is_file() => {
            Err("NTE transaction WAL path is unsafe.".to_string())
        }
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Unable to inspect the NTE transaction WAL: {err}")),
    }
}

fn with_nte_lock_file<T, F>(lock_path: &Path, operation: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let _process_lock = lock_nte_operation()?;
    let mut file_lock = open_nte_lock_handle(lock_path)?;
    let _cross_process_lock = file_lock.try_write().map_err(|err| {
        if err.kind() == std::io::ErrorKind::WouldBlock {
            "Another IMM instance is already changing NTE Mods. Try again after it finishes."
                .to_string()
        } else {
            format!("Unable to acquire the NTE cross-process lock: {err}")
        }
    })?;
    operation()
}

fn validated_target_lock_path(
    mods_root: &Path,
    requested_region: Option<&str>,
) -> Result<PathBuf, String> {
    let validation = validate_mods_root(mods_root, requested_region);
    if !validation.valid {
        return Err(validation.message);
    }
    let trusted_mods_root = PathBuf::from(validation.mods_root);
    let content_root = trusted_mods_root
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "NTE target has no validated Content root.".to_string())?;
    if !is_directory_without_reparse(content_root) {
        return Err("NTE Content root is missing or unsafe.".to_string());
    }
    Ok(content_root.join(NTE_TARGET_LOCK_FILE))
}

#[cfg(test)]
fn with_nte_target_operation_lock<T, F>(
    mods_root: &Path,
    requested_region: Option<&str>,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce(&mut crate::nte_wal::WalJournal) -> Result<T, String>,
{
    let lock_path = validated_target_lock_path(mods_root, requested_region)?;
    let wal_path = lock_path.with_file_name(NTE_TARGET_WAL_FILE);
    with_nte_lock_file(&lock_path, || {
        let validation = validate_mods_root(mods_root, requested_region);
        if !validation.valid {
            return Err(validation.message);
        }
        let region = validation
            .region
            .as_deref()
            .and_then(NteRegion::parse)
            .ok_or_else(|| "Unable to determine the validated NTE region.".to_string())?;
        ensure_nte_processes_stopped(region)?;
        validate_nte_wal_path(&wal_path)?;
        let mut journal = crate::nte_wal::WalJournal::open(&wal_path)?;
        operation(&mut journal)
    })
}

fn with_nte_source_target_operation_locks<T, F>(
    trusted_library_root: &Path,
    mods_root: &Path,
    requested_region: Option<&str>,
    config_dir: Option<&Path>,
    expected_config: Option<&PersistedNteConfig>,
    always_require_stopped_processes: bool,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce(
        &mut crate::nte_wal::WalJournal,
        &mut crate::nte_wal::WalJournal,
    ) -> Result<T, String>,
{
    let library_parent = trusted_library_root;
    if !is_directory_without_reparse(library_parent) {
        return Err("NTE managed library root is missing or unsafe.".to_string());
    }
    let library_lock_path = library_parent.join(NTE_LIBRARY_LOCK_FILE);
    let library_wal_path = library_parent.join(NTE_LIBRARY_WAL_FILE);
    let target_lock_path = validated_target_lock_path(mods_root, requested_region)?;
    let target_wal_path = target_lock_path.with_file_name(NTE_TARGET_WAL_FILE);

    let _process_lock = lock_nte_operation()?;
    let mut library_file_lock = open_nte_lock_handle(&library_lock_path)?;
    let _library_guard = library_file_lock.try_write().map_err(|err| {
        if err.kind() == std::io::ErrorKind::WouldBlock {
            "Another IMM instance is changing this NTE library folder. Try again after it finishes."
                .to_string()
        } else {
            format!("Unable to acquire the NTE library lock: {err}")
        }
    })?;
    let mut target_file_lock = open_nte_lock_handle(&target_lock_path)?;
    let _target_guard = target_file_lock.try_write().map_err(|err| {
        if err.kind() == std::io::ErrorKind::WouldBlock {
            "Another IMM instance is changing the NTE target. Try again after it finishes."
                .to_string()
        } else {
            format!("Unable to acquire the NTE target lock: {err}")
        }
    })?;
    let mut config_file_lock = config_dir
        .map(|directory| open_nte_lock_handle(&directory.join(NTE_CONFIG_LOCK_FILE)))
        .transpose()?;
    let _config_guard = config_file_lock
        .as_mut()
        .map(|file_lock| {
            file_lock.try_write().map_err(|err| {
                if err.kind() == std::io::ErrorKind::WouldBlock {
                    "Another IMM instance is updating NTE configuration. Try again after it finishes."
                        .to_string()
                } else {
                    format!("Unable to acquire the NTE configuration lock: {err}")
                }
            })
        })
        .transpose()?;

    match (config_dir, expected_config) {
        (Some(directory), Some(expected)) => {
            ensure_persisted_nte_config_matches(directory, expected)?;
        }
        (None, None) | (Some(_), None) => {}
        (None, Some(_)) => {
            return Err("NTE configuration snapshot has no trusted config root.".to_string());
        }
    }

    let validation = validate_mods_root(mods_root, requested_region);
    if !validation.valid {
        return Err(validation.message);
    }
    let region = validation
        .region
        .as_deref()
        .and_then(NteRegion::parse)
        .ok_or_else(|| "Unable to determine the validated NTE region.".to_string())?;
    validate_nte_wal_path(&library_wal_path)?;
    validate_nte_wal_path(&target_wal_path)?;
    let mut library_journal = crate::nte_wal::WalJournal::open(&library_wal_path)?;
    let mut target_journal = crate::nte_wal::WalJournal::open(&target_wal_path)?;
    let recovery_requires_stopped_processes = library_journal.incomplete_transaction()?.is_some()
        || target_journal.incomplete_transaction()?.is_some();
    if always_require_stopped_processes || recovery_requires_stopped_processes {
        ensure_nte_processes_stopped(region)?;
    }
    crate::recover_nte_library_transaction_from_parent(library_parent, &mut library_journal)?;
    operation(&mut library_journal, &mut target_journal)
}

fn with_nte_config_operation_lock<T, F>(config_dir: &Path, operation: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    if !config_dir.is_absolute() || !is_directory_without_reparse(config_dir) {
        return Err("NTE configuration directory is missing or unsafe.".to_string());
    }
    with_nte_lock_file(&config_dir.join(NTE_CONFIG_LOCK_FILE), operation)
}

pub(crate) fn with_nte_library_operation_lock<T, F>(
    trusted_library_root: &Path,
    config_dir: Option<&Path>,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce(&mut crate::nte_wal::WalJournal) -> Result<T, String>,
{
    if !trusted_library_root.is_absolute() || !is_directory_without_reparse(trusted_library_root) {
        return Err("NTE managed library root is missing or unsafe.".to_string());
    }
    let _library_chain = bind_absolute_directory(trusted_library_root, "NTE managed library root")?;
    let lock_path = trusted_library_root.join(NTE_LIBRARY_LOCK_FILE);
    let wal_path = trusted_library_root.join(NTE_LIBRARY_WAL_FILE);
    with_nte_lock_file(&lock_path, || {
        let mut config_file_lock = config_dir
            .map(|directory| open_nte_lock_handle(&directory.join(NTE_CONFIG_LOCK_FILE)))
            .transpose()?;
        let _config_guard = config_file_lock
            .as_mut()
            .map(|file_lock| {
                file_lock.try_write().map_err(|err| {
                    if err.kind() == std::io::ErrorKind::WouldBlock {
                        "Another IMM instance is updating NTE configuration. Try again after it finishes."
                            .to_string()
                    } else {
                        format!("Unable to acquire the NTE configuration lock: {err}")
                    }
                })
            })
            .transpose()?;
        validate_nte_wal_path(&wal_path)?;
        let mut journal = crate::nte_wal::WalJournal::open(&wal_path)?;
        operation(&mut journal)
    })
}

pub(crate) fn trusted_nte_library_destination(
    trusted_library_root: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let relative = validate_relative_mod_path(relative_path)?;
    validate_existing_directory_chain(trusted_library_root, &relative)?;
    let destination = trusted_library_root.join(&relative);
    if normalized_path_for_comparison(&destination)
        != normalized_path_for_comparison(&trusted_library_root.join(relative))
    {
        return Err("NTE library destination escaped the persisted root.".to_string());
    }
    Ok(destination)
}

pub(crate) fn ensure_nte_library_destination_parent(
    trusted_library_root: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let relative = validate_relative_mod_path(relative_path)?;
    let destination = trusted_library_root.join(&relative);
    let parent_relative = relative
        .parent()
        .ok_or_else(|| "NTE library destination has no parent path.".to_string())?;
    let mut bound = bind_absolute_directory(trusted_library_root, "NTE managed library root")?;

    for component in parent_relative.components() {
        let Component::Normal(name) = component else {
            return Err("Invalid NTE library category path.".to_string());
        };
        let child = match open_bound_directory_optional(bound.leaf(), name, "NTE library category")?
        {
            Some(child) => child,
            None => {
                match bound.leaf().create_dir(Path::new(name)) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(err) => {
                        return Err(format!(
                            "Unable to create the NTE library category '{}': {err}",
                            name.to_string_lossy()
                        ))
                    }
                }
                open_bound_directory_optional(bound.leaf(), name, "NTE library category")?
                    .ok_or_else(|| {
                        format!(
                            "The created NTE library category '{}' is unavailable.",
                            name.to_string_lossy()
                        )
                    })?
            }
        };
        bound.handles.push(child);
    }

    if normalized_path_for_comparison(&destination)
        != normalized_path_for_comparison(&trusted_library_root.join(relative))
    {
        return Err("NTE library destination escaped the persisted root.".to_string());
    }
    Ok(destination)
}

fn canonical_nte_library_destination_optional(
    trusted_library_root: &Path,
    destination: &Path,
) -> Result<Option<PathBuf>, String> {
    if !destination.is_absolute() {
        return Ok(None);
    }
    let canonical = match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata_is_reparse(&metadata) || !metadata.is_dir() => {
            return Err(
                "The archive destination is a reparse point or unsupported entry.".to_string(),
            );
        }
        Ok(_) => destination
            .canonicalize()
            .map_err(|err| format!("Unable to resolve the archive destination: {err}"))?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let parent = destination
                .parent()
                .ok_or_else(|| "The archive destination has no parent.".to_string())?;
            let name = destination
                .file_name()
                .ok_or_else(|| "The archive destination has no name.".to_string())?;
            canonicalize_directory(parent, "archive destination parent")?.join(name)
        }
        Err(err) => return Err(format!("Unable to inspect the archive destination: {err}")),
    };
    let canonical_root = canonicalize_directory(trusted_library_root, "managed library root")?;
    let Ok(relative) = canonical.strip_prefix(&canonical_root) else {
        return Ok(None);
    };
    let relative = validate_relative_mod_path(&relative.to_string_lossy())?;
    validate_existing_directory_chain(&canonical_root, &relative)?;
    let expected = canonical_root.join(&relative);
    if normalized_path_for_comparison(&canonical) != normalized_path_for_comparison(&expected) {
        return Ok(None);
    }
    Ok(Some(trusted_library_root.join(relative)))
}

pub(crate) fn canonical_nte_library_destination(
    trusted_library_root: &Path,
    destination: &Path,
) -> Result<PathBuf, String> {
    canonical_nte_library_destination_optional(trusted_library_root, destination)?
        .ok_or_else(|| "NTE library destination escaped the persisted root.".to_string())
}

pub(crate) fn with_bound_nte_library_destination<T, F>(
    trusted_library_root: &Path,
    destination: &Path,
    operation: F,
) -> Result<T, String>
where
    F: FnOnce(&CapDir, &std::ffi::OsStr) -> Result<T, String>,
{
    let (destination_parent_chain, destination_name) =
        bind_nte_library_destination(trusted_library_root, destination)?;
    operation(destination_parent_chain.leaf(), &destination_name)
}

pub(crate) fn bind_nte_library_destination(
    trusted_library_root: &Path,
    destination: &Path,
) -> Result<(BoundDirectoryChain, OsString), String> {
    let expected = canonical_nte_library_destination(trusted_library_root, destination)?;
    let relative = expected
        .strip_prefix(trusted_library_root)
        .map_err(|_| "NTE library destination escaped the persisted root.".to_string())?;
    let relative_text = relative.to_string_lossy();
    let relative = validate_relative_mod_path(&relative_text)?;
    let expected = trusted_library_root.join(&relative);
    let parent = expected
        .parent()
        .ok_or_else(|| "NTE library destination has no parent directory.".to_string())?;
    let destination_name = expected
        .file_name()
        .ok_or_else(|| "NTE library destination has no directory name.".to_string())?;
    let destination_parent_chain =
        bind_absolute_directory(parent, "NTE archive destination parent")?;
    match fs::symlink_metadata(&expected) {
        Ok(metadata) if metadata_is_reparse(&metadata) || !metadata.is_dir() => {
            return Err(
                "The archive destination is a reparse point or unsupported entry.".to_string(),
            );
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("Unable to inspect the archive destination: {err}")),
    }
    Ok((destination_parent_chain, destination_name.to_os_string()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NteRegion {
    Global,
    Cn,
    Tw,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedNteConfig {
    source_dir: String,
    target_dir: String,
    #[serde(default)]
    nte_region: Option<String>,
}

struct TrustedNtePaths {
    source_path: PathBuf,
    source_library_root: PathBuf,
    mods_root: PathBuf,
    region: Option<String>,
    config_snapshot: PersistedNteConfig,
}

struct TrustedNteRoots {
    source_library_root: PathBuf,
    mods_root: PathBuf,
    region: Option<String>,
}

fn canonicalize_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !is_directory_without_reparse(path) {
        return Err(format!("The configured NTE {label} is missing or unsafe."));
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("Unable to resolve the configured NTE {label}: {err}"))?;
    if normalized_path_for_comparison(path) != normalized_path_for_comparison(&canonical)
        || !is_directory_without_reparse(&canonical)
    {
        return Err(format!(
            "The configured NTE {label} contains a symbolic link or reparse point."
        ));
    }
    Ok(canonical)
}

fn load_persisted_nte_config(config_dir: &Path) -> Result<PersistedNteConfig, String> {
    let config = read_nte_config_value(config_dir, "while loading persisted settings")?;
    serde_json::from_value(config)
        .map_err(|err| format!("Invalid persisted NTE configuration: {err}"))
}

fn normalized_config_region(region: Option<&str>) -> Option<String> {
    region
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

fn ensure_persisted_nte_config_matches(
    config_dir: &Path,
    expected: &PersistedNteConfig,
) -> Result<(), String> {
    let current = load_persisted_nte_config(config_dir)?;
    let same_source = normalized_path_for_comparison(Path::new(current.source_dir.trim()))
        == normalized_path_for_comparison(Path::new(expected.source_dir.trim()));
    let same_target = normalized_path_for_comparison(Path::new(current.target_dir.trim()))
        == normalized_path_for_comparison(Path::new(expected.target_dir.trim()));
    let same_region = normalized_config_region(current.nte_region.as_deref())
        == normalized_config_region(expected.nte_region.as_deref());
    if !same_source || !same_target || !same_region {
        return Err(
            "NTE source, target, or region changed before the operation acquired all locks."
                .to_string(),
        );
    }
    Ok(())
}

fn nte_config_revision(value: &serde_json::Value) -> Option<String> {
    value.get("updatedAt").and_then(|revision| match revision {
        serde_json::Value::String(value) => Some(value.clone()),
        serde_json::Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}

fn next_nte_config_revision() -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("Unable to create an NTE configuration revision: {err}"))?
        .as_nanos();
    let counter = NTE_OPERATION_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(format!("nte-{nanos}-{}-{counter}", std::process::id()))
}

fn write_nte_config_value(config_path: &Path, config: &serde_json::Value) -> Result<(), String> {
    let config_dir = config_path
        .parent()
        .ok_or_else(|| "NTE configuration path has no parent directory.".to_string())?;
    let _config_guard = bind_absolute_directory(config_dir, "NTE configuration")?;
    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|err| format!("Unable to serialize NTE configuration: {err}"))?;
    let mut output = AtomicWriteFile::open(config_path)
        .map_err(|err| format!("Unable to stage NTE configuration: {err}"))?;
    output
        .write_all(&serialized)
        .map_err(|err| format!("Unable to write NTE configuration: {err}"))?;
    output
        .commit()
        .map_err(|err| format!("Unable to commit NTE configuration: {err}"))
}

fn persist_nte_config_cas(
    config_dir: &Path,
    contents: &str,
    expected_updated_at: Option<&str>,
) -> Result<String, String> {
    let config_path = config_dir.join("configNTE.json");
    let incoming: serde_json::Value = serde_json::from_str(contents)
        .map_err(|err| format!("Invalid NTE configuration update: {err}"))?;
    if incoming.get("game").and_then(serde_json::Value::as_str) != Some("NTE") {
        return Err("NTE configuration update has the wrong game identity.".to_string());
    }
    let incoming_revision = nte_config_revision(&incoming)
        .ok_or_else(|| "NTE configuration update has no revision.".to_string())?;
    let current = read_nte_config_value_optional(config_dir, "before saving")?;
    let current_revision = current.as_ref().and_then(nte_config_revision);
    let revision_matches = match expected_updated_at {
        Some(expected) => current_revision.as_deref() == Some(expected),
        None => {
            current.is_none()
                || current_revision.is_none()
                || current_revision.as_deref() == Some(incoming_revision.as_str())
        }
    };
    if !revision_matches {
        return Err(
            "NTE configuration changed while this update was pending; reload before saving again."
                .to_string(),
        );
    }
    write_nte_config_value(&config_path, &incoming)?;
    Ok(incoming_revision)
}

fn read_nte_config_revision(config_dir: &Path) -> Result<String, String> {
    let config = read_nte_config_value(config_dir, "while reading the committed revision")?;
    nte_config_revision(&config)
        .ok_or_else(|| "Committed NTE configuration has no revision.".to_string())
}

fn persisted_nte_library_root_from_config(config: &PersistedNteConfig) -> Result<PathBuf, String> {
    if config.source_dir.trim().is_empty() {
        return Err("The persisted NTE source folder is empty.".to_string());
    }
    let source_root = canonicalize_directory(Path::new(&config.source_dir), "source root")?;
    canonicalize_directory(
        &source_root.join(MANAGED_SOURCE_DIR),
        "managed library root",
    )
}

pub(crate) fn persisted_nte_library_root(config_dir: &Path) -> Result<PathBuf, String> {
    let config = load_persisted_nte_config(config_dir)?;
    persisted_nte_library_root_from_config(&config)
}

pub(crate) fn persisted_nte_game_directories(
    config_dir: &Path,
) -> Result<(String, String), String> {
    let config = load_persisted_nte_config(config_dir)?;
    Ok((config.source_dir, config.target_dir))
}

#[cfg(test)]
fn is_persisted_nte_library_destination(
    config_dir: &Path,
    destination: &Path,
) -> Result<bool, String> {
    Ok(persisted_nte_library_root_for_destination(config_dir, destination)?.is_some())
}

pub(crate) fn persisted_nte_library_root_for_destination(
    config_dir: &Path,
    destination: &Path,
) -> Result<Option<PathBuf>, String> {
    let Some(config) = read_nte_config_value_optional(config_dir, "for archive routing")? else {
        return Ok(None);
    };
    let config: PersistedNteConfig = serde_json::from_value(config)
        .map_err(|err| format!("Invalid persisted NTE configuration: {err}"))?;
    let library_root = persisted_nte_library_root_from_config(&config)?;
    Ok(
        canonical_nte_library_destination_optional(&library_root, destination)?
            .map(|_| library_root),
    )
}

fn trusted_nte_paths_from_config(
    config_dir: &Path,
    relative_path: &str,
) -> Result<TrustedNtePaths, String> {
    let config = load_persisted_nte_config(config_dir)?;
    trusted_nte_paths_from_snapshot(config, relative_path)
}

fn trusted_nte_paths_from_snapshot(
    config: PersistedNteConfig,
    relative_path: &str,
) -> Result<TrustedNtePaths, String> {
    let roots = trusted_nte_roots_from_snapshot(&config)?;
    let relative = validate_relative_mod_path(relative_path)?;
    let source_library_root = roots.source_library_root;
    validate_existing_directory_chain(&source_library_root, &relative)?;
    let requested_source_path = source_library_root.join(&relative);
    let source_path = match fs::symlink_metadata(&requested_source_path) {
        Ok(metadata) if metadata_is_reparse(&metadata) || !metadata.is_dir() => {
            return Err("The requested NTE Mod is missing or unsafe.".to_string());
        }
        Ok(_) => canonicalize_directory(&requested_source_path, "managed Mod directory")?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => requested_source_path,
        Err(err) => return Err(format!("Unable to inspect the requested NTE Mod: {err}")),
    };
    if normalized_path_for_comparison(&source_path)
        != normalized_path_for_comparison(&source_library_root.join(&relative))
    {
        return Err("The requested NTE Mod is outside the persisted library root.".to_string());
    }

    Ok(TrustedNtePaths {
        source_path,
        source_library_root,
        mods_root: roots.mods_root,
        region: roots.region,
        config_snapshot: config,
    })
}

fn trusted_nte_roots_from_snapshot(config: &PersistedNteConfig) -> Result<TrustedNteRoots, String> {
    if config.source_dir.trim().is_empty() || config.target_dir.trim().is_empty() {
        return Err("The persisted NTE source or target folder is empty.".to_string());
    }
    let source_library_root = persisted_nte_library_root_from_config(config)?;
    let configured_target = PathBuf::from(&config.target_dir);
    let requested_region = config
        .nte_region
        .as_deref()
        .filter(|value| !value.eq_ignore_ascii_case("auto"));
    let validation = validate_mods_root(&configured_target, requested_region);
    if !validation.valid {
        return Err(validation.message);
    }
    let mods_root = PathBuf::from(validation.mods_root);
    if normalized_path_for_comparison(&configured_target)
        != normalized_path_for_comparison(&mods_root)
    {
        return Err(r"Persisted NTE target does not match Content\Paks\~mods.".to_string());
    }
    Ok(TrustedNteRoots {
        source_library_root,
        mods_root,
        region: validation.region,
    })
}

impl NteRegion {
    fn id(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Cn => "cn",
            Self::Tw => "tw",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "global" => Some(Self::Global),
            "cn" => Some(Self::Cn),
            "tw" => Some(Self::Tw),
            _ => None,
        }
    }

    fn launcher(self) -> &'static str {
        match self {
            Self::Global => "NTEGlobalLauncher.exe",
            Self::Cn => "NTELauncher.exe",
            Self::Tw => "NTETWLauncher.exe",
        }
    }

    fn nested_markers(self) -> (&'static str, [&'static str; 3]) {
        match self {
            Self::Global => (
                "NTEGlobal",
                [
                    "NTEGlobalGame.exe",
                    "NTEGlobalLauncher.exe",
                    "NTEGlobalUpdate.exe",
                ],
            ),
            Self::Cn => (
                "NTELauncher",
                ["NTEGame.exe", "NTELauncher.exe", "NTEUpdate.exe"],
            ),
            Self::Tw => (
                "NTETW",
                ["NTETWGame.exe", "NTETWLauncher.exe", "NTETWUpdate.exe"],
            ),
        }
    }

    fn related_processes(self) -> [&'static str; 5] {
        match self {
            Self::Global => [
                "HTGame.exe",
                "NTEGlobalGame.exe",
                "NTEGlobalLauncher.exe",
                "NTEGlobalUpdate.exe",
                "NTEGlobal.exe",
            ],
            Self::Cn => [
                "HTGame.exe",
                "NTEGame.exe",
                "NTELauncher.exe",
                "NTEUpdate.exe",
                "NevernessToEverness.exe",
            ],
            Self::Tw => [
                "HTGame.exe",
                "NTETWGame.exe",
                "NTETWLauncher.exe",
                "NTETWUpdate.exe",
                "NTETW.exe",
            ],
        }
    }
}

fn ensure_nte_processes_stopped(region: NteRegion) -> Result<(), String> {
    #[cfg(test)]
    {
        if let Some(remaining) = NTE_PROCESS_TEST_REMAINING_CLEAR_CHECKS.with(std::cell::Cell::get)
        {
            if remaining == 0 {
                return Err(
                    "NTE or its launcher is running. Close the game and launcher before changing Mods."
                        .to_string(),
                );
            }
            NTE_PROCESS_TEST_REMAINING_CLEAR_CHECKS.with(|checks| checks.set(Some(remaining - 1)));
            return Ok(());
        }
    }
    if crate::hotreload::is_any_process_executable_running(&region.related_processes())? {
        return Err(
            "NTE or its launcher is running. Close the game and launcher before changing Mods."
                .to_string(),
        );
    }
    Ok(())
}

fn validated_nte_region(
    mods_root: &Path,
    requested_region: Option<&str>,
) -> Result<NteRegion, String> {
    let validation = validate_mods_root(mods_root, requested_region);
    if !validation.valid {
        return Err(validation.message);
    }
    validation
        .region
        .as_deref()
        .and_then(NteRegion::parse)
        .ok_or_else(|| "Unable to determine the validated NTE region.".to_string())
}

fn ensure_stopped_before_first_mutation(
    journal: &mut crate::nte_wal::WalJournal,
    transaction_id: [u8; 16],
    region: NteRegion,
) -> Result<(), String> {
    match ensure_nte_processes_stopped(region) {
        Ok(()) => Ok(()),
        Err(err) => {
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::StepReceipt,
                br#"{"step":"process_recheck","outcome":"aborted_before_mutation"}"#,
            )?;
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::AbortedBefore,
                b"{}",
            )?;
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::CleanupComplete,
                br#"{"cleanup":"not_required"}"#,
            )?;
            Err(err)
        }
    }
}

struct NteMutationMonitor<'a> {
    journal: &'a mut crate::nte_wal::WalJournal,
    transaction_id: [u8; 16],
    region: NteRegion,
    paused: bool,
    paths: NteMutationPaths,
}

impl NteMutationMonitor<'_> {
    fn before_step(&mut self, step: &str) -> Result<(), String> {
        if self.paused {
            return Err(
                "NTE transaction is paused because the game or launcher started.".to_string(),
            );
        }
        #[cfg(test)]
        let injected_pause = NTE_PROCESS_TEST_PAUSE_AT_STEP.with(|target| {
            target
                .borrow()
                .as_deref()
                .is_some_and(|target| target == step)
        });
        #[cfg(not(test))]
        let injected_pause = false;
        let process_status = if injected_pause {
            Err(
                "NTE or its launcher is running. Close the game and launcher before changing Mods."
                    .to_string(),
            )
        } else {
            ensure_nte_processes_stopped(self.region)
        };
        if let Err(process_err) = process_status {
            // Once a process is observed, this invocation must not attempt recovery even if
            // persisting the pause receipt has an uncertain outcome.
            self.paused = true;
            let payload = serde_json::to_vec(&serde_json::json!({
                "step": step,
                "outcome": "paused_external_process",
            }))
            .map_err(|err| format!("Unable to serialize the NTE pause receipt: {err}"))?;
            self.journal.append(
                self.transaction_id,
                crate::nte_wal::WalState::PausedExternalProcess,
                &payload,
            )?;
            return Err(process_err);
        }
        Ok(())
    }
}

fn mutation_checkpoint(
    monitor: &mut Option<&mut NteMutationMonitor<'_>>,
    step: &str,
) -> Result<(), String> {
    if let Some(monitor) = monitor.as_deref_mut() {
        monitor.before_step(step)
    } else {
        Ok(())
    }
}

fn cleanup_or_defer<F>(
    monitor: &mut Option<&mut NteMutationMonitor<'_>>,
    path: &Path,
    cleanup: &F,
) -> std::io::Result<()>
where
    F: Fn(&Path) -> std::io::Result<()>,
{
    if monitor.is_some() {
        // WAL terminal/recovery cleanup owns this artifact. Reopening the path
        // here or after recovery could delete a replacement object.
        Ok(())
    } else {
        cleanup(path)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NteGameRootValidation {
    valid: bool,
    root: String,
    region: Option<String>,
    candidates: Vec<String>,
    mods_root: String,
    launcher_path: String,
    game_executable_path: String,
    evidence: Vec<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NteModOperationResult {
    enabled: bool,
    destination: String,
    payload_files: usize,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    config_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NteDeploymentFile {
    relative_path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NteDeploymentManifest {
    schema_version: u32,
    relative_path: String,
    files: Vec<NteDeploymentFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NteDeletePresetSnapshot {
    index: usize,
    data: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NteDeleteConfigPlan {
    before_revision: Option<serde_json::Value>,
    after_revision: String,
    data_entry: Option<serde_json::Value>,
    preset_data: Vec<NteDeletePresetSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NteTargetWalPlan {
    operation: String,
    relative_path: String,
    #[serde(default)]
    new_relative_path: Option<String>,
    enabled: bool,
    before_destination: Option<NteDeploymentManifest>,
    after_destination: Option<NteDeploymentManifest>,
    before_state: Option<NteDeploymentManifest>,
    #[serde(default)]
    target_staging_name: Option<String>,
    #[serde(default)]
    target_backup_name: Option<String>,
    #[serde(default)]
    target_quarantine_name: Option<String>,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    source_hash: Option<String>,
    #[serde(default)]
    source_quarantine_name: Option<String>,
    #[serde(default)]
    delete_config: Option<NteDeleteConfigPlan>,
}

#[derive(Debug, Clone, Default)]
struct NteMutationPaths {
    staging: Option<PathBuf>,
    backup: Option<PathBuf>,
    disable: Option<PathBuf>,
}

fn join_components(root: &Path, components: &[&str]) -> PathBuf {
    components
        .iter()
        .fold(root.to_path_buf(), |path, component| path.join(component))
}

fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn is_regular_file_without_reparse(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_file() && !metadata_is_reparse(&metadata))
}

fn is_directory_without_reparse(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_dir() && !metadata_is_reparse(&metadata))
}

fn shared_markers(root: &Path) -> (bool, Vec<String>) {
    let game_exe = join_components(root, SHARED_GAME_EXE);
    let paks = join_components(root, PAKS_COMPONENTS);
    let global_utoc = paks.join("global.utoc");
    let global_ucas = paks.join("global.ucas");
    let checks = [
        ("shared game executable", game_exe),
        ("global.utoc", global_utoc),
        ("global.ucas", global_ucas),
    ];
    let mut valid = true;
    let evidence = checks
        .into_iter()
        .map(|(label, path)| {
            let present = is_regular_file_without_reparse(&path);
            valid &= present;
            format!("{label}: {}", if present { "present" } else { "missing" })
        })
        .collect();
    (valid, evidence)
}

fn region_is_valid(root: &Path, region: NteRegion) -> (bool, Vec<String>) {
    let launcher = root.join(region.launcher());
    let (folder, nested_files) = region.nested_markers();
    let nested_root = root.join(folder);
    let mut checks = vec![
        (
            format!("{} root launcher", region.id()),
            is_regular_file_without_reparse(&launcher),
        ),
        (
            format!("{} launcher directory", region.id()),
            is_directory_without_reparse(&nested_root),
        ),
    ];
    checks.extend(nested_files.into_iter().map(|name| {
        (
            format!("{} marker {name}", region.id()),
            is_regular_file_without_reparse(&nested_root.join(name)),
        )
    }));
    let valid = checks.iter().all(|(_, present)| *present);
    (
        valid,
        checks
            .into_iter()
            .map(|(label, present)| {
                format!("{label}: {}", if present { "present" } else { "missing" })
            })
            .collect(),
    )
}

pub fn validate_game_root(path: &Path, requested_region: Option<&str>) -> NteGameRootValidation {
    if !is_directory_without_reparse(path) {
        let root_text = path.to_string_lossy().to_string();
        return NteGameRootValidation {
            valid: false,
            root: root_text.clone(),
            region: None,
            candidates: Vec::new(),
            mods_root: join_components(path, MODS_COMPONENTS)
                .to_string_lossy()
                .to_string(),
            launcher_path: String::new(),
            game_executable_path: join_components(path, SHARED_GAME_EXE)
                .to_string_lossy()
                .to_string(),
            evidence: vec!["selected root: missing or reparse point".to_string()],
            message: "The selected NTE game root does not exist or is unsafe.".to_string(),
        };
    }
    let root = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let root_text = root.to_string_lossy().to_string();
    let mods_root = join_components(&root, MODS_COMPONENTS);
    let game_executable = join_components(&root, SHARED_GAME_EXE);

    if !is_directory_without_reparse(&root) {
        return NteGameRootValidation {
            valid: false,
            root: root_text,
            region: None,
            candidates: Vec::new(),
            mods_root: mods_root.to_string_lossy().to_string(),
            launcher_path: String::new(),
            game_executable_path: game_executable.to_string_lossy().to_string(),
            evidence: vec!["selected root: missing or reparse point".to_string()],
            message: "The selected NTE game root does not exist or is unsafe.".to_string(),
        };
    }

    let (shared_valid, mut evidence) = shared_markers(&root);
    let mut region_evidence = BTreeMap::new();
    let candidates = [NteRegion::Global, NteRegion::Cn, NteRegion::Tw]
        .into_iter()
        .filter(|region| {
            let (valid, detail) = region_is_valid(&root, *region);
            region_evidence.insert(region.id(), detail);
            valid
        })
        .collect::<Vec<_>>();
    let candidate_ids = candidates
        .iter()
        .map(|region| region.id().to_string())
        .collect::<Vec<_>>();

    let requested = match requested_region {
        Some(value) if !value.trim().is_empty() && !value.eq_ignore_ascii_case("auto") => {
            match NteRegion::parse(value) {
                Some(region) => Some(region),
                None => {
                    return NteGameRootValidation {
                        valid: false,
                        root: root_text,
                        region: None,
                        candidates: candidate_ids,
                        mods_root: mods_root.to_string_lossy().to_string(),
                        launcher_path: String::new(),
                        game_executable_path: game_executable.to_string_lossy().to_string(),
                        evidence,
                        message: "Unsupported NTE region override.".to_string(),
                    };
                }
            }
        }
        _ => None,
    };

    let selected = if let Some(requested) = requested {
        candidates.contains(&requested).then_some(requested)
    } else if candidates.len() == 1 {
        candidates.first().copied()
    } else {
        None
    };
    if let Some(region) = selected {
        evidence.extend(region_evidence.remove(region.id()).unwrap_or_default());
        let valid = shared_valid;
        return NteGameRootValidation {
            valid,
            root: root_text,
            region: valid.then(|| region.id().to_string()),
            candidates: candidate_ids,
            mods_root: mods_root.to_string_lossy().to_string(),
            launcher_path: root.join(region.launcher()).to_string_lossy().to_string(),
            game_executable_path: game_executable.to_string_lossy().to_string(),
            evidence,
            message: if valid {
                format!("Validated NTE {} game root.", region.id())
            } else {
                "The NTE launcher was found, but required game content is missing.".to_string()
            },
        };
    }

    for details in region_evidence.into_values() {
        evidence.extend(details);
    }
    let message = if candidates.len() > 1 {
        "Multiple NTE region marker sets were found. Select a region explicitly.".to_string()
    } else if requested.is_some() {
        "The selected region does not match the NTE launcher files in this folder.".to_string()
    } else {
        "No complete Global, CN, or TW NTE installation was found in this folder.".to_string()
    };
    NteGameRootValidation {
        valid: false,
        root: root_text,
        region: None,
        candidates: candidate_ids,
        mods_root: mods_root.to_string_lossy().to_string(),
        launcher_path: String::new(),
        game_executable_path: game_executable.to_string_lossy().to_string(),
        evidence,
        message,
    }
}

fn game_root_from_mods_root(mods_root: &Path) -> Option<PathBuf> {
    let suffix = MODS_COMPONENTS.iter().rev();
    let mut cursor = mods_root;
    for expected in suffix {
        let actual = cursor.file_name()?.to_string_lossy();
        if !actual.eq_ignore_ascii_case(expected) {
            return None;
        }
        cursor = cursor.parent()?;
    }
    Some(cursor.to_path_buf())
}

fn invalid_mods_root_validation(mods_root: &Path, message: &str) -> NteGameRootValidation {
    NteGameRootValidation {
        valid: false,
        root: String::new(),
        region: None,
        candidates: Vec::new(),
        mods_root: mods_root.to_string_lossy().to_string(),
        launcher_path: String::new(),
        game_executable_path: String::new(),
        evidence: vec![message.to_string()],
        message: message.to_string(),
    }
}

fn validate_mods_root(mods_root: &Path, requested_region: Option<&str>) -> NteGameRootValidation {
    let Some(game_root) = game_root_from_mods_root(mods_root) else {
        return invalid_mods_root_validation(
            mods_root,
            "NTE target is not a Content\\Paks\\~mods directory.",
        );
    };
    let validation = validate_game_root(&game_root, requested_region);
    if !validation.valid {
        return validation;
    }
    let trusted_mods_root = join_components(Path::new(&validation.root), MODS_COMPONENTS);
    if normalized_path_for_comparison(mods_root)
        != normalized_path_for_comparison(&trusted_mods_root)
    {
        return invalid_mods_root_validation(
            mods_root,
            "NTE target does not match the validated Content\\Paks\\~mods directory.",
        );
    }
    if let Err(err) = validate_existing_directory_chain(
        Path::new(&validation.root),
        Path::new(&MODS_COMPONENTS.join("\\")),
    ) {
        return invalid_mods_root_validation(mods_root, &err);
    }
    validation
}

fn validate_relative_mod_path(value: &str) -> Result<PathBuf, String> {
    let normalized = value.replace('/', "\\");
    let path = PathBuf::from(normalized);
    let components = path.components().collect::<Vec<_>>();
    if components.is_empty()
        || components.len() > 8
        || components.iter().any(|component| {
            !matches!(component, Component::Normal(_))
                || component.as_os_str().to_string_lossy().contains(':')
        })
    {
        return Err("Invalid NTE mod path.".to_string());
    }
    Ok(path)
}

fn payload_entries(source: &Path) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let mut pending = vec![source.to_path_buf()];
    let mut files = Vec::new();
    let mut has_pak = false;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|err| err.to_string())?;
            if metadata_is_reparse(&metadata) {
                return Err("NTE source Mod contains a symbolic link or reparse point.".to_string());
            }
            if metadata.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !metadata.is_file() {
                return Err("NTE source Mod contains an unsupported filesystem entry.".to_string());
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.starts_with("preview.") {
                continue;
            }
            let extension = entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            if !ALLOWED_PAYLOAD_EXTENSIONS.contains(&extension.as_str()) {
                return Err(format!(
                    "NTE deployment rejected unsupported file '{}'.",
                    entry.path().display()
                ));
            }
            has_pak |= extension == "pak";
            let relative = entry
                .path()
                .strip_prefix(source)
                .map_err(|_| "Unable to resolve NTE payload path.".to_string())?
                .to_path_buf();
            files.push((relative, entry.path()));
        }
    }
    if !has_pak {
        return Err("NTE Mod does not contain a .pak payload.".to_string());
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn copy_payload_to_staging(
    source_files: &[(PathBuf, PathBuf)],
    staging: &Path,
    monitor: &mut Option<&mut NteMutationMonitor<'_>>,
) -> Result<(), String> {
    mutation_checkpoint(monitor, "create_staging")?;
    if let Some(parent) = staging.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::create_dir_all(staging).map_err(|err| err.to_string())?;
    for (relative, source) in source_files {
        let destination = staging.join(relative);
        mutation_checkpoint(monitor, "copy_payload_file")?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut input = fs::File::open(source).map_err(|err| err.to_string())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|err| err.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|err| err.to_string())?;
        output.sync_all().map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let left_metadata = fs::metadata(left).map_err(|err| err.to_string())?;
    let right_metadata = fs::metadata(right).map_err(|err| err.to_string())?;
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }
    let mut left = fs::File::open(left).map_err(|err| err.to_string())?;
    let mut right = fs::File::open(right).map_err(|err| err.to_string())?;
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let left_read = left.read(&mut left_buffer).map_err(|err| err.to_string())?;
        let right_read = right
            .read(&mut right_buffer)
            .map_err(|err| err.to_string())?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|err| err.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn source_tree_hash(root: &Path) -> Result<String, String> {
    const MAX_ENTRIES: usize = 20_000;
    const MAX_BYTES: u64 = 20 * 1024 * 1024 * 1024;
    if !is_directory_without_reparse(root) {
        return Err("NTE source Mod is missing or unsafe.".to_string());
    }
    let mut pending = vec![root.to_path_buf()];
    let mut entries = Vec::new();
    let mut total_bytes = 0u64;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|err| err.to_string())?;
            if metadata_is_reparse(&metadata) {
                return Err("NTE source tree contains a reparse point.".to_string());
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "NTE source entry escaped its root.".to_string())?;
            let relative = normalized_relative_path(relative)?;
            if metadata.is_dir() {
                entries.push((format!("d:{relative}"), None));
                pending.push(path);
            } else if metadata.is_file() {
                total_bytes = total_bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| "NTE source size overflow.".to_string())?;
                if total_bytes > MAX_BYTES {
                    return Err("NTE source tree exceeds the 20 GiB limit.".to_string());
                }
                entries.push((format!("f:{relative}:{}", metadata.len()), Some(path)));
            } else {
                return Err("NTE source tree contains an unsupported entry.".to_string());
            }
            if entries.len() > MAX_ENTRIES {
                return Err("NTE source tree exceeds the 20,000 entry limit.".to_string());
            }
        }
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut tree_hasher = Sha256::new();
    for (descriptor, file_path) in entries {
        tree_hasher.update((descriptor.len() as u64).to_le_bytes());
        tree_hasher.update(descriptor.as_bytes());
        if let Some(file_path) = file_path {
            tree_hasher.update(sha256_file(&file_path)?.as_bytes());
        }
    }
    Ok(format!("{:x}", tree_hasher.finalize()))
}

fn optional_source_tree_hash(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => source_tree_hash(path).map(Some),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Unable to inspect the NTE source state: {err}")),
    }
}

fn captured_source_tree_hash(
    path: &Path,
    captured: Option<&BoundDirectoryLeaf>,
) -> Result<Option<String>, String> {
    match captured {
        Some(_) => source_tree_hash(path).map(Some),
        None => Ok(None),
    }
}

fn normalized_relative_path(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|value| value.replace('\\', "/"))
        .ok_or_else(|| "NTE payload path is not valid Unicode.".to_string())
}

fn build_deployment_manifest(
    relative_path: &Path,
    source_files: &[(PathBuf, PathBuf)],
) -> Result<NteDeploymentManifest, String> {
    let mut files = Vec::with_capacity(source_files.len());
    for (relative, source) in source_files {
        let metadata = fs::metadata(source).map_err(|err| err.to_string())?;
        files.push(NteDeploymentFile {
            relative_path: normalized_relative_path(relative)?,
            size: metadata.len(),
            sha256: sha256_file(source)?,
        });
    }
    Ok(NteDeploymentManifest {
        schema_version: 1,
        relative_path: normalized_relative_path(relative_path)?,
        files,
    })
}

fn deployment_manifest_path(state_root: &Path, mods_root: &Path, relative_path: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(normalized_path_for_comparison(mods_root).as_bytes());
    hasher.update([0]);
    hasher.update(
        normalized_relative_path(relative_path)
            .unwrap_or_default()
            .as_bytes(),
    );
    state_root.join(format!("{:x}.json", hasher.finalize()))
}

fn write_deployment_manifest(path: &Path, manifest: &NteDeploymentManifest) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "NTE deployment manifest has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let payload = serde_json::to_vec_pretty(manifest).map_err(|err| err.to_string())?;
    let mut output = AtomicWriteFile::open(path).map_err(|err| err.to_string())?;
    output.write_all(&payload).map_err(|err| err.to_string())?;
    output.commit().map_err(|err| err.to_string())
}

fn read_deployment_manifest(
    path: &Path,
    expected_relative_path: &Path,
) -> Result<Option<NteDeploymentManifest>, String> {
    let payload = match fs::read(path) {
        Ok(payload) => payload,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    let manifest: NteDeploymentManifest = serde_json::from_slice(&payload)
        .map_err(|err| format!("NTE deployment manifest is invalid: {err}"))?;
    if manifest.schema_version != 1
        || manifest.relative_path != normalized_relative_path(expected_relative_path)?
        || manifest.files.is_empty()
    {
        return Err("NTE deployment manifest does not match this Mod.".to_string());
    }
    Ok(Some(manifest))
}

fn destination_matches_manifest(
    manifest: &NteDeploymentManifest,
    destination: &Path,
) -> Result<bool, String> {
    if !is_directory_without_reparse(destination) {
        return Err("NTE target is missing or contains a reparse point.".to_string());
    }

    let mut expected_directories = BTreeSet::new();
    let mut expected_files = BTreeMap::new();
    for file in &manifest.files {
        let relative = validate_relative_mod_path(&file.relative_path)?;
        let extension = relative
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        if !ALLOWED_PAYLOAD_EXTENSIONS.contains(&extension.as_str()) {
            return Err("NTE deployment manifest contains an unsupported payload.".to_string());
        }
        let mut parent = relative.parent();
        while let Some(directory) = parent {
            if directory.as_os_str().is_empty() {
                break;
            }
            expected_directories.insert(directory.to_path_buf());
            parent = directory.parent();
        }
        if expected_files.insert(relative, file).is_some() {
            return Err("NTE deployment manifest contains duplicate paths.".to_string());
        }
    }

    let mut actual_directories = BTreeSet::new();
    let mut actual_files = BTreeMap::new();
    let mut pending = vec![destination.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|err| err.to_string())?;
            if metadata_is_reparse(&metadata) {
                return Err("NTE target contains a symbolic link or reparse point.".to_string());
            }
            let relative = path
                .strip_prefix(destination)
                .map_err(|_| "Unable to resolve NTE target payload path.".to_string())?
                .to_path_buf();
            if metadata.is_dir() {
                actual_directories.insert(relative);
                pending.push(path);
            } else if metadata.is_file() {
                actual_files.insert(relative, (path, metadata.len()));
            } else {
                return Err("NTE target contains an unsupported filesystem entry.".to_string());
            }
        }
    }

    if actual_directories != expected_directories || actual_files.len() != expected_files.len() {
        return Ok(false);
    }
    for (relative, expected) in expected_files {
        let Some((actual, size)) = actual_files.get(&relative) else {
            return Ok(false);
        };
        if *size != expected.size || sha256_file(actual)? != expected.sha256 {
            return Ok(false);
        }
    }
    Ok(true)
}

fn destination_matches_source(
    source_files: &[(PathBuf, PathBuf)],
    destination: &Path,
) -> Result<bool, String> {
    if !is_directory_without_reparse(destination) {
        return Err("NTE target is missing or contains a reparse point.".to_string());
    }

    let mut expected_directories = BTreeSet::new();
    let mut expected_files = BTreeMap::new();
    for (relative, source) in source_files {
        expected_files.insert(relative.clone(), source.clone());
        let mut parent = relative.parent();
        while let Some(directory) = parent {
            if directory.as_os_str().is_empty() {
                break;
            }
            expected_directories.insert(directory.to_path_buf());
            parent = directory.parent();
        }
    }

    let mut actual_directories = BTreeSet::new();
    let mut actual_files = BTreeMap::new();
    let mut pending = vec![destination.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|err| err.to_string())?;
            if metadata_is_reparse(&metadata) {
                return Err("NTE target contains a symbolic link or reparse point.".to_string());
            }
            let relative = path
                .strip_prefix(destination)
                .map_err(|_| "Unable to resolve NTE target payload path.".to_string())?
                .to_path_buf();
            if metadata.is_dir() {
                actual_directories.insert(relative);
                pending.push(path);
            } else if metadata.is_file() {
                let extension = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .unwrap_or_default();
                if !ALLOWED_PAYLOAD_EXTENSIONS.contains(&extension.as_str()) {
                    return Err(format!(
                        "NTE target contains unsupported file '{}'.",
                        path.display()
                    ));
                }
                actual_files.insert(relative, path);
            } else {
                return Err("NTE target contains an unsupported filesystem entry.".to_string());
            }
        }
    }

    if actual_directories != expected_directories || actual_files.len() != expected_files.len() {
        return Ok(false);
    }
    for (relative, source) in expected_files {
        let Some(actual) = actual_files.get(&relative) else {
            return Ok(false);
        };
        if !files_equal(&source, actual)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn optional_manifest_for_destination(
    relative: &Path,
    destination: &Path,
) -> Result<Option<NteDeploymentManifest>, String> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata_is_reparse(&metadata) || !metadata.is_dir() => {
            Err("NTE target is unsafe.".to_string())
        }
        Ok(_) => {
            let files = payload_entries(destination)?;
            build_deployment_manifest(relative, &files).map(Some)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Unable to inspect the NTE target: {err}")),
    }
}

fn captured_manifest_for_destination(
    relative: &Path,
    destination: &Path,
    captured: Option<&BoundDirectoryLeaf>,
) -> Result<Option<NteDeploymentManifest>, String> {
    match captured {
        Some(_) => optional_manifest_for_destination(relative, destination),
        None => Ok(None),
    }
}

fn optional_manifest_file(
    manifest_path: &Path,
    relative: &Path,
) -> Result<Option<NteDeploymentManifest>, String> {
    read_deployment_manifest(manifest_path, relative)
}

fn persist_optional_manifest(
    manifest_path: &Path,
    manifest: Option<&NteDeploymentManifest>,
) -> Result<(), String> {
    if let Some(manifest) = manifest {
        write_deployment_manifest(manifest_path, manifest)
    } else {
        match fs::remove_file(manifest_path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("Unable to remove NTE deployment state: {err}")),
        }
    }
}

fn rewrite_nte_config_rename(
    config_dir: &Path,
    old_relative: &str,
    new_relative: &str,
    roll_forward: bool,
) -> Result<String, String> {
    let old_relative = old_relative.replace('/', "\\");
    let new_relative = new_relative.replace('/', "\\");
    let config_path = config_dir.join("configNTE.json");
    let mut config = read_nte_config_value(config_dir, "during rename")?;
    let (from, to) = if roll_forward {
        (old_relative.as_str(), new_relative.as_str())
    } else {
        (new_relative.as_str(), old_relative.as_str())
    };
    if let Some(data) = config
        .get_mut("data")
        .and_then(serde_json::Value::as_object_mut)
    {
        match (data.contains_key(from), data.contains_key(to)) {
            (true, false) => {
                let value = data
                    .remove(from)
                    .ok_or_else(|| "NTE rename metadata disappeared.".to_string())?;
                data.insert(to.to_string(), value);
            }
            (false, true) | (false, false) => {}
            (true, true) => {
                return Err(
                    "NTE rename metadata contains both old and new paths; repair is required."
                        .to_string(),
                );
            }
        }
    }
    if let Some(presets) = config
        .get_mut("presets")
        .and_then(serde_json::Value::as_array_mut)
    {
        for preset in presets {
            let Some(items) = preset
                .get_mut("data")
                .and_then(serde_json::Value::as_array_mut)
            else {
                continue;
            };
            for item in items {
                if item.as_str() == Some(from) {
                    *item = serde_json::Value::String(to.to_string());
                }
            }
        }
    }
    let revision = next_nte_config_revision()?;
    let object = config
        .as_object_mut()
        .ok_or_else(|| "NTE configuration root is not an object.".to_string())?;
    object.insert(
        "updatedAt".to_string(),
        serde_json::Value::String(revision.clone()),
    );
    // A path rename with no metadata still fences renderer snapshots created before it.
    write_nte_config_value(&config_path, &config)?;
    Ok(revision)
}

fn nte_delete_metadata_snapshot(
    config: &serde_json::Value,
    relative_path: &str,
) -> Result<(Option<serde_json::Value>, Vec<NteDeletePresetSnapshot>), String> {
    let relative_path = relative_path.replace('/', "\\");
    let data_entry = match config.get("data") {
        Some(serde_json::Value::Object(data)) => data.get(&relative_path).cloned(),
        Some(_) => return Err("NTE configuration data is not an object.".to_string()),
        None => None,
    };
    let mut preset_data = Vec::new();
    match config.get("presets") {
        Some(serde_json::Value::Array(presets)) => {
            for (index, preset) in presets.iter().enumerate() {
                let Some(data) = preset.get("data") else {
                    continue;
                };
                let data = data
                    .as_array()
                    .ok_or_else(|| "NTE preset data is not an array.".to_string())?;
                if data
                    .iter()
                    .any(|item| item.as_str() == Some(relative_path.as_str()))
                {
                    preset_data.push(NteDeletePresetSnapshot {
                        index,
                        data: data.clone(),
                    });
                }
            }
        }
        Some(_) => return Err("NTE configuration presets is not an array.".to_string()),
        None => {}
    }
    Ok((data_entry, preset_data))
}

fn prepare_nte_delete_config_plan(
    config_dir: &Path,
    relative_path: &str,
) -> Result<NteDeleteConfigPlan, String> {
    let config = read_nte_config_value(config_dir, "before delete")?;
    if config.get("updatedAt").is_some() && nte_config_revision(&config).is_none() {
        return Err("NTE configuration has an invalid revision before delete.".to_string());
    }
    let (data_entry, preset_data) = nte_delete_metadata_snapshot(&config, relative_path)?;
    Ok(NteDeleteConfigPlan {
        before_revision: config.get("updatedAt").cloned(),
        after_revision: next_nte_config_revision()?,
        data_entry,
        preset_data,
    })
}

fn set_nte_config_revision_value(
    config: &mut serde_json::Value,
    revision: Option<serde_json::Value>,
) -> Result<(), String> {
    let object = config
        .as_object_mut()
        .ok_or_else(|| "NTE configuration root is not an object.".to_string())?;
    match revision {
        Some(revision) => {
            object.insert("updatedAt".to_string(), revision);
        }
        None => {
            object.remove("updatedAt");
        }
    }
    Ok(())
}

fn complete_nte_delete_config(
    config_dir: Option<&Path>,
    relative_path: &str,
    plan: Option<&NteDeleteConfigPlan>,
) -> Result<Option<String>, String> {
    let Some(plan) = plan else {
        return Ok(None);
    };
    let config_dir = config_dir
        .ok_or_else(|| "Committed NTE delete has no persisted config root.".to_string())?;
    let mut config = read_nte_config_value(config_dir, "during delete cleanup")?;
    let current_revision = nte_config_revision(&config);
    let before_revision = plan
        .before_revision
        .as_ref()
        .and_then(|value| nte_config_revision(&serde_json::json!({ "updatedAt": value })));
    let current_snapshot = nte_delete_metadata_snapshot(&config, relative_path)?;
    if current_revision.as_deref() == Some(plan.after_revision.as_str()) {
        if current_snapshot.0.is_none() && current_snapshot.1.is_empty() {
            return Ok(Some(plan.after_revision.clone()));
        }
        return Err(
            "Committed NTE delete configuration is not clean at its after revision.".to_string(),
        );
    }
    if current_revision != before_revision {
        return Err(
            "NTE configuration changed before committed delete cleanup; reload and repair are required."
                .to_string(),
        );
    }
    if current_snapshot.0 != plan.data_entry || current_snapshot.1 != plan.preset_data {
        return Err(
            "NTE delete metadata changed before filesystem commit; repair is required.".to_string(),
        );
    }
    let relative_path = relative_path.replace('/', "\\");
    if let Some(data) = config
        .get_mut("data")
        .and_then(serde_json::Value::as_object_mut)
    {
        data.remove(&relative_path);
    }
    if let Some(presets) = config
        .get_mut("presets")
        .and_then(serde_json::Value::as_array_mut)
    {
        for preset in presets {
            if let Some(data) = preset
                .get_mut("data")
                .and_then(serde_json::Value::as_array_mut)
            {
                data.retain(|item| item.as_str() != Some(relative_path.as_str()));
            }
        }
    }
    set_nte_config_revision_value(
        &mut config,
        Some(serde_json::Value::String(plan.after_revision.clone())),
    )?;
    #[cfg(test)]
    if NTE_CONFIG_CLEANUP_TEST_FAIL.with(std::cell::Cell::get) {
        return Err("Injected NTE delete configuration cleanup failure.".to_string());
    }
    write_nte_config_value(&config_dir.join("configNTE.json"), &config)?;
    Ok(Some(plan.after_revision.clone()))
}

fn restore_nte_delete_config(
    config_dir: Option<&Path>,
    relative_path: &str,
    plan: Option<&NteDeleteConfigPlan>,
) -> Result<(), String> {
    let Some(plan) = plan else {
        return Ok(());
    };
    let config_dir =
        config_dir.ok_or_else(|| "Aborted NTE delete has no persisted config root.".to_string())?;
    let mut config = read_nte_config_value(config_dir, "during delete rollback")?;
    let current_revision = nte_config_revision(&config);
    let before_revision = plan
        .before_revision
        .as_ref()
        .and_then(|value| nte_config_revision(&serde_json::json!({ "updatedAt": value })));
    let current_snapshot = nte_delete_metadata_snapshot(&config, relative_path)?;
    if current_revision == before_revision {
        if current_snapshot.0 == plan.data_entry && current_snapshot.1 == plan.preset_data {
            return Ok(());
        }
        return Err(
            "Aborted NTE delete configuration no longer matches its before state.".to_string(),
        );
    }
    if current_revision.as_deref() != Some(plan.after_revision.as_str())
        || current_snapshot.0.is_some()
        || !current_snapshot.1.is_empty()
    {
        return Err("Aborted NTE delete configuration state is ambiguous.".to_string());
    }
    let relative_path = relative_path.replace('/', "\\");
    if let Some(data_entry) = plan.data_entry.as_ref() {
        let data = config
            .get_mut("data")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| {
                "NTE configuration data disappeared during delete rollback.".to_string()
            })?;
        data.insert(relative_path.clone(), data_entry.clone());
    }
    let presets = config
        .get_mut("presets")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| {
            "NTE configuration presets disappeared during delete rollback.".to_string()
        })?;
    for snapshot in &plan.preset_data {
        let current = presets
            .get_mut(snapshot.index)
            .and_then(|preset| preset.get_mut("data"))
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(|| "NTE preset disappeared during delete rollback.".to_string())?;
        let expected_clean: Vec<_> = snapshot
            .data
            .iter()
            .filter(|item| item.as_str() != Some(relative_path.as_str()))
            .cloned()
            .collect();
        if *current != expected_clean {
            return Err("NTE preset changed during delete rollback.".to_string());
        }
        *current = snapshot.data.clone();
    }
    set_nte_config_revision_value(&mut config, plan.before_revision.clone())?;
    write_nte_config_value(&config_dir.join("configNTE.json"), &config)
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Unable to remove NTE rename state: {err}")),
    }
}

fn recover_nte_rename_transaction(
    journal: &mut crate::nte_wal::WalJournal,
    incomplete: &crate::nte_wal::IncompleteTransaction,
    plan: &NteTargetWalPlan,
    trusted_mods_root: &Path,
    deployment_state_root: &Path,
    trusted_library_root: &Path,
    config_dir: &Path,
) -> Result<(), String> {
    let old_relative = validate_relative_mod_path(&plan.relative_path)?;
    let new_relative_text = plan
        .new_relative_path
        .as_deref()
        .ok_or_else(|| "NTE rename recovery plan has no new path.".to_string())?;
    let new_relative = validate_relative_mod_path(new_relative_text)?;
    if old_relative == new_relative {
        return Err("NTE rename recovery paths are identical.".to_string());
    }
    let old_source = trusted_library_root.join(&old_relative);
    let new_source = trusted_library_root.join(&new_relative);
    let planned_source = plan
        .source_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| "NTE rename recovery plan has no source path.".to_string())?;
    if normalized_path_for_comparison(&planned_source)
        != normalized_path_for_comparison(&old_source)
    {
        return Err("NTE rename recovery source escaped the persisted library root.".to_string());
    }
    let source_hash = plan
        .source_hash
        .as_deref()
        .ok_or_else(|| "NTE rename recovery plan has no source hash.".to_string())?;
    validate_existing_directory_chain(trusted_library_root, &old_relative)?;
    validate_existing_directory_chain(trusted_library_root, &new_relative)?;
    let old_destination = trusted_mods_root.join(&old_relative);
    let new_destination = trusted_mods_root.join(&new_relative);
    let old_manifest_path =
        deployment_manifest_path(deployment_state_root, trusted_mods_root, &old_relative);
    let new_manifest_path =
        deployment_manifest_path(deployment_state_root, trusted_mods_root, &new_relative);

    let inspect = || {
        Ok::<_, String>((
            optional_source_tree_hash(&old_source)?,
            optional_source_tree_hash(&new_source)?,
            optional_manifest_for_destination(&old_relative, &old_destination)?,
            optional_manifest_for_destination(&new_relative, &new_destination)?,
            optional_manifest_file(&old_manifest_path, &old_relative)?,
            optional_manifest_file(&new_manifest_path, &new_relative)?,
        ))
    };

    if incomplete.state == crate::nte_wal::WalState::CommittedAfter {
        let (old_source_hash, new_source_hash, old_target, new_target, _, _) = inspect()?;
        if new_source_hash.as_deref() != Some(source_hash) {
            if old_source_hash.as_deref() != Some(source_hash) || new_source_hash.is_some() {
                return Err("Committed NTE rename source state is ambiguous.".to_string());
            }
            let parent = new_source
                .parent()
                .ok_or_else(|| "NTE rename destination has no parent.".to_string())?;
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            validate_existing_directory_chain(trusted_library_root, &new_relative)?;
            durable_rename(&old_source, &new_source)
                .map_err(|err| format!("Unable to resume committed NTE source rename: {err}"))?;
        } else if old_source_hash.is_some() {
            return Err("Committed NTE rename has duplicate source trees.".to_string());
        }
        if plan.enabled {
            if new_target != plan.after_destination {
                if old_target != plan.before_destination || new_target.is_some() {
                    return Err("Committed NTE rename target state is ambiguous.".to_string());
                }
                let parent = new_destination
                    .parent()
                    .ok_or_else(|| "NTE rename target has no parent.".to_string())?;
                fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                validate_existing_directory_chain(trusted_mods_root, &new_relative)?;
                durable_rename(&old_destination, &new_destination).map_err(|err| {
                    format!("Unable to resume committed NTE target rename: {err}")
                })?;
            } else if old_target.is_some() {
                return Err("Committed NTE rename has duplicate target trees.".to_string());
            }
            persist_optional_manifest(&new_manifest_path, plan.after_destination.as_ref())?;
            remove_file_if_exists(&old_manifest_path)?;
        }
        rewrite_nte_config_rename(config_dir, &plan.relative_path, new_relative_text, true)?;
        return journal.append(
            incomplete.transaction_id,
            crate::nte_wal::WalState::CleanupComplete,
            br#"{"cleanup":"rename_after_complete"}"#,
        );
    }

    if incomplete.state == crate::nte_wal::WalState::AbortedBefore {
        let (old_source_hash, new_source_hash, old_target, new_target, old_state, new_state) =
            inspect()?;
        if old_source_hash.as_deref() != Some(source_hash)
            || new_source_hash.is_some()
            || old_target != plan.before_destination
            || new_target.is_some()
            || old_state != plan.before_state
            || new_state.is_some()
        {
            return Err("Aborted NTE rename no longer matches its before state.".to_string());
        }
        rewrite_nte_config_rename(config_dir, &plan.relative_path, new_relative_text, false)?;
        return journal.append(
            incomplete.transaction_id,
            crate::nte_wal::WalState::CleanupComplete,
            br#"{"cleanup":"rename_before_complete"}"#,
        );
    }

    let (old_source_hash, new_source_hash, old_target, new_target, _, _) = inspect()?;
    if plan.enabled {
        if new_target == plan.after_destination && old_target.is_none() {
            let parent = old_destination
                .parent()
                .ok_or_else(|| "NTE rename target has no original parent.".to_string())?;
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            durable_rename(&new_destination, &old_destination)
                .map_err(|err| format!("Unable to roll back NTE target rename: {err}"))?;
        } else if old_target != plan.before_destination || new_target.is_some() {
            return Err("Interrupted NTE rename target state is ambiguous.".to_string());
        }
    } else if old_target.is_some() || new_target.is_some() {
        return Err(
            "Interrupted disabled NTE rename unexpectedly has target payloads.".to_string(),
        );
    }
    persist_optional_manifest(&old_manifest_path, plan.before_state.as_ref())?;
    remove_file_if_exists(&new_manifest_path)?;
    if new_source_hash.as_deref() == Some(source_hash) && old_source_hash.is_none() {
        let parent = old_source
            .parent()
            .ok_or_else(|| "NTE rename source has no original parent.".to_string())?;
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        durable_rename(&new_source, &old_source)
            .map_err(|err| format!("Unable to roll back NTE source rename: {err}"))?;
    } else if old_source_hash.as_deref() != Some(source_hash) || new_source_hash.is_some() {
        return Err("Interrupted NTE rename source state is ambiguous.".to_string());
    }
    rewrite_nte_config_rename(config_dir, &plan.relative_path, new_relative_text, false)?;
    journal.append(
        incomplete.transaction_id,
        crate::nte_wal::WalState::StepReceipt,
        br#"{"step":"rename_recovery","outcome":"rolled_back"}"#,
    )?;
    journal.append(
        incomplete.transaction_id,
        crate::nte_wal::WalState::AbortedBefore,
        b"{}",
    )?;
    journal.append(
        incomplete.transaction_id,
        crate::nte_wal::WalState::CleanupComplete,
        br#"{"cleanup":"rename_before_complete"}"#,
    )
}

fn recover_nte_target_transaction(
    journal: &mut crate::nte_wal::WalJournal,
    trusted_mods_root: &Path,
    deployment_state_root: &Path,
    trusted_library_root: &Path,
    config_dir: Option<&Path>,
) -> Result<(), String> {
    let Some(incomplete) = journal.incomplete_transaction()? else {
        return Ok(());
    };
    let plan: NteTargetWalPlan = serde_json::from_slice(&incomplete.prepared_payload)
        .map_err(|err| format!("Unable to read the NTE target recovery plan: {err}"))?;
    if !matches!(
        plan.operation.as_str(),
        "enable" | "update" | "disable" | "delete" | "rename"
    ) {
        return Err("NTE target recovery plan has an unsupported operation.".to_string());
    }
    if plan.operation == "rename" {
        let config_dir = config_dir
            .ok_or_else(|| "NTE rename recovery requires the persisted config root.".to_string())?;
        return recover_nte_rename_transaction(
            journal,
            &incomplete,
            &plan,
            trusted_mods_root,
            deployment_state_root,
            trusted_library_root,
            config_dir,
        );
    }
    let relative = validate_relative_mod_path(&plan.relative_path)?;
    let destination = trusted_mods_root.join(&relative);
    if trusted_mods_root.exists() {
        validate_existing_directory_chain(trusted_mods_root, &relative)?;
    }
    let manifest_path =
        deployment_manifest_path(deployment_state_root, trusted_mods_root, &relative);
    let mutation_paths = target_mutation_paths(&plan, trusted_mods_root)?;
    let mut destination_bound =
        BoundDirectoryLeaf::open_optional(&destination, "NTE target destination")?;
    let mut artifacts =
        capture_target_transaction_artifacts(&plan, trusted_mods_root, trusted_library_root)?;
    let mut delete_source_bound = if plan.operation == "delete" {
        let source = plan
            .source_path
            .as_deref()
            .map(Path::new)
            .ok_or_else(|| "NTE delete recovery plan has no source path.".to_string())?;
        BoundDirectoryLeaf::open_optional(source, "NTE delete source")?
    } else {
        None
    };
    let actual_destination =
        captured_manifest_for_destination(&relative, &destination, destination_bound.as_ref())?;
    let actual_state = optional_manifest_file(&manifest_path, &relative)?;
    let (staged_destination, staging_present) = optional_planned_staging_manifest(
        &relative,
        mutation_paths.staging.as_ref(),
        artifacts.staging.as_ref(),
    )?;
    let backup_destination = optional_planned_manifest(
        &relative,
        mutation_paths.backup.as_ref(),
        artifacts.backup.as_ref(),
    )?;
    let disabled_destination = optional_planned_manifest(
        &relative,
        mutation_paths.disable.as_ref(),
        artifacts.disable.as_ref(),
    )?;

    if incomplete.state == crate::nte_wal::WalState::AbortedBefore {
        if actual_destination != plan.before_destination || actual_state != plan.before_state {
            return Err(
                "Aborted NTE transaction no longer matches its verified before state; repair is required."
                    .to_string(),
            );
        }
        if plan.operation == "delete" {
            let source = plan
                .source_path
                .as_deref()
                .map(PathBuf::from)
                .ok_or_else(|| "Aborted NTE delete has no source path.".to_string())?;
            let expected_hash = plan
                .source_hash
                .as_deref()
                .ok_or_else(|| "Aborted NTE delete has no source hash.".to_string())?;
            let quarantine = planned_source_quarantine_path(&plan, trusted_library_root)?
                .ok_or_else(|| "Aborted NTE delete has no quarantine path.".to_string())?;
            if captured_source_tree_hash(&source, delete_source_bound.as_ref())?.as_deref()
                != Some(expected_hash)
                || captured_source_tree_hash(&quarantine, artifacts.source_quarantine.as_ref())?
                    .is_some()
            {
                return Err(
                    "Aborted NTE delete source no longer matches its before state; repair is required."
                        .to_string(),
                );
            }
            restore_nte_delete_config(
                config_dir,
                &plan.relative_path,
                plan.delete_config.as_ref(),
            )?;
        }
        artifacts.cleanup()?;
        return journal.append(
            incomplete.transaction_id,
            crate::nte_wal::WalState::CleanupComplete,
            br#"{"cleanup":"aborted_before_complete"}"#,
        );
    }

    if incomplete.state == crate::nte_wal::WalState::CommittedAfter {
        if actual_destination != plan.after_destination {
            if let Some(after) = plan.after_destination.as_ref() {
                if staged_destination.as_ref() != Some(after) {
                    return Err(
                        "Committed NTE deployment has no verified after-state payload; repair is required."
                            .to_string(),
                    );
                }
                if actual_destination == plan.before_destination {
                    if plan.before_destination.is_some() {
                        let backup = mutation_paths.backup.as_ref().ok_or_else(|| {
                            "Committed NTE update has no verified backup path.".to_string()
                        })?;
                        if backup_destination.is_some() {
                            return Err(
                                "Committed NTE update has conflicting before-state copies."
                                    .to_string(),
                            );
                        }
                        let destination_leaf = destination_bound.take().ok_or_else(|| {
                            "Committed NTE destination handle disappeared before backup."
                                .to_string()
                        })?;
                        artifacts.backup = Some(
                            destination_leaf.rename_to(backup, "committed NTE target backup")?,
                        );
                    }
                } else if !(actual_destination.is_none()
                    && backup_destination == plan.before_destination)
                {
                    return Err(
                        "Committed NTE update before-state is ambiguous; repair is required."
                            .to_string(),
                    );
                }
                mutation_paths.staging.as_ref().ok_or_else(|| {
                    "Committed NTE deployment has no verified staging path.".to_string()
                })?;
                if !trusted_mods_root.exists() {
                    fs::create_dir(trusted_mods_root).map_err(|err| {
                        format!("Unable to restore the trusted NTE mods root: {err}")
                    })?;
                }
                if !is_directory_without_reparse(trusted_mods_root) {
                    return Err(
                        "The restored NTE mods root is a reparse point or unsupported entry."
                            .to_string(),
                    );
                }
                validate_existing_directory_chain(trusted_mods_root, &relative)?;
                let staging_leaf = artifacts.staging.take().ok_or_else(|| {
                    "Committed NTE staging handle disappeared before deployment.".to_string()
                })?;
                destination_bound =
                    Some(staging_leaf.rename_to(&destination, "committed NTE target deployment")?);
            } else if actual_destination == plan.before_destination
                && disabled_destination.is_none()
                && plan.before_destination.is_some()
            {
                let quarantine = mutation_paths.disable.as_ref().ok_or_else(|| {
                    "Committed NTE disable has no verified quarantine path.".to_string()
                })?;
                ensure_quarantine_root(
                    quarantine
                        .parent()
                        .ok_or_else(|| "NTE quarantine has no parent.".to_string())?,
                )?;
                let destination_leaf = destination_bound.take().ok_or_else(|| {
                    "Committed NTE destination handle disappeared before disable.".to_string()
                })?;
                artifacts.disable =
                    Some(destination_leaf.rename_to(quarantine, "committed NTE target disable")?);
            } else if !(actual_destination.is_none()
                && disabled_destination == plan.before_destination)
            {
                return Err(
                    "Committed NTE disable state is ambiguous; repair is required.".to_string(),
                );
            }
        }
        persist_optional_manifest(&manifest_path, plan.after_destination.as_ref())?;
        let reconciled_destination =
            captured_manifest_for_destination(&relative, &destination, destination_bound.as_ref())?;
        let reconciled_state = optional_manifest_file(&manifest_path, &relative)?;
        if reconciled_destination != plan.after_destination
            || reconciled_state != plan.after_destination
        {
            return Err(
                "Committed NTE transaction could not be reconciled to its after state.".to_string(),
            );
        }
        if plan.operation == "delete" {
            let source = plan
                .source_path
                .as_deref()
                .map(PathBuf::from)
                .ok_or_else(|| "Committed NTE delete has no source path.".to_string())?;
            let expected_hash = plan
                .source_hash
                .as_deref()
                .ok_or_else(|| "Committed NTE delete has no source hash.".to_string())?;
            let quarantine = planned_source_quarantine_path(&plan, trusted_library_root)?
                .ok_or_else(|| "Committed NTE delete has no quarantine path.".to_string())?;
            let source_hash = captured_source_tree_hash(&source, delete_source_bound.as_ref())?;
            let quarantine_hash =
                captured_source_tree_hash(&quarantine, artifacts.source_quarantine.as_ref())?;
            match (source_hash.as_deref(), quarantine_hash.as_deref()) {
                (Some(actual), None) if actual == expected_hash => {
                    let source_leaf = delete_source_bound.take().ok_or_else(|| {
                        "Committed NTE source handle disappeared before quarantine.".to_string()
                    })?;
                    artifacts.source_quarantine = Some(
                        source_leaf.rename_to(&quarantine, "committed NTE source quarantine")?,
                    );
                }
                (None, Some(actual)) if actual == expected_hash => {}
                // Cleanup removes the verified quarantine before appending CleanupComplete.
                // Both paths absent therefore means the committed cleanup already ran.
                (None, None) => {}
                _ => {
                    return Err(
                        "Committed NTE delete source state is ambiguous; repair is required."
                            .to_string(),
                    );
                }
            }
            complete_nte_delete_config(
                config_dir,
                &plan.relative_path,
                plan.delete_config.as_ref(),
            )?;
        }
        artifacts.cleanup()?;
        return journal.append(
            incomplete.transaction_id,
            crate::nte_wal::WalState::CleanupComplete,
            br#"{"cleanup":"complete"}"#,
        );
    }

    if incomplete.state == crate::nte_wal::WalState::Prepared {
        journal.append(
            incomplete.transaction_id,
            crate::nte_wal::WalState::Committing,
            br#"{"recovery":"begin"}"#,
        )?;
    }
    let outcome = if plan.operation == "delete" {
        let source_path = plan
            .source_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| "NTE delete recovery plan has no source path.".to_string())?;
        let source_relative = source_path
            .strip_prefix(trusted_library_root)
            .map_err(|_| {
                "NTE delete recovery source is outside the persisted library root.".to_string()
            })?;
        validate_relative_mod_path(&source_relative.to_string_lossy())?;
        if source_relative.as_os_str().is_empty() {
            return Err(
                "NTE delete recovery source is outside the persisted library root.".to_string(),
            );
        }
        let source_hash = plan
            .source_hash
            .as_deref()
            .ok_or_else(|| "NTE delete recovery plan has no source hash.".to_string())?;
        let quarantine_name = plan
            .source_quarantine_name
            .as_deref()
            .ok_or_else(|| "NTE delete recovery plan has no quarantine name.".to_string())?;
        let parent = source_path
            .parent()
            .ok_or_else(|| "NTE delete source has no parent.".to_string())?;
        let source_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "NTE delete source has no valid name.".to_string())?;
        let expected_prefix = format!(".{source_name}.imm-delete-");
        if !quarantine_name.starts_with(&expected_prefix)
            || !quarantine_name[expected_prefix.len()..]
                .chars()
                .all(|character| character.is_ascii_digit() || character == '-')
        {
            return Err("NTE delete recovery quarantine name is unsafe.".to_string());
        }
        let quarantine = parent.join(quarantine_name);
        let actual_source_hash =
            captured_source_tree_hash(&source_path, delete_source_bound.as_ref())?;
        let quarantine_hash =
            captured_source_tree_hash(&quarantine, artifacts.source_quarantine.as_ref())?;
        if actual_destination == plan.before_destination
            && actual_state == plan.before_state
            && actual_source_hash.as_deref() == Some(source_hash)
            && quarantine_hash.is_none()
        {
            "verified_before_state"
        } else if actual_destination.is_none()
            && disabled_destination == plan.before_destination
            && actual_state == plan.before_state
            && actual_source_hash.as_deref() == Some(source_hash)
            && quarantine_hash.is_none()
        {
            mutation_paths.disable.as_ref().ok_or_else(|| {
                "NTE delete recovery plan has no verified target quarantine path.".to_string()
            })?;
            let disable_leaf = artifacts.disable.take().ok_or_else(|| {
                "Interrupted NTE delete quarantine handle disappeared.".to_string()
            })?;
            destination_bound =
                Some(disable_leaf.rename_to(&destination, "interrupted NTE delete rollback")?);
            persist_optional_manifest(&manifest_path, plan.before_state.as_ref())?;
            "rollback_interrupted_delete"
        } else if actual_destination.is_none()
            && disabled_destination == plan.before_destination
            && actual_state == plan.after_destination
            && actual_source_hash.as_deref() == Some(source_hash)
            && quarantine_hash.is_none()
        {
            mutation_paths.disable.as_ref().ok_or_else(|| {
                "NTE delete recovery plan has no verified target quarantine path.".to_string()
            })?;
            let disable_leaf = artifacts
                .disable
                .take()
                .ok_or_else(|| "Paused NTE delete quarantine handle disappeared.".to_string())?;
            destination_bound =
                Some(disable_leaf.rename_to(&destination, "paused NTE delete rollback")?);
            persist_optional_manifest(&manifest_path, plan.before_state.as_ref())?;
            "rollback_paused_delete"
        } else if actual_destination == plan.after_destination
            && actual_source_hash.is_none()
            && quarantine_hash.as_deref() == Some(source_hash)
        {
            persist_optional_manifest(&manifest_path, plan.after_destination.as_ref())?;
            journal.append(
                incomplete.transaction_id,
                crate::nte_wal::WalState::StepReceipt,
                br#"{"step":"source_quarantine","outcome":"applied"}"#,
            )?;
            journal.append(
                incomplete.transaction_id,
                crate::nte_wal::WalState::CommittedAfter,
                b"{}",
            )?;
            complete_nte_delete_config(
                config_dir,
                &plan.relative_path,
                plan.delete_config.as_ref(),
            )?;
            drop(destination_bound);
            artifacts.cleanup()?;
            return journal.append(
                incomplete.transaction_id,
                crate::nte_wal::WalState::CleanupComplete,
                br#"{"cleanup":"complete"}"#,
            );
        } else {
            return Err(
                "NTE delete transaction state is ambiguous or externally modified; repair is required."
                    .to_string(),
            );
        }
    } else if actual_destination == plan.after_destination {
        persist_optional_manifest(&manifest_path, plan.after_destination.as_ref())?;
        "roll_forward_after_hash"
    } else if actual_destination.is_none()
        && plan.before_destination.is_some()
        && backup_destination == plan.before_destination
        && actual_state == plan.before_state
        && (staged_destination == plan.after_destination
            || staging_present
            || plan.after_destination.is_none())
    {
        mutation_paths
            .backup
            .as_ref()
            .ok_or_else(|| "NTE update recovery plan has no verified backup path.".to_string())?;
        let backup_leaf = artifacts
            .backup
            .take()
            .ok_or_else(|| "NTE update backup handle disappeared before rollback.".to_string())?;
        destination_bound =
            Some(backup_leaf.rename_to(&destination, "NTE update recovery rollback")?);
        "rollback_verified_backup"
    } else if actual_destination.is_none()
        && disabled_destination == plan.before_destination
        && actual_state == plan.before_state
        && plan.after_destination.is_none()
    {
        mutation_paths.disable.as_ref().ok_or_else(|| {
            "NTE disable recovery plan has no verified quarantine path.".to_string()
        })?;
        let disable_leaf = artifacts.disable.take().ok_or_else(|| {
            "NTE disable quarantine handle disappeared before rollback.".to_string()
        })?;
        destination_bound =
            Some(disable_leaf.rename_to(&destination, "paused NTE disable rollback")?);
        "rollback_paused_disable"
    } else if actual_destination == plan.before_destination && actual_state == plan.before_state {
        "verified_before_state"
    } else {
        return Err(
            "NTE target transaction state is ambiguous or externally modified; repair is required."
                .to_string(),
        );
    };
    let receipt = serde_json::to_vec(&serde_json::json!({
        "step": "recovery",
        "outcome": outcome,
    }))
    .map_err(|err| format!("Unable to serialize the NTE target recovery receipt: {err}"))?;
    journal.append(
        incomplete.transaction_id,
        crate::nte_wal::WalState::StepReceipt,
        &receipt,
    )?;
    let terminal_state = if outcome == "roll_forward_after_hash" {
        crate::nte_wal::WalState::CommittedAfter
    } else {
        crate::nte_wal::WalState::AbortedBefore
    };
    journal.append(incomplete.transaction_id, terminal_state, b"{}")?;
    if plan.operation == "delete" {
        if terminal_state == crate::nte_wal::WalState::CommittedAfter {
            complete_nte_delete_config(
                config_dir,
                &plan.relative_path,
                plan.delete_config.as_ref(),
            )?;
        } else {
            restore_nte_delete_config(
                config_dir,
                &plan.relative_path,
                plan.delete_config.as_ref(),
            )?;
        }
    }
    drop(destination_bound);
    artifacts.cleanup()?;
    journal.append(
        incomplete.transaction_id,
        crate::nte_wal::WalState::CleanupComplete,
        br#"{"cleanup":"complete"}"#,
    )
}

pub(crate) fn normalized_path_for_comparison(path: &Path) -> String {
    let mut value = path
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_string();
    if cfg!(windows) {
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            value = format!(r"\\{unc}");
        } else if let Some(local) = value.strip_prefix(r"\\?\") {
            value = local.to_string();
        }
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn validate_existing_directory_chain(root: &Path, relative: &Path) -> Result<(), String> {
    if !is_directory_without_reparse(root) {
        return Err("The validated NTE game root became unavailable or unsafe.".to_string());
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err("Invalid NTE target path.".to_string());
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata_is_reparse(&metadata) => {
                return Err(format!(
                    "NTE target path contains a reparse point: {}",
                    current.display()
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!(
                    "NTE target path component is not a directory: {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => break,
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(())
}

fn unique_sibling(destination: &Path, label: &str) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "NTE destination has no parent.".to_string())?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "NTE destination has no name.".to_string())?;
    let counter = NTE_OPERATION_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(parent.join(format!(
        ".{name}.imm-{label}-{}-{counter}",
        std::process::id()
    )))
}

fn deployment_quarantine_root(mods_root: &Path) -> Result<PathBuf, String> {
    let paks_root = mods_root
        .parent()
        .ok_or_else(|| "NTE mods root has no Paks parent.".to_string())?;
    let content_root = paks_root
        .parent()
        .ok_or_else(|| "NTE Paks root has no Content parent.".to_string())?;
    Ok(content_root.join(".imm-nte-quarantine"))
}

fn ensure_quarantine_root(quarantine_root: &Path) -> Result<(), String> {
    match fs::symlink_metadata(quarantine_root) {
        Ok(metadata) if metadata_is_reparse(&metadata) || !metadata.is_dir() => {
            return Err("NTE deployment quarantine is unsafe.".to_string());
        }
        Ok(_) => return Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.to_string()),
    }
    fs::create_dir(quarantine_root)
        .map_err(|err| format!("Unable to create NTE deployment quarantine: {err}"))
}

fn unique_quarantine_path(
    quarantine_root: &Path,
    destination: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    ensure_quarantine_root(quarantine_root)?;
    unique_quarantine_candidate(quarantine_root, destination, label)
}

fn unique_quarantine_candidate(
    quarantine_root: &Path,
    destination: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "NTE destination has no name.".to_string())?;
    let counter = NTE_OPERATION_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(quarantine_root.join(format!(
        ".{name}.imm-{label}-{}-{counter}",
        std::process::id()
    )))
}

fn monitored_quarantine_path(
    monitor: &Option<&mut NteMutationMonitor<'_>>,
    fallback_root: &Path,
    destination: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    let planned = monitor.as_deref().and_then(|monitor| match label {
        "staging" => monitor.paths.staging.clone(),
        "backup" => monitor.paths.backup.clone(),
        "disable" => monitor.paths.disable.clone(),
        _ => None,
    });
    if let Some(path) = planned {
        return Ok(path);
    }
    unique_quarantine_path(fallback_root, destination, label)
}

fn validated_planned_quarantine_path(
    quarantine_root: &Path,
    destination: &Path,
    label: &str,
    planned_name: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(planned_name) = planned_name else {
        return Ok(None);
    };
    let destination_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "NTE destination has no name.".to_string())?;
    let expected_prefix = format!(".{destination_name}.imm-{label}-");
    if !planned_name.starts_with(&expected_prefix)
        || planned_name[expected_prefix.len()..].is_empty()
        || !planned_name[expected_prefix.len()..]
            .chars()
            .all(|character| character.is_ascii_digit() || character == '-')
        || Path::new(planned_name)
            .file_name()
            .and_then(|value| value.to_str())
            != Some(planned_name)
    {
        return Err(format!(
            "NTE transaction {label} quarantine name is unsafe."
        ));
    }
    Ok(Some(quarantine_root.join(planned_name)))
}

fn target_mutation_paths(
    plan: &NteTargetWalPlan,
    trusted_mods_root: &Path,
) -> Result<NteMutationPaths, String> {
    let relative = validate_relative_mod_path(&plan.relative_path)?;
    let destination = trusted_mods_root.join(relative);
    let quarantine_root = deployment_quarantine_root(trusted_mods_root)?;
    Ok(NteMutationPaths {
        staging: validated_planned_quarantine_path(
            &quarantine_root,
            &destination,
            "staging",
            plan.target_staging_name.as_deref(),
        )?,
        backup: validated_planned_quarantine_path(
            &quarantine_root,
            &destination,
            "backup",
            plan.target_backup_name.as_deref(),
        )?,
        disable: validated_planned_quarantine_path(
            &quarantine_root,
            &destination,
            "disable",
            plan.target_quarantine_name.as_deref(),
        )?,
    })
}

fn planned_source_quarantine_path(
    plan: &NteTargetWalPlan,
    trusted_library_root: &Path,
) -> Result<Option<PathBuf>, String> {
    let Some(source_text) = plan.source_path.as_deref() else {
        return Ok(None);
    };
    let source = PathBuf::from(source_text);
    let relative = source
        .strip_prefix(trusted_library_root)
        .map_err(|_| "NTE transaction source is outside the persisted library root.".to_string())?;
    validate_relative_mod_path(&relative.to_string_lossy())?;
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "NTE transaction source has no valid name.".to_string())?;
    let Some(quarantine_name) = plan.source_quarantine_name.as_deref() else {
        return Ok(None);
    };
    let expected_prefix = format!(".{name}.imm-delete-");
    if !quarantine_name.starts_with(&expected_prefix)
        || quarantine_name[expected_prefix.len()..].is_empty()
        || !quarantine_name[expected_prefix.len()..]
            .chars()
            .all(|character| character.is_ascii_digit() || character == '-')
        || Path::new(quarantine_name)
            .file_name()
            .and_then(|value| value.to_str())
            != Some(quarantine_name)
    {
        return Err("NTE transaction source quarantine name is unsafe.".to_string());
    }
    Ok(Some(
        source
            .parent()
            .ok_or_else(|| "NTE transaction source has no parent.".to_string())?
            .join(quarantine_name),
    ))
}

fn remove_owned_transaction_directory(path: &Path) -> Result<(), String> {
    #[cfg(test)]
    if NTE_CLEANUP_TEST_FAIL.with(std::cell::Cell::get) {
        return Err("Injected NTE transaction cleanup failure.".to_string());
    }
    remove_bound_directory_path(path, "NTE transaction artifact")
}

fn remove_owned_transaction_directory_io(path: &Path) -> std::io::Result<()> {
    remove_owned_transaction_directory(path).map_err(std::io::Error::other)
}

struct NteTargetArtifactCaptures {
    staging: Option<BoundDirectoryLeaf>,
    backup: Option<BoundDirectoryLeaf>,
    disable: Option<BoundDirectoryLeaf>,
    source_quarantine: Option<BoundDirectoryLeaf>,
}

impl NteTargetArtifactCaptures {
    fn capture(
        plan: &NteTargetWalPlan,
        trusted_mods_root: &Path,
        trusted_library_root: &Path,
    ) -> Result<Self, String> {
        let mut captures = Self::capture_target_only(plan, trusted_mods_root)?;
        let source_quarantine = planned_source_quarantine_path(plan, trusted_library_root)?;
        captures.source_quarantine =
            capture_optional_transaction_artifact(source_quarantine.as_ref(), "source quarantine")?;
        Ok(captures)
    }

    fn capture_target_only(
        plan: &NteTargetWalPlan,
        trusted_mods_root: &Path,
    ) -> Result<Self, String> {
        let paths = target_mutation_paths(plan, trusted_mods_root)?;
        Ok(Self {
            staging: capture_optional_transaction_artifact(paths.staging.as_ref(), "staging")?,
            backup: capture_optional_transaction_artifact(paths.backup.as_ref(), "backup")?,
            disable: capture_optional_transaction_artifact(paths.disable.as_ref(), "disable")?,
            source_quarantine: None,
        })
    }

    fn cleanup(self) -> Result<(), String> {
        for artifact in [
            self.staging,
            self.backup,
            self.disable,
            self.source_quarantine,
        ]
        .into_iter()
        .flatten()
        {
            remove_captured_transaction_artifact(artifact)?;
        }
        Ok(())
    }
}

fn capture_optional_transaction_artifact(
    path: Option<&PathBuf>,
    role: &str,
) -> Result<Option<BoundDirectoryLeaf>, String> {
    match path {
        Some(path) => {
            BoundDirectoryLeaf::open_optional(path, &format!("NTE transaction {role} artifact"))
        }
        None => Ok(None),
    }
}

fn remove_captured_transaction_artifact(artifact: BoundDirectoryLeaf) -> Result<(), String> {
    #[cfg(test)]
    if NTE_CLEANUP_TEST_FAIL.with(std::cell::Cell::get) {
        return Err("Injected NTE transaction cleanup failure.".to_string());
    }
    artifact.remove("NTE transaction artifact")
}

fn capture_target_transaction_artifacts(
    plan: &NteTargetWalPlan,
    trusted_mods_root: &Path,
    trusted_library_root: &Path,
) -> Result<NteTargetArtifactCaptures, String> {
    NteTargetArtifactCaptures::capture(plan, trusted_mods_root, trusted_library_root)
}

fn optional_planned_manifest(
    relative: &Path,
    path: Option<&PathBuf>,
    captured: Option<&BoundDirectoryLeaf>,
) -> Result<Option<NteDeploymentManifest>, String> {
    match (path, captured) {
        (Some(path), Some(_)) => optional_manifest_for_destination(relative, path),
        _ => Ok(None),
    }
}

fn optional_planned_staging_manifest(
    relative: &Path,
    path: Option<&PathBuf>,
    captured: Option<&BoundDirectoryLeaf>,
) -> Result<(Option<NteDeploymentManifest>, bool), String> {
    let (Some(path), Some(_)) = (path, captured) else {
        return Ok((None, false));
    };
    match optional_manifest_for_destination(relative, path) {
        Ok(manifest) => {
            let present = manifest.is_some();
            Ok((manifest, present))
        }
        Err(err) if err == "NTE Mod does not contain a .pak payload." => {
            // `payload_entries` has already rejected reparse points, unsupported entries,
            // disallowed extensions and size/count violations. A no-.pak tree is therefore
            // a valid partial copy owned by this WAL transaction and can be discarded.
            Ok((None, true))
        }
        Err(err) => Err(err),
    }
}

fn cleanup_quarantine_root_if_empty(quarantine_root: &Path) -> Result<(), String> {
    remove_bound_empty_directory_path(quarantine_root, "NTE quarantine root")
}

fn deploy_payload(
    source_files: &[(PathBuf, PathBuf)],
    destination: &Path,
    quarantine_root: &Path,
    monitor: &mut Option<&mut NteMutationMonitor<'_>>,
) -> Result<(), String> {
    if destination.exists() {
        if !is_directory_without_reparse(destination) {
            return Err("NTE target is a reparse point or unsupported entry.".to_string());
        }
        if destination_matches_source(source_files, destination)? {
            return Ok(());
        }
        return Err(
            "NTE target already contains different files. Resolve the conflict before enabling."
                .to_string(),
        );
    }
    let staging = monitored_quarantine_path(monitor, quarantine_root, destination, "staging")?;
    if staging.exists() {
        return Err("NTE transaction staging path already exists. Repair is required.".to_string());
    }
    if let Err(err) = copy_payload_to_staging(source_files, &staging, monitor) {
        let _ = cleanup_or_defer(monitor, &staging, &remove_owned_transaction_directory_io);
        return Err(err);
    }
    mutation_checkpoint(monitor, "deploy_staging_to_destination")?;
    match durable_rename(&staging, destination) {
        Ok(()) => {
            cleanup_quarantine_root_if_empty(quarantine_root)?;
            Ok(())
        }
        Err(err) => {
            let _ = cleanup_or_defer(monitor, &staging, &remove_owned_transaction_directory_io);
            cleanup_quarantine_root_if_empty(quarantine_root)?;
            Err(format!("Unable to enable NTE Mod: {err}"))
        }
    }
}

fn replace_deployed_payload_with_cleanup<F>(
    source_files: &[(PathBuf, PathBuf)],
    destination: &Path,
    manifest_path: &Path,
    relative_path: &Path,
    quarantine_root: &Path,
    mut monitor: Option<&mut NteMutationMonitor<'_>>,
    cleanup_quarantine: F,
) -> Result<(), String>
where
    F: Fn(&Path) -> std::io::Result<()>,
{
    let staging = monitored_quarantine_path(&monitor, quarantine_root, destination, "staging")?;
    let backup = monitored_quarantine_path(&monitor, quarantine_root, destination, "backup")?;
    if staging.exists() || backup.exists() {
        return Err(
            "NTE transaction quarantine path already exists. Repair is required.".to_string(),
        );
    }
    if let Err(err) = copy_payload_to_staging(source_files, &staging, &mut monitor) {
        let _ = cleanup_or_defer(&mut monitor, &staging, &cleanup_quarantine);
        cleanup_quarantine_root_if_empty(quarantine_root)?;
        return Err(err);
    }
    let staged_files = match payload_entries(&staging) {
        Ok(files) => files,
        Err(err) => {
            let _ = cleanup_or_defer(&mut monitor, &staging, &cleanup_quarantine);
            cleanup_quarantine_root_if_empty(quarantine_root)?;
            return Err(err);
        }
    };
    let manifest = match build_deployment_manifest(relative_path, &staged_files) {
        Ok(manifest) => manifest,
        Err(err) => {
            let _ = cleanup_or_defer(&mut monitor, &staging, &cleanup_quarantine);
            cleanup_quarantine_root_if_empty(quarantine_root)?;
            return Err(err);
        }
    };
    mutation_checkpoint(&mut monitor, "quarantine_previous_destination")?;
    if let Err(err) = durable_rename(destination, &backup) {
        let _ = cleanup_or_defer(&mut monitor, &staging, &cleanup_quarantine);
        cleanup_quarantine_root_if_empty(quarantine_root)?;
        return Err(format!(
            "Unable to stage the previous NTE deployment: {err}"
        ));
    }
    mutation_checkpoint(&mut monitor, "deploy_updated_destination")?;
    if let Err(err) = durable_rename(&staging, destination) {
        let restore = mutation_checkpoint(&mut monitor, "rollback_previous_destination")
            .and_then(|_| durable_rename(&backup, destination).map_err(|err| err.to_string()));
        let _ = cleanup_or_defer(&mut monitor, &staging, &cleanup_quarantine);
        cleanup_quarantine_root_if_empty(quarantine_root)?;
        return match restore {
            Ok(()) => Err(format!("Unable to deploy the NTE update: {err}")),
            Err(restore_err) => Err(format!(
                "Unable to deploy the NTE update ({err}); rollback also failed ({restore_err})"
            )),
        };
    }
    mutation_checkpoint(&mut monitor, "write_updated_manifest")?;
    if let Err(err) = write_deployment_manifest(manifest_path, &manifest) {
        let restore = mutation_checkpoint(&mut monitor, "rollback_updated_destination")
            .and_then(|_| durable_rename(destination, &staging).map_err(|err| err.to_string()))
            .and_then(|_| mutation_checkpoint(&mut monitor, "restore_previous_destination"))
            .and_then(|_| durable_rename(&backup, destination).map_err(|err| err.to_string()));
        if restore.is_ok() {
            if let Err(cleanup_err) = cleanup_or_defer(&mut monitor, &staging, &cleanup_quarantine)
            {
                log::warn!(
                    "NTE update rollback retained staged payload outside the scan tree at '{}': {}",
                    staging.display(),
                    cleanup_err
                );
            }
            cleanup_quarantine_root_if_empty(quarantine_root)?;
        }
        return match restore {
            Ok(()) => Err(format!("Unable to persist the NTE update state: {err}")),
            Err(restore_err) => Err(format!(
                "Unable to persist the NTE update state ({err}); rollback also failed ({restore_err})"
            )),
        };
    }
    if let Err(err) = cleanup_or_defer(&mut monitor, &backup, &cleanup_quarantine) {
        log::warn!(
            "NTE update committed; previous deployment cleanup was deferred outside the scan tree at '{}': {}",
            backup.display(),
            err
        );
    }
    cleanup_quarantine_root_if_empty(quarantine_root)?;
    Ok(())
}

fn replace_deployed_payload(
    source_files: &[(PathBuf, PathBuf)],
    destination: &Path,
    manifest_path: &Path,
    relative_path: &Path,
    quarantine_root: &Path,
    monitor: Option<&mut NteMutationMonitor<'_>>,
) -> Result<(), String> {
    replace_deployed_payload_with_cleanup(
        source_files,
        destination,
        manifest_path,
        relative_path,
        quarantine_root,
        monitor,
        remove_owned_transaction_directory_io,
    )
}

fn remove_deployed_payload_with_cleanup<F>(
    destination: &Path,
    manifest_path: &Path,
    quarantine_root: &Path,
    mut monitor: Option<&mut NteMutationMonitor<'_>>,
    cleanup_quarantine: F,
) -> Result<(), String>
where
    F: Fn(&Path) -> std::io::Result<()>,
{
    let quarantine = monitored_quarantine_path(&monitor, quarantine_root, destination, "disable")?;
    if quarantine.exists() {
        return Err(
            "NTE transaction quarantine path already exists. Repair is required.".to_string(),
        );
    }
    mutation_checkpoint(&mut monitor, "quarantine_disabled_destination")?;
    ensure_quarantine_root(quarantine_root)?;
    durable_rename(destination, &quarantine)
        .map_err(|err| format!("Unable to quarantine the NTE deployment: {err}"))?;

    mutation_checkpoint(&mut monitor, "remove_deployment_manifest")?;
    if let Err(err) = fs::remove_file(manifest_path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            return match mutation_checkpoint(&mut monitor, "rollback_disabled_destination")
                .and_then(|_| {
                    durable_rename(&quarantine, destination).map_err(|err| err.to_string())
                })
            {
                Ok(()) => Err(format!("Unable to commit NTE deployment state removal: {err}")),
                Err(restore_err) => Err(format!(
                    "Unable to commit NTE deployment state removal ({err}); deployment rollback also failed ({restore_err})"
                )),
            };
        }
    }

    if let Err(err) = cleanup_or_defer(&mut monitor, &quarantine, &cleanup_quarantine) {
        log::warn!(
            "NTE disable committed; deployment cleanup was deferred outside the scan tree at '{}': {}",
            quarantine.display(),
            err
        );
    }
    cleanup_quarantine_root_if_empty(quarantine_root)?;
    Ok(())
}

fn remove_deployed_payload(
    destination: &Path,
    manifest_path: &Path,
    quarantine_root: &Path,
    monitor: Option<&mut NteMutationMonitor<'_>>,
) -> Result<(), String> {
    remove_deployed_payload_with_cleanup(
        destination,
        manifest_path,
        quarantine_root,
        monitor,
        remove_owned_transaction_directory_io,
    )
}

fn set_mod_enabled_unlocked(
    source_path: &Path,
    mods_root: &Path,
    relative_path: &str,
    enabled: bool,
    requested_region: Option<&str>,
    deployment_state_root: &Path,
    mut monitor: Option<&mut NteMutationMonitor<'_>>,
) -> Result<NteModOperationResult, String> {
    let validation = validate_mods_root(mods_root, requested_region);
    if !validation.valid {
        return Err(validation.message);
    }
    let validated_game_root = PathBuf::from(&validation.root);
    let trusted_mods_root = join_components(&validated_game_root, MODS_COMPONENTS);
    if normalized_path_for_comparison(mods_root)
        != normalized_path_for_comparison(&trusted_mods_root)
    {
        return Err(
            "NTE target does not match the validated Content\\Paks\\~mods directory.".to_string(),
        );
    }
    if !is_directory_without_reparse(source_path) {
        return Err("NTE source Mod is missing or is a reparse point.".to_string());
    }
    if !source_path.is_absolute() {
        return Err("NTE source Mod path must be absolute.".to_string());
    }
    let source = source_path
        .canonicalize()
        .map_err(|err| format!("Unable to resolve NTE source Mod: {err}"))?;
    if !is_directory_without_reparse(&source) {
        return Err("NTE source Mod is missing or unsafe.".to_string());
    }
    if normalized_path_for_comparison(source_path) != normalized_path_for_comparison(&source) {
        return Err("NTE source Mod path contains a symbolic link or reparse point.".to_string());
    }
    let relative = validate_relative_mod_path(relative_path)?;
    if trusted_mods_root.exists() {
        validate_existing_directory_chain(&trusted_mods_root, &relative)?;
    }
    let destination = trusted_mods_root.join(&relative);
    let manifest_path =
        deployment_manifest_path(deployment_state_root, &trusted_mods_root, &relative);
    let quarantine_root = deployment_quarantine_root(&trusted_mods_root)?;
    let payload_files = if enabled {
        let source_files = payload_entries(&source)?;
        let destination_existed = destination.exists();
        if let Some(parent) = destination.parent() {
            mutation_checkpoint(&mut monitor, "create_destination_parent")?;
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        validate_existing_directory_chain(&trusted_mods_root, &relative)?;
        if destination_existed {
            if destination_matches_source(&source_files, &destination)? {
                let deployed_files = payload_entries(&destination)?;
                let manifest = build_deployment_manifest(&relative, &deployed_files)?;
                mutation_checkpoint(&mut monitor, "write_existing_manifest")?;
                write_deployment_manifest(&manifest_path, &manifest)
                    .map_err(|err| format!("Unable to persist NTE deployment state: {err}"))?;
            } else {
                let previous_manifest = read_deployment_manifest(&manifest_path, &relative)?
                    .ok_or_else(|| {
                        "NTE target differs from the managed source and has no deployment state."
                            .to_string()
                    })?;
                if !destination_matches_manifest(&previous_manifest, &destination)? {
                    return Err(
                        "NTE target was modified outside IMM; repair is required before updating."
                            .to_string(),
                    );
                }
                replace_deployed_payload(
                    &source_files,
                    &destination,
                    &manifest_path,
                    &relative,
                    &quarantine_root,
                    monitor.as_deref_mut(),
                )?;
            }
        } else {
            deploy_payload(&source_files, &destination, &quarantine_root, &mut monitor)?;
            let deployed_files = payload_entries(&destination)?;
            let manifest = build_deployment_manifest(&relative, &deployed_files)?;
            mutation_checkpoint(&mut monitor, "write_enabled_manifest")?;
            if let Err(err) = write_deployment_manifest(&manifest_path, &manifest) {
                let rollback = unique_quarantine_path(&quarantine_root, &destination, "rollback")
                    .and_then(|path| {
                        mutation_checkpoint(&mut monitor, "rollback_enabled_destination")?;
                        durable_rename(&destination, &path)
                            .map_err(|rename_err| rename_err.to_string())?;
                        if let Err(cleanup_err) = remove_owned_transaction_directory(&path) {
                            log::warn!(
                                "NTE enable rollback retained payload outside the scan tree at '{}': {}",
                                path.display(),
                                cleanup_err
                            );
                        }
                        Ok(())
                    });
                cleanup_quarantine_root_if_empty(&quarantine_root)?;
                return match rollback {
                    Ok(()) => Err(format!("Unable to persist NTE deployment state: {err}")),
                    Err(rollback_err) => Err(format!(
                        "Unable to persist NTE deployment state ({err}); deployment rollback also failed ({rollback_err})"
                    )),
                };
            }
        }
        source_files.len()
    } else if destination.exists() {
        let manifest = read_deployment_manifest(&manifest_path, &relative)?;
        let payload_count;
        let matches = if let Some(manifest) = &manifest {
            payload_count = manifest.files.len();
            destination_matches_manifest(manifest, &destination)?
        } else {
            let source_files = payload_entries(&source)?;
            payload_count = source_files.len();
            destination_matches_source(&source_files, &destination)?
        };
        if !matches {
            return Err(
                "NTE target was modified outside IMM; repair is required before disabling."
                    .to_string(),
            );
        }
        remove_deployed_payload(
            &destination,
            &manifest_path,
            &quarantine_root,
            monitor.as_deref_mut(),
        )?;
        if let Some(parent) = destination.parent() {
            if parent != trusted_mods_root
                && fs::read_dir(parent)
                    .ok()
                    .and_then(|mut entries| entries.next())
                    .is_none()
            {
                mutation_checkpoint(&mut monitor, "remove_empty_destination_parent")?;
                let _ = fs::remove_dir(parent);
            }
        }
        payload_count
    } else {
        mutation_checkpoint(&mut monitor, "remove_stale_deployment_manifest")?;
        if let Err(err) = fs::remove_file(&manifest_path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                return Err(format!(
                    "Unable to remove stale NTE deployment state: {err}"
                ));
            }
        }
        0
    };
    Ok(NteModOperationResult {
        enabled,
        destination: destination.to_string_lossy().to_string(),
        payload_files,
        message: if enabled {
            "NTE Mod enabled.".to_string()
        } else {
            "NTE Mod disabled.".to_string()
        },
        config_revision: None,
    })
}

fn prepare_target_wal_plan(
    source_path: &Path,
    mods_root: &Path,
    relative_path: &str,
    enabled: bool,
    requested_region: Option<&str>,
    deployment_state_root: &Path,
) -> Result<(NteTargetWalPlan, PathBuf), String> {
    let validation = validate_mods_root(mods_root, requested_region);
    if !validation.valid {
        return Err(validation.message);
    }
    let validated_game_root = PathBuf::from(&validation.root);
    let trusted_mods_root = join_components(&validated_game_root, MODS_COMPONENTS);
    if normalized_path_for_comparison(mods_root)
        != normalized_path_for_comparison(&trusted_mods_root)
    {
        return Err(
            r"NTE target does not match the validated Content\Paks\~mods directory.".to_string(),
        );
    }
    let relative = validate_relative_mod_path(relative_path)?;
    if trusted_mods_root.exists() {
        validate_existing_directory_chain(&trusted_mods_root, &relative)?;
    }
    let destination = trusted_mods_root.join(&relative);
    let manifest_path =
        deployment_manifest_path(deployment_state_root, &trusted_mods_root, &relative);
    let before_destination = optional_manifest_for_destination(&relative, &destination)?;
    let before_state = optional_manifest_file(&manifest_path, &relative)?;
    let after_destination = if enabled {
        if !is_directory_without_reparse(source_path) || !source_path.is_absolute() {
            return Err("NTE source Mod is missing or unsafe.".to_string());
        }
        let source = source_path
            .canonicalize()
            .map_err(|err| format!("Unable to resolve NTE source Mod: {err}"))?;
        if normalized_path_for_comparison(source_path) != normalized_path_for_comparison(&source)
            || !is_directory_without_reparse(&source)
        {
            return Err(
                "NTE source Mod path contains a symbolic link or reparse point.".to_string(),
            );
        }
        let files = payload_entries(&source)?;
        Some(build_deployment_manifest(&relative, &files)?)
    } else {
        None
    };
    let operation = if enabled {
        if before_destination.is_some() {
            "update"
        } else {
            "enable"
        }
    } else {
        "disable"
    };
    let quarantine_root = deployment_quarantine_root(&trusted_mods_root)?;
    let staging = enabled
        .then(|| unique_quarantine_candidate(&quarantine_root, &destination, "staging"))
        .transpose()?;
    let backup = (enabled && before_destination.is_some())
        .then(|| unique_quarantine_candidate(&quarantine_root, &destination, "backup"))
        .transpose()?;
    let disable = (!enabled && before_destination.is_some())
        .then(|| unique_quarantine_candidate(&quarantine_root, &destination, "disable"))
        .transpose()?;
    Ok((
        NteTargetWalPlan {
            operation: operation.to_string(),
            relative_path: normalized_relative_path(&relative)?,
            new_relative_path: None,
            enabled,
            before_destination,
            after_destination,
            before_state,
            target_staging_name: staging
                .as_deref()
                .and_then(Path::file_name)
                .and_then(|value| value.to_str())
                .map(str::to_string),
            target_backup_name: backup
                .as_deref()
                .and_then(Path::file_name)
                .and_then(|value| value.to_str())
                .map(str::to_string),
            target_quarantine_name: disable
                .as_deref()
                .and_then(Path::file_name)
                .and_then(|value| value.to_str())
                .map(str::to_string),
            source_path: None,
            source_hash: None,
            source_quarantine_name: None,
            delete_config: None,
        },
        trusted_mods_root,
    ))
}

struct NteTargetTransactionRequest<'a> {
    source_path: &'a Path,
    trusted_library_root: &'a Path,
    mods_root: &'a Path,
    relative_path: &'a str,
    enabled: bool,
    requested_region: Option<&'a str>,
    deployment_state_root: &'a Path,
    config_dir: Option<&'a Path>,
    config_snapshot: Option<&'a PersistedNteConfig>,
}

fn set_mod_enabled_transaction(
    journal: &mut crate::nte_wal::WalJournal,
    request: NteTargetTransactionRequest<'_>,
) -> Result<NteModOperationResult, String> {
    let NteTargetTransactionRequest {
        source_path,
        trusted_library_root,
        mods_root,
        relative_path,
        enabled,
        requested_region,
        deployment_state_root,
        config_dir,
        config_snapshot: _,
    } = request;
    let region = validated_nte_region(mods_root, requested_region)?;
    let validation = validate_mods_root(mods_root, requested_region);
    if !validation.valid {
        return Err(validation.message);
    }
    let trusted_mods_root = join_components(Path::new(&validation.root), MODS_COMPONENTS);
    recover_nte_target_transaction(
        journal,
        &trusted_mods_root,
        deployment_state_root,
        trusted_library_root,
        config_dir,
    )?;
    let (plan, trusted_mods_root) = prepare_target_wal_plan(
        source_path,
        mods_root,
        relative_path,
        enabled,
        requested_region,
        deployment_state_root,
    )?;
    let payload = serde_json::to_vec(&plan)
        .map_err(|err| format!("Unable to serialize the NTE target transaction plan: {err}"))?;
    let transaction_id = journal.begin(&payload)?;
    journal.append(transaction_id, crate::nte_wal::WalState::Committing, b"{}")?;
    ensure_stopped_before_first_mutation(journal, transaction_id, region)?;

    let (operation_result, paused) = {
        let mut monitor = NteMutationMonitor {
            journal,
            transaction_id,
            region,
            paused: false,
            paths: target_mutation_paths(&plan, &trusted_mods_root)?,
        };
        let result = set_mod_enabled_unlocked(
            source_path,
            mods_root,
            relative_path,
            enabled,
            requested_region,
            deployment_state_root,
            Some(&mut monitor),
        );
        (result, monitor.paused)
    };
    match operation_result {
        Ok(result) => {
            let relative = validate_relative_mod_path(relative_path)?;
            let destination = trusted_mods_root.join(&relative);
            let manifest_path =
                deployment_manifest_path(deployment_state_root, &trusted_mods_root, &relative);
            let artifacts = capture_target_transaction_artifacts(
                &plan,
                &trusted_mods_root,
                trusted_library_root,
            )?;
            let destination_bound =
                BoundDirectoryLeaf::open_optional(&destination, "NTE target destination")?;
            let actual_destination = captured_manifest_for_destination(
                &relative,
                &destination,
                destination_bound.as_ref(),
            )?;
            let actual_state = optional_manifest_file(&manifest_path, &relative)?;
            if actual_destination != plan.after_destination
                || actual_state != plan.after_destination
            {
                return Err(
                    "NTE target transaction completed with an unexpected state; repair is required."
                        .to_string(),
                );
            }
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::StepReceipt,
                br#"{"step":"target_and_state","outcome":"applied"}"#,
            )?;
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::CommittedAfter,
                b"{}",
            )?;
            artifacts.cleanup()?;
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::CleanupComplete,
                br#"{"cleanup":"complete"}"#,
            )?;
            Ok(result)
        }
        Err(operation_err) if paused => Err(operation_err),
        Err(operation_err) => {
            match recover_nte_target_transaction(
                journal,
                &trusted_mods_root,
                deployment_state_root,
                trusted_library_root,
                config_dir,
            ) {
                Ok(()) => Err(operation_err),
                Err(recovery_err) => Err(format!(
                    "{operation_err}; NTE transaction recovery also requires attention: {recovery_err}"
                )),
            }
        }
    }
}

#[cfg(test)]
fn set_mod_enabled_inner(
    source_path: &Path,
    mods_root: &Path,
    relative_path: &str,
    enabled: bool,
    requested_region: Option<&str>,
    deployment_state_root: &Path,
) -> Result<NteModOperationResult, String> {
    let relative = validate_relative_mod_path(relative_path)?;
    let mut trusted_library_root = source_path.to_path_buf();
    for _ in relative.components() {
        trusted_library_root = trusted_library_root
            .parent()
            .ok_or_else(|| "Unable to derive the NTE library root.".to_string())?
            .to_path_buf();
    }
    with_nte_source_target_operation_locks(
        &trusted_library_root,
        mods_root,
        requested_region,
        None,
        None,
        true,
        |_library_journal, target_journal| {
            set_mod_enabled_transaction(
                target_journal,
                NteTargetTransactionRequest {
                    source_path,
                    trusted_library_root: &trusted_library_root,
                    mods_root,
                    relative_path,
                    enabled,
                    requested_region,
                    deployment_state_root,
                    config_dir: None,
                    config_snapshot: None,
                },
            )
        },
    )
}

fn set_mod_enabled_inner_with_library_root(
    request: NteTargetTransactionRequest<'_>,
) -> Result<NteModOperationResult, String> {
    let NteTargetTransactionRequest {
        source_path,
        trusted_library_root,
        mods_root,
        relative_path,
        enabled,
        requested_region,
        deployment_state_root,
        config_dir,
        config_snapshot,
    } = request;
    let relative = validate_relative_mod_path(relative_path)?;
    if normalized_path_for_comparison(source_path)
        != normalized_path_for_comparison(&trusted_library_root.join(relative))
    {
        return Err("NTE source Mod does not match the trusted library path.".to_string());
    }
    with_nte_source_target_operation_locks(
        trusted_library_root,
        mods_root,
        requested_region,
        config_dir,
        config_snapshot,
        true,
        |_library_journal, target_journal| {
            set_mod_enabled_transaction(
                target_journal,
                NteTargetTransactionRequest {
                    source_path,
                    trusted_library_root,
                    mods_root,
                    relative_path,
                    enabled,
                    requested_region,
                    deployment_state_root,
                    config_dir,
                    config_snapshot,
                },
            )
        },
    )
}

struct NteDeleteRequest<'a> {
    source_path: &'a Path,
    trusted_library_root: &'a Path,
    mods_root: &'a Path,
    relative_path: &'a str,
    requested_region: Option<&'a str>,
    deployment_state_root: &'a Path,
    config_dir: Option<&'a Path>,
    config_snapshot: Option<&'a PersistedNteConfig>,
}

fn delete_mod_inner_with_cleanup<F>(
    request: NteDeleteRequest<'_>,
    _cleanup_quarantine: F,
) -> Result<NteModOperationResult, String>
where
    F: FnOnce(&Path) -> std::io::Result<()>,
{
    let NteDeleteRequest {
        source_path,
        trusted_library_root,
        mods_root,
        relative_path,
        requested_region,
        deployment_state_root,
        config_dir,
        config_snapshot,
    } = request;
    with_nte_source_target_operation_locks(
        trusted_library_root,
        mods_root,
        requested_region,
        config_dir,
        config_snapshot,
        true,
        |_library_journal, journal| {
            let region = validated_nte_region(mods_root, requested_region)?;
            let validation = validate_mods_root(mods_root, requested_region);
            if !validation.valid {
                return Err(validation.message);
            }
            let trusted_mods_root = join_components(Path::new(&validation.root), MODS_COMPONENTS);
            recover_nte_target_transaction(
                journal,
                &trusted_mods_root,
                deployment_state_root,
                trusted_library_root,
                config_dir,
            )?;
            let relative = validate_relative_mod_path(relative_path)?;
            let expected_source = trusted_library_root.join(&relative);
            if config_snapshot.is_some()
                && normalized_path_for_comparison(source_path)
                    != normalized_path_for_comparison(&expected_source)
            {
                return Err("NTE source Mod does not match the trusted library path.".to_string());
            }
            let source_parent = source_path
                .parent()
                .ok_or_else(|| "NTE source Mod has no parent directory.".to_string())?;
            let source_name = source_path
                .file_name()
                .ok_or_else(|| "NTE source Mod has no directory name.".to_string())?;
            let source_parent_chain =
                bind_absolute_directory(source_parent, "NTE source ancestor")?;
            let source_handle = match source_parent_chain.leaf().symlink_metadata(source_name) {
                Ok(metadata) if metadata.is_dir() && !metadata.is_symlink() => {
                    Some(open_bound_directory_for_rename(
                        source_parent_chain.leaf(),
                        source_name,
                        "NTE source Mod",
                    )?)
                }
                Ok(_) => return Err("NTE source Mod is unsafe.".to_string()),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
                Err(err) => return Err(format!("Unable to inspect the NTE source Mod: {err}")),
            };
            let Some(source_handle) = source_handle else {
                let destination = trusted_mods_root.join(&relative);
                let manifest_path =
                    deployment_manifest_path(deployment_state_root, &trusted_mods_root, &relative);
                if optional_manifest_for_destination(&relative, &destination)?.is_none()
                    && optional_manifest_file(&manifest_path, &relative)?.is_none()
                {
                    return Ok(NteModOperationResult {
                        enabled: false,
                        destination: destination.to_string_lossy().to_string(),
                        payload_files: 0,
                        message: "NTE Mod was already deleted.".to_string(),
                        config_revision: config_dir.map(read_nte_config_revision).transpose()?,
                    });
                }
                return Err(
                    "NTE source Mod is missing while managed deployment state remains; repair is required."
                        .to_string(),
                );
            };
            let quarantine = unique_sibling(source_path, "delete")?;
            let quarantine_name = quarantine
                .file_name()
                .ok_or_else(|| "NTE source quarantine has no directory name.".to_string())?;
            let (mut plan, _) = prepare_target_wal_plan(
                source_path,
                mods_root,
                relative_path,
                false,
                requested_region,
                deployment_state_root,
            )?;
            plan.operation = "delete".to_string();
            plan.source_path = Some(source_path.to_string_lossy().to_string());
            plan.source_hash = Some(source_tree_hash(source_path)?);
            plan.source_quarantine_name = quarantine
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string);
            plan.delete_config = config_dir
                .map(|directory| prepare_nte_delete_config_plan(directory, relative_path))
                .transpose()?;
            let payload = serde_json::to_vec(&plan).map_err(|err| {
                format!("Unable to serialize the NTE delete transaction plan: {err}")
            })?;
            let transaction_id = journal.begin(&payload)?;
            journal.append(transaction_id, crate::nte_wal::WalState::Committing, b"{}")?;
            ensure_stopped_before_first_mutation(journal, transaction_id, region)?;
            let (operation_result, paused) = {
                let mut monitor = NteMutationMonitor {
                    journal,
                    transaction_id,
                    region,
                    paused: false,
                    paths: target_mutation_paths(&plan, &trusted_mods_root)?,
                };
                let result = set_mod_enabled_unlocked(
                    source_path,
                    mods_root,
                    relative_path,
                    false,
                    requested_region,
                    deployment_state_root,
                    Some(&mut monitor),
                )
                .and_then(|disabled| {
                    mutation_checkpoint(&mut Some(&mut monitor), "quarantine_deleted_source")?;
                    durable_rename_bound_directory(
                        &source_handle,
                        source_parent_chain.leaf(),
                        source_name,
                        source_parent_chain.leaf(),
                        quarantine_name,
                    )
                    .map_err(|err| format!("Unable to quarantine the NTE source Mod: {err}"))?;
                    mutation_checkpoint(&mut Some(&mut monitor), "delete_source_quarantined")?;
                    Ok(disabled)
                });
                (result, monitor.paused)
            };
            let (disabled, artifacts) = match operation_result {
                Ok(disabled) => {
                    let mut artifacts =
                        NteTargetArtifactCaptures::capture_target_only(&plan, &trusted_mods_root)?;
                    artifacts.source_quarantine = Some(BoundDirectoryLeaf::from_open(
                        source_parent_chain,
                        quarantine_name.to_os_string(),
                        source_handle,
                    ));
                    (disabled, artifacts)
                }
                Err(operation_err) if paused => {
                    drop(source_handle);
                    drop(source_parent_chain);
                    return Err(operation_err);
                }
                Err(operation_err) => {
                    drop(source_handle);
                    drop(source_parent_chain);
                    return match recover_nte_target_transaction(
                        journal,
                        &trusted_mods_root,
                        deployment_state_root,
                        trusted_library_root,
                        config_dir,
                    ) {
                        Ok(()) => Err(operation_err),
                        Err(recovery_err) => Err(format!(
                            "{operation_err}; NTE delete recovery also requires attention: {recovery_err}"
                        )),
                    };
                }
            };
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::StepReceipt,
                br#"{"step":"source_quarantine","outcome":"applied"}"#,
            )?;
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::CommittedAfter,
                b"{}",
            )?;
            let config_revision = complete_nte_delete_config(
                config_dir,
                &plan.relative_path,
                plan.delete_config.as_ref(),
            )?;
            artifacts.cleanup()?;
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::CleanupComplete,
                br#"{"cleanup":"complete"}"#,
            )?;
            Ok(NteModOperationResult {
                enabled: false,
                destination: disabled.destination,
                payload_files: disabled.payload_files,
                message: "NTE Mod deleted.".to_string(),
                config_revision,
            })
        },
    )
}

#[cfg(test)]
fn delete_mod_inner(
    source_path: &Path,
    mods_root: &Path,
    relative_path: &str,
    requested_region: Option<&str>,
    deployment_state_root: &Path,
) -> Result<NteModOperationResult, String> {
    let relative = validate_relative_mod_path(relative_path)?;
    let mut trusted_library_root = source_path.to_path_buf();
    for _ in relative.components() {
        trusted_library_root = trusted_library_root
            .parent()
            .ok_or_else(|| "Unable to derive the NTE library root.".to_string())?
            .to_path_buf();
    }
    delete_mod_inner_with_library_root(NteDeleteRequest {
        source_path,
        trusted_library_root: &trusted_library_root,
        mods_root,
        relative_path,
        requested_region,
        deployment_state_root,
        config_dir: None,
        config_snapshot: None,
    })
}

fn delete_mod_inner_with_library_root(
    request: NteDeleteRequest<'_>,
) -> Result<NteModOperationResult, String> {
    delete_mod_inner_with_cleanup(request, remove_owned_transaction_directory_io)
}

struct NteRenameRequest<'a> {
    old_source: &'a Path,
    new_source: &'a Path,
    trusted_library_root: &'a Path,
    mods_root: &'a Path,
    old_relative_text: &'a str,
    new_relative_text: &'a str,
    requested_region: Option<&'a str>,
    deployment_state_root: &'a Path,
    config_dir: &'a Path,
    config_snapshot: Option<&'a PersistedNteConfig>,
}

fn rename_mod_inner_with_library_root(
    request: NteRenameRequest<'_>,
) -> Result<NteModOperationResult, String> {
    let NteRenameRequest {
        old_source,
        new_source,
        trusted_library_root,
        mods_root,
        old_relative_text,
        new_relative_text,
        requested_region,
        deployment_state_root,
        config_dir,
        config_snapshot,
    } = request;
    let old_relative = validate_relative_mod_path(old_relative_text)?;
    let new_relative = validate_relative_mod_path(new_relative_text)?;
    if old_relative == new_relative {
        return Err("The NTE Mod already has that path.".to_string());
    }
    if normalized_path_for_comparison(old_source)
        != normalized_path_for_comparison(&trusted_library_root.join(&old_relative))
        || normalized_path_for_comparison(new_source)
            != normalized_path_for_comparison(&trusted_library_root.join(&new_relative))
    {
        return Err("NTE rename paths do not match the persisted library root.".to_string());
    }
    with_nte_source_target_operation_locks(
        trusted_library_root,
        mods_root,
        requested_region,
        Some(config_dir),
        config_snapshot,
        true,
        |_library_journal, journal| {
            let region = validated_nte_region(mods_root, requested_region)?;
            let validation = validate_mods_root(mods_root, requested_region);
            if !validation.valid {
                return Err(validation.message);
            }
            let trusted_mods_root = join_components(Path::new(&validation.root), MODS_COMPONENTS);
            recover_nte_target_transaction(
                journal,
                &trusted_mods_root,
                deployment_state_root,
                trusted_library_root,
                Some(config_dir),
            )?;
            if !is_directory_without_reparse(old_source) {
                return Err("The NTE Mod to rename is missing or unsafe.".to_string());
            }
            if new_source.exists() {
                return Err("The destination NTE Mod path already exists.".to_string());
            }
            validate_existing_directory_chain(trusted_library_root, &old_relative)?;
            validate_existing_directory_chain(trusted_library_root, &new_relative)?;
            let source_hash = source_tree_hash(old_source)?;
            let old_destination = trusted_mods_root.join(&old_relative);
            let new_destination = trusted_mods_root.join(&new_relative);
            let old_manifest_path =
                deployment_manifest_path(deployment_state_root, &trusted_mods_root, &old_relative);
            let new_manifest_path =
                deployment_manifest_path(deployment_state_root, &trusted_mods_root, &new_relative);
            if new_destination.exists() || new_manifest_path.exists() {
                return Err("The destination NTE deployment path already exists.".to_string());
            }
            let before_destination =
                optional_manifest_for_destination(&old_relative, &old_destination)?;
            let before_state = optional_manifest_file(&old_manifest_path, &old_relative)?;
            if before_destination != before_state {
                return Err(
                    "The NTE deployment and its manifest disagree; repair is required before rename."
                        .to_string(),
                );
            }
            let enabled = before_destination.is_some();
            let after_destination = before_destination.clone().map(|mut manifest| {
                manifest.relative_path = normalized_relative_path(&new_relative)
                    .expect("validated NTE relative path must be Unicode");
                manifest
            });
            let plan = NteTargetWalPlan {
                operation: "rename".to_string(),
                relative_path: normalized_relative_path(&old_relative)?,
                new_relative_path: Some(normalized_relative_path(&new_relative)?),
                enabled,
                before_destination,
                after_destination,
                before_state,
                target_staging_name: None,
                target_backup_name: None,
                target_quarantine_name: None,
                source_path: Some(old_source.to_string_lossy().to_string()),
                source_hash: Some(source_hash),
                source_quarantine_name: None,
                delete_config: None,
            };
            let payload = serde_json::to_vec(&plan)
                .map_err(|err| format!("Unable to serialize the NTE rename plan: {err}"))?;
            let transaction_id = journal.begin(&payload)?;
            journal.append(transaction_id, crate::nte_wal::WalState::Committing, b"{}")?;
            ensure_stopped_before_first_mutation(journal, transaction_id, region)?;
            let (operation_result, paused) = {
                let mut monitor = NteMutationMonitor {
                    journal,
                    transaction_id,
                    region,
                    paused: false,
                    paths: NteMutationPaths::default(),
                };
                let result = (|| {
                    mutation_checkpoint(&mut Some(&mut monitor), "create_rename_source_parent")?;
                    let source_parent = new_source
                        .parent()
                        .ok_or_else(|| "NTE rename destination has no parent.".to_string())?;
                    fs::create_dir_all(source_parent).map_err(|err| err.to_string())?;
                    validate_existing_directory_chain(trusted_library_root, &new_relative)?;
                    mutation_checkpoint(&mut Some(&mut monitor), "rename_source")?;
                    durable_rename(old_source, new_source)
                        .map_err(|err| format!("Unable to rename the NTE source Mod: {err}"))?;
                    if enabled {
                        mutation_checkpoint(
                            &mut Some(&mut monitor),
                            "create_rename_target_parent",
                        )?;
                        let target_parent = new_destination
                            .parent()
                            .ok_or_else(|| "NTE rename target has no parent.".to_string())?;
                        fs::create_dir_all(target_parent).map_err(|err| err.to_string())?;
                        validate_existing_directory_chain(&trusted_mods_root, &new_relative)?;
                        mutation_checkpoint(&mut Some(&mut monitor), "rename_target")?;
                        durable_rename(&old_destination, &new_destination).map_err(|err| {
                            format!("Unable to rename the enabled NTE deployment: {err}")
                        })?;
                        mutation_checkpoint(&mut Some(&mut monitor), "write_renamed_manifest")?;
                        persist_optional_manifest(
                            &new_manifest_path,
                            plan.after_destination.as_ref(),
                        )?;
                        mutation_checkpoint(&mut Some(&mut monitor), "remove_old_rename_manifest")?;
                        remove_file_if_exists(&old_manifest_path)?;
                    }
                    mutation_checkpoint(&mut Some(&mut monitor), "write_rename_config")?;
                    rewrite_nte_config_rename(
                        config_dir,
                        &plan.relative_path,
                        plan.new_relative_path.as_deref().unwrap_or_default(),
                        true,
                    )?;
                    mutation_checkpoint(&mut Some(&mut monitor), "rename_complete")?;
                    Ok(())
                })();
                (result, monitor.paused)
            };
            if let Err(operation_err) = operation_result {
                if paused {
                    return Err(operation_err);
                }
                return match recover_nte_target_transaction(
                    journal,
                    &trusted_mods_root,
                    deployment_state_root,
                    trusted_library_root,
                    Some(config_dir),
                ) {
                    Ok(()) => Err(operation_err),
                    Err(recovery_err) => Err(format!(
                        "{operation_err}; NTE rename recovery also requires attention: {recovery_err}"
                    )),
                };
            }
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::StepReceipt,
                br#"{"step":"rename","outcome":"applied"}"#,
            )?;
            journal.append(
                transaction_id,
                crate::nte_wal::WalState::CommittedAfter,
                b"{}",
            )?;
            recover_nte_target_transaction(
                journal,
                &trusted_mods_root,
                deployment_state_root,
                trusted_library_root,
                Some(config_dir),
            )?;
            Ok(NteModOperationResult {
                enabled,
                destination: new_destination.to_string_lossy().to_string(),
                payload_files: plan
                    .after_destination
                    .as_ref()
                    .map_or(0, |manifest| manifest.files.len()),
                message: "NTE Mod renamed.".to_string(),
                config_revision: Some(read_nte_config_revision(config_dir)?),
            })
        },
    )
}

fn save_nte_config_from_dir(
    config_dir: &Path,
    deployment_state_root: &Path,
    contents: &str,
    expected_updated_at: Option<&str>,
) -> Result<String, String> {
    let config_snapshot: Option<PersistedNteConfig> =
        read_nte_config_value_optional(config_dir, "before standalone save")?
            .map(|config| {
                serde_json::from_value(config)
                    .map_err(|err| format!("Invalid persisted NTE configuration: {err}"))
            })
            .transpose()?;
    if let Some(config_snapshot) = config_snapshot {
        let is_initial_config = config_snapshot.source_dir.trim().is_empty()
            || config_snapshot.target_dir.trim().is_empty();
        if !is_initial_config {
            let roots = trusted_nte_roots_from_snapshot(&config_snapshot)?;
            return with_nte_source_target_operation_locks(
                &roots.source_library_root,
                &roots.mods_root,
                roots.region.as_deref(),
                Some(config_dir),
                Some(&config_snapshot),
                false,
                |_library_journal, target_journal| {
                    recover_nte_target_transaction(
                        target_journal,
                        &roots.mods_root,
                        deployment_state_root,
                        &roots.source_library_root,
                        Some(config_dir),
                    )?;
                    persist_nte_config_cas(config_dir, contents, expected_updated_at)
                },
            );
        }
    }
    with_nte_config_operation_lock(config_dir, || {
        persist_nte_config_cas(config_dir, contents, expected_updated_at)
    })
}

#[tauri::command]
pub async fn save_nte_config(
    app_handle: tauri::AppHandle,
    contents: String,
    expected_updated_at: Option<String>,
) -> Result<String, String> {
    let deployment_state_root = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Unable to resolve NTE deployment state: {err}"))?
        .join("nte-deployments");
    let task_app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = task_app.state::<crate::app_state::AppStateRepository>();
        repository.coordinate_runtime_game_mutation("NTE", |config_dir| {
            save_nte_config_from_dir(
                config_dir,
                &deployment_state_root,
                &contents,
                expected_updated_at.as_deref(),
            )
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn load_nte_config(
    repository: tauri::State<'_, crate::app_state::AppStateRepository>,
) -> Result<String, String> {
    let config = repository.load_game_value("NTE")?;
    serde_json::to_string_pretty(&config)
        .map_err(|err| format!("Unable to serialize NTE configuration: {err}"))
}

#[tauri::command]
pub fn validate_nte_game_root(
    path: String,
    region: Option<String>,
) -> Result<NteGameRootValidation, String> {
    Ok(validate_game_root(Path::new(&path), region.as_deref()))
}

#[tauri::command]
pub fn validate_nte_mods_root(
    mods_root: String,
    region: Option<String>,
) -> Result<NteGameRootValidation, String> {
    Ok(validate_mods_root(Path::new(&mods_root), region.as_deref()))
}

#[tauri::command]
pub fn detect_nte_game_roots() -> Result<Vec<NteGameRootValidation>, String> {
    let mut candidates = Vec::new();
    for base in [
        std::env::var_os("ProgramFiles").map(PathBuf::from),
        std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
    ]
    .into_iter()
    .flatten()
    {
        let path = base.join("Neverness To Everness");
        if !candidates
            .iter()
            .any(|existing: &PathBuf| existing == &path)
        {
            candidates.push(path);
        }
    }
    Ok(candidates
        .into_iter()
        .filter(|path| path.exists())
        .map(|path| validate_game_root(&path, None))
        .collect())
}

#[tauri::command]
pub async fn set_nte_mod_enabled(
    app_handle: tauri::AppHandle,
    relative_path: String,
    enabled: bool,
) -> Result<NteModOperationResult, String> {
    let deployment_state_root = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Unable to resolve NTE deployment state: {err}"))?
        .join("nte-deployments");
    let task_app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = task_app.state::<crate::app_state::AppStateRepository>();
        repository.coordinate_runtime_game_mutation("NTE", |config_dir| {
            let trusted = trusted_nte_paths_from_config(config_dir, &relative_path)?;
            set_mod_enabled_inner_with_library_root(NteTargetTransactionRequest {
                source_path: &trusted.source_path,
                trusted_library_root: &trusted.source_library_root,
                mods_root: &trusted.mods_root,
                relative_path: &relative_path,
                enabled,
                requested_region: trusted.region.as_deref(),
                deployment_state_root: &deployment_state_root,
                config_dir: Some(config_dir),
                config_snapshot: Some(&trusted.config_snapshot),
            })
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn delete_nte_mod(
    app_handle: tauri::AppHandle,
    relative_path: String,
) -> Result<NteModOperationResult, String> {
    let deployment_state_root = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Unable to resolve NTE deployment state: {err}"))?
        .join("nte-deployments");
    let task_app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = task_app.state::<crate::app_state::AppStateRepository>();
        repository.coordinate_runtime_game_mutation("NTE", |config_dir| {
            delete_nte_mod_from_config(config_dir, &deployment_state_root, &relative_path)
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

fn delete_nte_mod_from_config(
    config_dir: &Path,
    deployment_state_root: &Path,
    relative_path: &str,
) -> Result<NteModOperationResult, String> {
    let trusted = trusted_nte_paths_from_config(config_dir, relative_path)?;
    delete_mod_inner_with_library_root(NteDeleteRequest {
        source_path: &trusted.source_path,
        trusted_library_root: &trusted.source_library_root,
        mods_root: &trusted.mods_root,
        relative_path,
        requested_region: trusted.region.as_deref(),
        deployment_state_root,
        config_dir: Some(config_dir),
        config_snapshot: Some(&trusted.config_snapshot),
    })
}

#[tauri::command]
pub async fn rename_nte_mod(
    app_handle: tauri::AppHandle,
    relative_path: String,
    new_relative_path: String,
) -> Result<NteModOperationResult, String> {
    let deployment_state_root = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Unable to resolve NTE deployment state: {err}"))?
        .join("nte-deployments");
    let task_app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = task_app.state::<crate::app_state::AppStateRepository>();
        repository.coordinate_runtime_game_mutation("NTE", |config_dir| {
            let config_snapshot = load_persisted_nte_config(config_dir)?;
            let old = trusted_nte_paths_from_snapshot(config_snapshot.clone(), &relative_path)?;
            let new = trusted_nte_paths_from_snapshot(config_snapshot, &new_relative_path)?;
            if normalized_path_for_comparison(&old.source_library_root)
                != normalized_path_for_comparison(&new.source_library_root)
                || normalized_path_for_comparison(&old.mods_root)
                    != normalized_path_for_comparison(&new.mods_root)
                || old.region != new.region
            {
                return Err("NTE rename roots changed while preparing the operation.".to_string());
            }
            rename_mod_inner_with_library_root(NteRenameRequest {
                old_source: &old.source_path,
                new_source: &new.source_path,
                trusted_library_root: &old.source_library_root,
                mods_root: &old.mods_root,
                old_relative_text: &relative_path,
                new_relative_text: &new_relative_path,
                requested_region: old.region.as_deref(),
                deployment_state_root: &deployment_state_root,
                config_dir,
                config_snapshot: Some(&old.config_snapshot),
            })
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn launch_nte_game(game_root: String, region: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let validation = validate_game_root(Path::new(&game_root), region.as_deref());
        if !validation.valid {
            return Err(validation.message);
        }
        Command::new(&validation.launcher_path)
            .current_dir(&validation.root)
            .spawn()
            .map_err(|err| format!("Unable to launch NTE: {err}"))?;
        Ok(())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn download_parent_creation_never_publishes_the_mod_leaf() {
        let temp = tempdir().unwrap();
        let library = temp.path().join("library");
        fs::create_dir(&library).unwrap();

        let destination =
            ensure_nte_library_destination_parent(&library, "Characters/New Mod").unwrap();

        assert!(library.join("Characters").is_dir());
        assert!(!destination.exists());
    }

    #[test]
    fn download_parent_creation_rejects_an_unsafe_existing_component() {
        let temp = tempdir().unwrap();
        let library = temp.path().join("library");
        fs::create_dir(&library).unwrap();
        fs::write(library.join("Characters"), b"not a directory").unwrap();

        let error = ensure_nte_library_destination_parent(&library, "Characters/New Mod")
            .expect_err("a file cannot be used as a category directory");

        assert!(error.contains("NTE library category"));
        assert!(!library.join("New Mod").exists());
    }

    #[test]
    fn nte_file_lock_is_exclusive_across_processes() {
        const HELPER_ENV: &str = "IMM_NTE_LOCK_TEST_HELPER";
        if let Some(lock_path) = std::env::var_os(HELPER_ENV) {
            let mut contender = open_nte_lock_handle(Path::new(&lock_path)).unwrap();
            let error = contender
                .try_write()
                .expect_err("the parent process must retain the exclusive lock");
            assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
            return;
        }

        let temp = tempdir().unwrap();
        let lock_path = temp.path().join("operation.lock");
        let mut owner = open_nte_lock_handle(&lock_path).unwrap();
        let owner_guard = owner.try_write().unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "nte::tests::nte_file_lock_is_exclusive_across_processes",
                "--nocapture",
            ])
            .env(HELPER_ENV, &lock_path)
            .status()
            .unwrap();
        assert!(status.success(), "cross-process lock helper failed");
        drop(owner_guard);

        with_nte_lock_file(&lock_path, || Ok(())).unwrap();
    }

    #[cfg(windows)]
    fn create_junction(target: &Path, junction: &Path) {
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(junction)
            .arg(target)
            .status()
            .unwrap();
        assert!(status.success(), "failed to create test junction");
    }

    fn create_shared_layout(root: &Path) {
        for relative in [
            SHARED_GAME_EXE,
            &[
                "Client",
                "WindowsNoEditor",
                "HT",
                "Content",
                "Paks",
                "global.utoc",
            ],
            &[
                "Client",
                "WindowsNoEditor",
                "HT",
                "Content",
                "Paks",
                "global.ucas",
            ],
        ] {
            let path = join_components(root, relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"fixture").unwrap();
        }
    }

    #[test]
    fn target_operation_lock_is_rooted_outside_the_paks_scan_tree() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);

        let lock_path = validated_target_lock_path(&mods_root, Some("global")).unwrap();

        assert_eq!(lock_path.file_name().unwrap(), NTE_TARGET_LOCK_FILE);
        assert_eq!(lock_path.parent().unwrap().file_name().unwrap(), "Content");
        assert!(!lock_path.starts_with(
            root.join("Client")
                .join("WindowsNoEditor")
                .join("HT")
                .join("Content")
                .join("Paks")
        ));
    }

    fn create_region_layout(root: &Path, region: NteRegion) {
        fs::write(root.join(region.launcher()), b"launcher").unwrap();
        let (folder, markers) = region.nested_markers();
        let nested = root.join(folder);
        fs::create_dir_all(&nested).unwrap();
        for marker in markers {
            fs::write(nested.join(marker), b"marker").unwrap();
        }
    }

    #[test]
    fn validates_global_cn_and_tw_roots_without_guessing() {
        for region in [NteRegion::Global, NteRegion::Cn, NteRegion::Tw] {
            let temp = tempdir().unwrap();
            create_shared_layout(temp.path());
            create_region_layout(temp.path(), region);
            let result = validate_game_root(temp.path(), None);
            assert!(result.valid);
            assert_eq!(result.region.as_deref(), Some(region.id()));
            assert!(result.mods_root.ends_with(r"Content\Paks\~mods"));
        }
    }

    #[test]
    fn ambiguous_region_markers_require_an_explicit_override() {
        let temp = tempdir().unwrap();
        create_shared_layout(temp.path());
        create_region_layout(temp.path(), NteRegion::Global);
        create_region_layout(temp.path(), NteRegion::Cn);
        let ambiguous = validate_game_root(temp.path(), None);
        assert!(!ambiguous.valid);
        assert_eq!(ambiguous.candidates, vec!["global", "cn"]);
        let selected = validate_game_root(temp.path(), Some("cn"));
        assert!(selected.valid);
        assert_eq!(selected.region.as_deref(), Some("cn"));
    }

    #[test]
    fn missing_shared_content_rejects_an_otherwise_complete_launcher() {
        let temp = tempdir().unwrap();
        create_region_layout(temp.path(), NteRegion::Global);
        let result = validate_game_root(temp.path(), None);
        assert!(!result.valid);
        assert!(result.message.contains("required game content"));
    }

    #[test]
    fn nte_mod_enable_disable_roundtrip_preserves_external_changes() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();
        fs::write(source.join("demo.utoc"), b"utoc").unwrap();

        let enabled = set_mod_enabled_inner(
            &source,
            &mods_root,
            r"Skins\Demo",
            true,
            Some("global"),
            &temp.path().join("state"),
        )
        .unwrap();
        assert!(enabled.enabled);
        let destination = mods_root.join("Skins").join("Demo");
        assert_eq!(fs::read(destination.join("demo.pak")).unwrap(), b"pak");

        let disabled = set_mod_enabled_inner(
            &source,
            &mods_root,
            r"Skins\Demo",
            false,
            Some("global"),
            &temp.path().join("state"),
        )
        .unwrap();
        assert!(!disabled.enabled);
        assert!(!destination.exists());

        set_mod_enabled_inner(
            &source,
            &mods_root,
            r"Skins\Demo",
            true,
            Some("global"),
            &temp.path().join("state"),
        )
        .unwrap();
        fs::write(destination.join("demo.pak"), b"external").unwrap();
        assert!(set_mod_enabled_inner(
            &source,
            &mods_root,
            r"Skins\Demo",
            false,
            Some("global"),
            &temp.path().join("state"),
        )
        .is_err());
        assert!(destination.exists());
        let target_wal = root
            .join("Client")
            .join("WindowsNoEditor")
            .join("HT")
            .join("Content")
            .join(NTE_TARGET_WAL_FILE);
        let summary = crate::nte_wal::validate_or_repair(&target_wal).unwrap();
        assert_eq!(summary.valid_records, 5);
        assert!(!summary.repaired_tail);
    }

    #[test]
    fn target_recovery_rolls_forward_after_payload_before_manifest_receipt() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let relative = PathBuf::from("Demo");
        let destination = mods_root.join(&relative);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("demo.pak"), b"new").unwrap();
        fs::write(destination.join("demo.pak"), b"new").unwrap();
        let source_files = payload_entries(&source).unwrap();
        let after = build_deployment_manifest(&relative, &source_files).unwrap();
        let plan = NteTargetWalPlan {
            operation: "enable".to_string(),
            relative_path: "Demo".to_string(),
            new_relative_path: None,
            enabled: true,
            before_destination: None,
            after_destination: Some(after.clone()),
            before_state: None,
            target_staging_name: None,
            target_backup_name: None,
            target_quarantine_name: None,
            source_path: None,
            source_hash: None,
            source_quarantine_name: None,
            delete_config: None,
        };
        let wal_path = root
            .join("Client")
            .join("WindowsNoEditor")
            .join("HT")
            .join("Content")
            .join(NTE_TARGET_WAL_FILE);
        let mut journal = crate::nte_wal::WalJournal::open(&wal_path).unwrap();
        let transaction_id = journal.begin(&serde_json::to_vec(&plan).unwrap()).unwrap();
        journal
            .append(transaction_id, crate::nte_wal::WalState::Committing, b"{}")
            .unwrap();
        drop(journal);

        with_nte_target_operation_lock(&mods_root, Some("global"), |journal| {
            recover_nte_target_transaction(journal, &mods_root, &state_root, temp.path(), None)
        })
        .unwrap();

        let manifest_path = deployment_manifest_path(&state_root, &mods_root, &relative);
        assert_eq!(
            read_deployment_manifest(&manifest_path, &relative).unwrap(),
            Some(after)
        );
    }

    #[test]
    fn committed_enable_rolls_forward_when_the_directory_rename_was_not_durable() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let relative = PathBuf::from("Demo");
        let destination = mods_root.join(&relative);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"after").unwrap();
        let source_files = payload_entries(&source).unwrap();
        let after = build_deployment_manifest(&relative, &source_files).unwrap();
        let quarantine_root = deployment_quarantine_root(&mods_root).unwrap();
        ensure_quarantine_root(&quarantine_root).unwrap();
        let staging =
            unique_quarantine_candidate(&quarantine_root, &destination, "staging").unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("demo.pak"), b"after").unwrap();
        let plan = NteTargetWalPlan {
            operation: "enable".to_string(),
            relative_path: "Demo".to_string(),
            new_relative_path: None,
            enabled: true,
            before_destination: None,
            after_destination: Some(after.clone()),
            before_state: None,
            target_staging_name: staging
                .file_name()
                .map(|value| value.to_string_lossy().to_string()),
            target_backup_name: None,
            target_quarantine_name: None,
            source_path: None,
            source_hash: None,
            source_quarantine_name: None,
            delete_config: None,
        };
        let wal_path = target_wal_path(&root);
        let mut journal = crate::nte_wal::WalJournal::open(&wal_path).unwrap();
        let transaction_id = journal.begin(&serde_json::to_vec(&plan).unwrap()).unwrap();
        journal
            .append(transaction_id, crate::nte_wal::WalState::Committing, b"{}")
            .unwrap();
        journal
            .append(transaction_id, crate::nte_wal::WalState::StepReceipt, b"{}")
            .unwrap();
        journal
            .append(
                transaction_id,
                crate::nte_wal::WalState::CommittedAfter,
                b"{}",
            )
            .unwrap();
        drop(journal);

        with_nte_target_operation_lock(&mods_root, Some("global"), |journal| {
            recover_nte_target_transaction(journal, &mods_root, &state_root, temp.path(), None)
        })
        .unwrap();

        assert_eq!(
            optional_manifest_for_destination(&relative, &destination).unwrap(),
            Some(after)
        );
        assert!(!staging.exists());
    }

    #[test]
    fn persisted_config_derives_the_only_trusted_nte_source_and_target() {
        let temp = tempdir().unwrap();
        let source_root = temp.path().join("library");
        let managed_root = source_root.join(MANAGED_SOURCE_DIR);
        let source = managed_root.join("Category").join("Demo");
        let game_root = temp.path().join("game");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();
        fs::create_dir_all(&game_root).unwrap();
        create_shared_layout(&game_root);
        create_region_layout(&game_root, NteRegion::Global);
        let mods_root = join_components(&game_root, MODS_COMPONENTS);
        fs::write(
            temp.path().join("configNTE.json"),
            serde_json::to_vec(&serde_json::json!({
                "game": "NTE",
                "sourceDir": source_root,
                "targetDir": mods_root,
                "nteRegion": "global"
            }))
            .unwrap(),
        )
        .unwrap();

        let trusted = trusted_nte_paths_from_config(temp.path(), r"Category\Demo").unwrap();
        assert_eq!(trusted.source_path, source.canonicalize().unwrap());
        assert_eq!(
            normalized_path_for_comparison(&trusted.mods_root),
            normalized_path_for_comparison(&mods_root)
        );
        assert!(trusted.source_path.starts_with(trusted.source_library_root));
        assert!(trusted_nte_paths_from_config(temp.path(), r"..\outside").is_err());
    }

    #[test]
    fn persisted_config_rejects_a_different_game_identity() {
        let temp = tempdir().unwrap();
        fs::write(
            temp.path().join("configNTE.json"),
            serde_json::to_vec(&serde_json::json!({
                "game": "WW",
                "sourceDir": "unused",
                "targetDir": "unused",
                "nteRegion": "global"
            }))
            .unwrap(),
        )
        .unwrap();

        let error = load_persisted_nte_config(temp.path()).unwrap_err();
        assert!(error.contains("wrong game identity"));
    }

    #[cfg(windows)]
    #[test]
    fn persisted_config_rejects_a_parent_directory_junction() {
        let temp = tempdir().unwrap();
        let real_config = temp.path().join("real-config");
        let linked_config = temp.path().join("linked-config");
        fs::create_dir(&real_config).unwrap();
        fs::write(
            real_config.join("configNTE.json"),
            serde_json::to_vec(&serde_json::json!({
                "game": "NTE",
                "sourceDir": "unused",
                "targetDir": "unused",
                "nteRegion": "global"
            }))
            .unwrap(),
        )
        .unwrap();
        create_junction(&real_config, &linked_config);

        assert!(load_persisted_nte_config(&linked_config).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn archive_destination_parent_cannot_be_replaced_while_bound() {
        let temp = tempdir().unwrap();
        let library_root = temp.path().join("library");
        let category = library_root.join("Category");
        let destination = category.join("Demo");
        let replacement = library_root.join("Category-replaced");
        fs::create_dir_all(&category).unwrap();

        with_bound_nte_library_destination(&library_root, &destination, |_, _| {
            assert!(fs::rename(&category, &replacement).is_err());
            Ok(())
        })
        .unwrap();
        assert!(category.is_dir());
        assert!(!replacement.exists());
    }

    #[cfg(windows)]
    #[test]
    fn bound_leaf_handle_blocks_replacement_and_renames_the_open_directory() {
        let temp = tempdir().unwrap();
        let parent = temp.path().join("library");
        let source = parent.join("Demo");
        let attacker_name = parent.join("Attacker");
        let destination = parent.join("Quarantined");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"trusted").unwrap();

        let parent_chain = bind_absolute_directory(&parent, "test parent").unwrap();
        let source_handle = open_bound_directory_for_rename(
            parent_chain.leaf(),
            source.file_name().unwrap(),
            "test source",
        )
        .unwrap();

        assert!(fs::rename(&source, &attacker_name).is_err());
        durable_rename_bound_directory(
            &source_handle,
            parent_chain.leaf(),
            source.file_name().unwrap(),
            parent_chain.leaf(),
            destination.file_name().unwrap(),
        )
        .unwrap();

        assert!(!source.exists());
        assert!(!attacker_name.exists());
        assert_eq!(fs::read(destination.join("demo.pak")).unwrap(), b"trusted");
    }

    #[cfg(windows)]
    #[test]
    fn bound_recursive_delete_removes_the_open_leaf_without_a_replacement_window() {
        let temp = tempdir().unwrap();
        let parent = temp.path().join("library");
        let source = parent.join("OwnedArtifact");
        let replacement = parent.join("Replacement");
        let external = temp.path().join("external");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(source.join("nested/demo.pak"), b"owned").unwrap();
        fs::write(external.join("keep.pak"), b"external").unwrap();

        let parent_chain = bind_absolute_directory(&parent, "test cleanup parent").unwrap();
        let source_handle = open_bound_directory_for_rename(
            parent_chain.leaf(),
            source.file_name().unwrap(),
            "test cleanup source",
        )
        .unwrap();

        assert!(fs::rename(&source, &replacement).is_err());
        remove_open_bound_directory_tree(
            source_handle,
            parent_chain.leaf(),
            source.file_name().unwrap(),
            "test cleanup source",
        )
        .unwrap();

        assert!(!source.exists());
        assert!(!replacement.exists());
        assert_eq!(fs::read(external.join("keep.pak")).unwrap(), b"external");
    }

    #[cfg(windows)]
    #[test]
    fn bound_recursive_delete_rejects_a_junction_leaf_without_touching_its_target() {
        let temp = tempdir().unwrap();
        let parent = temp.path().join("library");
        let external = temp.path().join("external");
        let junction = parent.join("OwnedArtifact");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(external.join("keep.pak"), b"external").unwrap();
        create_junction(&external, &junction);

        let parent_chain = bind_absolute_directory(&parent, "test cleanup parent").unwrap();
        let error = remove_bound_directory_tree(
            parent_chain.leaf(),
            junction.file_name().unwrap(),
            "test cleanup junction",
        )
        .unwrap_err();

        assert!(error.contains("unsafe"));
        assert!(junction.exists());
        assert_eq!(fs::read(external.join("keep.pak")).unwrap(), b"external");
    }

    #[cfg(windows)]
    #[test]
    fn quarantine_root_cleanup_deletes_only_an_open_empty_leaf() {
        let temp = tempdir().unwrap();
        let quarantine_root = temp.path().join(".imm-nte-quarantine");
        fs::create_dir(&quarantine_root).unwrap();

        cleanup_quarantine_root_if_empty(&quarantine_root).unwrap();

        assert!(!quarantine_root.exists());
    }

    #[cfg(windows)]
    #[test]
    fn quarantine_root_cleanup_preserves_a_nonempty_leaf() {
        let temp = tempdir().unwrap();
        let quarantine_root = temp.path().join(".imm-nte-quarantine");
        fs::create_dir(&quarantine_root).unwrap();
        fs::write(quarantine_root.join("owned-artifact"), b"keep").unwrap();

        cleanup_quarantine_root_if_empty(&quarantine_root).unwrap();

        assert_eq!(
            fs::read(quarantine_root.join("owned-artifact")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn target_cleanup_skips_an_artifact_created_after_capture() {
        let temp = tempdir().unwrap();
        let staging = temp.path().join(".Demo.imm-staging-1-8");
        let captured = capture_optional_transaction_artifact(Some(&staging), "test staging")
            .expect("capture missing staging");
        assert!(captured.is_none());

        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("keep.pak"), b"replacement").unwrap();

        NteTargetArtifactCaptures {
            staging: captured,
            backup: None,
            disable: None,
            source_quarantine: None,
        }
        .cleanup()
        .expect("captured cleanup");
        assert_eq!(fs::read(staging.join("keep.pak")).unwrap(), b"replacement");
    }

    #[test]
    fn persisted_library_recognizes_a_safe_destination_before_its_leaf_exists() {
        let temp = tempdir().unwrap();
        let source_root = temp.path().join("library");
        let managed_root = source_root.join(MANAGED_SOURCE_DIR);
        let category = managed_root.join("Category");
        let game_root = temp.path().join("game");
        fs::create_dir_all(&category).unwrap();
        fs::create_dir_all(&game_root).unwrap();
        create_shared_layout(&game_root);
        create_region_layout(&game_root, NteRegion::Global);
        let mods_root = join_components(&game_root, MODS_COMPONENTS);
        fs::write(
            temp.path().join("configNTE.json"),
            serde_json::to_vec(&serde_json::json!({
                "game": "NTE",
                "sourceDir": source_root,
                "targetDir": mods_root,
                "nteRegion": "global"
            }))
            .unwrap(),
        )
        .unwrap();

        let missing_leaf = category.join("NewMod");
        assert!(!missing_leaf.exists());
        assert!(is_persisted_nte_library_destination(temp.path(), &missing_leaf).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn ordinary_destination_is_rebased_under_an_extended_canonical_library_root() {
        let temp = tempdir().unwrap();
        let library_root = temp.path().join("library");
        let category = library_root.join("Category");
        fs::create_dir_all(&category).unwrap();
        let canonical_root = library_root.canonicalize().unwrap();
        let ordinary_destination = category.join("NewMod");

        assert!(ordinary_destination.strip_prefix(&canonical_root).is_err());
        let resolved =
            canonical_nte_library_destination(&canonical_root, &ordinary_destination).unwrap();
        assert!(resolved.strip_prefix(&canonical_root).is_ok());
        assert_eq!(
            normalized_path_for_comparison(&resolved),
            normalized_path_for_comparison(&ordinary_destination)
        );
        with_bound_nte_library_destination(&canonical_root, &ordinary_destination, |_, name| {
            assert_eq!(name, std::ffi::OsStr::new("NewMod"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn archive_detection_fails_closed_when_nte_config_cannot_be_read_as_a_file() {
        let temp = tempdir().unwrap();
        fs::create_dir(temp.path().join("configNTE.json")).unwrap();

        let result = is_persisted_nte_library_destination(
            temp.path(),
            &temp.path().join("library").join("Category").join("Mod"),
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not a safe file"));
    }

    #[test]
    fn nte_config_cas_rejects_a_snapshot_older_than_the_committed_revision() {
        let temp = tempdir().unwrap();
        let config_path = temp.path().join("configNTE.json");
        fs::write(
            &config_path,
            serde_json::to_vec(&serde_json::json!({
                "game": "NTE",
                "updatedAt": "revision-one",
                "data": { "Old\\Mod": { "note": "old" } }
            }))
            .unwrap(),
        )
        .unwrap();
        let next = serde_json::json!({
            "game": "NTE",
            "updatedAt": "revision-two",
            "data": { "New\\Mod": { "note": "new" } }
        });
        assert_eq!(
            persist_nte_config_cas(temp.path(), &next.to_string(), Some("revision-one")).unwrap(),
            "revision-two"
        );

        let stale = serde_json::json!({
            "game": "NTE",
            "updatedAt": "revision-stale",
            "data": { "Old\\Mod": { "note": "stale" } }
        });
        let error = persist_nte_config_cas(temp.path(), &stale.to_string(), Some("revision-one"))
            .unwrap_err();
        assert!(error.contains("changed while this update was pending"));
        let committed: serde_json::Value =
            serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
        assert_eq!(committed["updatedAt"], "revision-two");
        assert!(committed["data"].get(r"Old\Mod").is_none());
        assert_eq!(committed["data"][r"New\Mod"]["note"], "new");
    }

    #[test]
    fn mutation_rejects_source_target_or_region_changed_before_all_locks() {
        for changed_field in ["sourceDir", "targetDir", "nteRegion"] {
            let temp = tempdir().unwrap();
            let source_root = temp.path().join("library");
            let managed_root = source_root.join(MANAGED_SOURCE_DIR);
            let source = managed_root.join("Demo");
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join("demo.pak"), b"payload").unwrap();

            let game_root = temp.path().join("game");
            fs::create_dir_all(&game_root).unwrap();
            create_shared_layout(&game_root);
            create_region_layout(&game_root, NteRegion::Global);
            let mods_root = join_components(&game_root, MODS_COMPONENTS);

            let alternate_source_root = temp.path().join("alternate-library");
            fs::create_dir_all(alternate_source_root.join(MANAGED_SOURCE_DIR)).unwrap();
            let alternate_game_root = temp.path().join("alternate-game");
            fs::create_dir_all(&alternate_game_root).unwrap();
            create_shared_layout(&alternate_game_root);
            create_region_layout(&alternate_game_root, NteRegion::Global);
            let alternate_mods_root = join_components(&alternate_game_root, MODS_COMPONENTS);

            let config_path = temp.path().join("configNTE.json");
            let mut config = serde_json::json!({
                "game": "NTE",
                "updatedAt": "before",
                "sourceDir": source_root,
                "targetDir": mods_root,
                "nteRegion": "global",
                "data": {},
                "presets": []
            });
            fs::write(&config_path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
            let trusted = trusted_nte_paths_from_config(temp.path(), "Demo").unwrap();

            config[changed_field] = match changed_field {
                "sourceDir" => {
                    serde_json::Value::String(alternate_source_root.to_string_lossy().to_string())
                }
                "targetDir" => {
                    serde_json::Value::String(alternate_mods_root.to_string_lossy().to_string())
                }
                "nteRegion" => serde_json::Value::String("cn".to_string()),
                _ => unreachable!(),
            };
            fs::write(&config_path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();

            let result = set_mod_enabled_inner_with_library_root(NteTargetTransactionRequest {
                source_path: &trusted.source_path,
                trusted_library_root: &trusted.source_library_root,
                mods_root: &trusted.mods_root,
                relative_path: "Demo",
                enabled: true,
                requested_region: trusted.region.as_deref(),
                deployment_state_root: &temp.path().join("state"),
                config_dir: Some(temp.path()),
                config_snapshot: Some(&trusted.config_snapshot),
            });
            assert!(
                result
                    .unwrap_err()
                    .contains("changed before the operation acquired all locks"),
                "{changed_field} change was not rejected"
            );
            assert!(!trusted.mods_root.join("Demo").exists());
        }
    }

    #[test]
    fn aborted_before_target_terminal_never_rolls_forward_staging() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let relative = PathBuf::from("Demo");
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"after").unwrap();
        let after =
            build_deployment_manifest(&relative, &payload_entries(&source).unwrap()).unwrap();
        let quarantine_root = deployment_quarantine_root(&mods_root).unwrap();
        ensure_quarantine_root(&quarantine_root).unwrap();
        let staging =
            unique_quarantine_candidate(&quarantine_root, &mods_root.join(&relative), "staging")
                .unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("demo.pak"), b"after").unwrap();
        let plan = NteTargetWalPlan {
            operation: "enable".to_string(),
            relative_path: "Demo".to_string(),
            new_relative_path: None,
            enabled: true,
            before_destination: None,
            after_destination: Some(after),
            before_state: None,
            target_staging_name: staging
                .file_name()
                .map(|value| value.to_string_lossy().to_string()),
            target_backup_name: None,
            target_quarantine_name: None,
            source_path: None,
            source_hash: None,
            source_quarantine_name: None,
            delete_config: None,
        };
        let mut journal = crate::nte_wal::WalJournal::open(&target_wal_path(&root)).unwrap();
        let transaction_id = journal.begin(&serde_json::to_vec(&plan).unwrap()).unwrap();
        journal
            .append(transaction_id, crate::nte_wal::WalState::Committing, b"{}")
            .unwrap();
        journal
            .append(
                transaction_id,
                crate::nte_wal::WalState::AbortedBefore,
                b"{}",
            )
            .unwrap();
        drop(journal);

        with_nte_target_operation_lock(&mods_root, Some("global"), |journal| {
            recover_nte_target_transaction(journal, &mods_root, &state_root, temp.path(), None)
        })
        .unwrap();
        assert!(!mods_root.join("Demo").exists());
        assert!(!staging.exists());
    }

    #[test]
    fn native_rename_recovers_each_cross_root_interruption_before_retry() {
        for pause_step in [
            "create_rename_target_parent",
            "write_renamed_manifest",
            "rename_complete",
        ] {
            let temp = tempdir().unwrap();
            let source_root = temp.path().join("library");
            let managed_root = source_root.join(MANAGED_SOURCE_DIR);
            let old_source = managed_root.join("Old").join("Demo");
            let new_source = managed_root.join("New").join("Renamed");
            let game_root = temp.path().join("game");
            let state_root = temp.path().join("state");
            fs::create_dir_all(&old_source).unwrap();
            fs::create_dir_all(new_source.parent().unwrap()).unwrap();
            fs::write(old_source.join("demo.pak"), b"payload").unwrap();
            fs::create_dir_all(&game_root).unwrap();
            create_shared_layout(&game_root);
            create_region_layout(&game_root, NteRegion::Global);
            let mods_root = join_components(&game_root, MODS_COMPONENTS);
            fs::write(
                temp.path().join("configNTE.json"),
                serde_json::to_vec_pretty(&serde_json::json!({
                    "game": "NTE",
                    "sourceDir": source_root,
                    "targetDir": mods_root,
                    "nteRegion": "global",
                    "data": { "Old\\Demo": { "note": "kept" } },
                    "presets": [{ "data": ["Old\\Demo"] }]
                }))
                .unwrap(),
            )
            .unwrap();
            let managed_root = managed_root.canonicalize().unwrap();
            let old_source = old_source.canonicalize().unwrap();
            let new_source = managed_root.join("New").join("Renamed");
            set_mod_enabled_inner_with_library_root(NteTargetTransactionRequest {
                source_path: &old_source,
                trusted_library_root: &managed_root,
                mods_root: &mods_root,
                relative_path: r"Old\Demo",
                enabled: true,
                requested_region: Some("global"),
                deployment_state_root: &state_root,
                config_dir: Some(temp.path()),
                config_snapshot: None,
            })
            .unwrap();

            inject_process_pause_at(Some(pause_step));
            let paused = rename_mod_inner_with_library_root(NteRenameRequest {
                old_source: &old_source,
                new_source: &new_source,
                trusted_library_root: &managed_root,
                mods_root: &mods_root,
                old_relative_text: r"Old\Demo",
                new_relative_text: r"New\Renamed",
                requested_region: Some("global"),
                deployment_state_root: &state_root,
                config_dir: temp.path(),
                config_snapshot: None,
            });
            inject_process_pause_at(None);
            assert!(
                paused.is_err(),
                "pause step {pause_step} did not interrupt rename"
            );

            let renamed = rename_mod_inner_with_library_root(NteRenameRequest {
                old_source: &old_source,
                new_source: &new_source,
                trusted_library_root: &managed_root,
                mods_root: &mods_root,
                old_relative_text: r"Old\Demo",
                new_relative_text: r"New\Renamed",
                requested_region: Some("global"),
                deployment_state_root: &state_root,
                config_dir: temp.path(),
                config_snapshot: None,
            })
            .unwrap();
            assert!(renamed.enabled);
            assert!(renamed.config_revision.is_some());
            assert!(!old_source.exists());
            assert!(new_source.join("demo.pak").exists());
            assert!(!mods_root.join("Old").join("Demo").exists());
            assert!(mods_root
                .join("New")
                .join("Renamed")
                .join("demo.pak")
                .exists());
            let config: serde_json::Value =
                serde_json::from_slice(&fs::read(temp.path().join("configNTE.json")).unwrap())
                    .unwrap();
            assert_eq!(
                config["updatedAt"].as_str(),
                renamed.config_revision.as_deref()
            );
            assert!(config["data"].get(r"Old\Demo").is_none());
            assert_eq!(config["data"][r"New\Renamed"]["note"], "kept");
            assert_eq!(config["presets"][0]["data"][0], r"New\Renamed");
        }
    }

    #[test]
    fn delete_recovery_commits_verified_source_quarantine() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("Demo");
        let quarantine = temp.path().join(".Demo.imm-delete-1-1");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();
        let source_hash = source_tree_hash(&source).unwrap();
        let plan = NteTargetWalPlan {
            operation: "delete".to_string(),
            relative_path: "Demo".to_string(),
            new_relative_path: None,
            enabled: false,
            before_destination: None,
            after_destination: None,
            before_state: None,
            target_staging_name: None,
            target_backup_name: None,
            target_quarantine_name: None,
            source_path: Some(source.to_string_lossy().to_string()),
            source_hash: Some(source_hash),
            source_quarantine_name: Some(".Demo.imm-delete-1-1".to_string()),
            delete_config: None,
        };
        let wal_path = root
            .join("Client")
            .join("WindowsNoEditor")
            .join("HT")
            .join("Content")
            .join(NTE_TARGET_WAL_FILE);
        let mut journal = crate::nte_wal::WalJournal::open(&wal_path).unwrap();
        let transaction_id = journal.begin(&serde_json::to_vec(&plan).unwrap()).unwrap();
        journal
            .append(transaction_id, crate::nte_wal::WalState::Committing, b"{}")
            .unwrap();
        fs::rename(&source, &quarantine).unwrap();
        drop(journal);

        with_nte_target_operation_lock(&mods_root, Some("global"), |journal| {
            recover_nte_target_transaction(journal, &mods_root, &state_root, temp.path(), None)
        })
        .unwrap();

        assert!(!source.exists());
        assert!(!quarantine.exists());
        let mut journal = crate::nte_wal::WalJournal::open(&wal_path).unwrap();
        assert!(journal.incomplete_transaction().unwrap().is_none());
    }

    #[test]
    fn explicit_region_allows_operations_on_an_ambiguous_root() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        create_region_layout(&root, NteRegion::Cn);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();

        assert!(set_mod_enabled_inner(
            &source,
            &mods_root,
            r"Skins\Demo",
            true,
            Some("cn"),
            &temp.path().join("state"),
        )
        .is_ok());
    }

    #[test]
    fn process_start_before_first_mutation_aborts_without_changing_target() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();
        NTE_PROCESS_TEST_REMAINING_CLEAR_CHECKS.with(|checks| checks.set(Some(1)));

        let result = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &temp.path().join("state"),
        );
        NTE_PROCESS_TEST_REMAINING_CLEAR_CHECKS.with(|checks| checks.set(None));

        assert!(result.is_err());
        assert!(!mods_root.join("Demo").exists());
        assert!(source.join("demo.pak").exists());
        let wal_path = root
            .join("Client")
            .join("WindowsNoEditor")
            .join("HT")
            .join("Content")
            .join(NTE_TARGET_WAL_FILE);
        let mut journal = crate::nte_wal::WalJournal::open(&wal_path).unwrap();
        assert!(journal.incomplete_transaction().unwrap().is_none());
    }

    fn target_wal_path(root: &Path) -> PathBuf {
        root.join("Client")
            .join("WindowsNoEditor")
            .join("HT")
            .join("Content")
            .join(NTE_TARGET_WAL_FILE)
    }

    fn inject_process_pause_at(step: Option<&str>) {
        NTE_PROCESS_TEST_PAUSE_AT_STEP.with(|target| {
            *target.borrow_mut() = step.map(str::to_string);
        });
    }

    #[test]
    fn update_pauses_after_backup_and_recovers_before_retrying() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"before").unwrap();
        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();
        fs::write(source.join("demo.pak"), b"after").unwrap();

        inject_process_pause_at(Some("deploy_updated_destination"));
        let paused = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        );
        inject_process_pause_at(None);

        assert!(paused.is_err());
        assert!(!mods_root.join("Demo").exists());
        let mut journal = crate::nte_wal::WalJournal::open(&target_wal_path(&root)).unwrap();
        assert_eq!(
            journal.incomplete_transaction().unwrap().unwrap().state,
            crate::nte_wal::WalState::PausedExternalProcess
        );
        drop(journal);

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();
        assert_eq!(
            fs::read(mods_root.join("Demo").join("demo.pak")).unwrap(),
            b"after"
        );
    }

    #[test]
    fn enable_recovers_an_empty_staging_directory_after_process_pause() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();

        inject_process_pause_at(Some("copy_payload_file"));
        let paused = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        );
        inject_process_pause_at(None);

        assert!(paused.is_err());
        assert!(!mods_root.join("Demo").exists());
        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();
        assert_eq!(fs::read(mods_root.join("Demo/demo.pak")).unwrap(), b"pak");
    }

    #[test]
    fn pause_receipt_flush_uncertainty_never_recovers_in_the_same_invocation() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"before").unwrap();
        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();
        fs::write(source.join("demo.pak"), b"after").unwrap();

        inject_process_pause_at(Some("deploy_updated_destination"));
        let fault = crate::nte_wal::inject_pause_flush_fault(false);
        let paused = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        );
        drop(fault);
        inject_process_pause_at(None);

        assert!(paused.is_err());
        assert!(!mods_root.join("Demo").exists());
        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();
        assert_eq!(fs::read(mods_root.join("Demo/demo.pak")).unwrap(), b"after");
    }

    #[test]
    fn disable_pauses_after_quarantine_and_recovers_before_retrying() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();
        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();

        inject_process_pause_at(Some("remove_deployment_manifest"));
        let paused = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            false,
            Some("global"),
            &state_root,
        );
        inject_process_pause_at(None);

        assert!(paused.is_err());
        assert!(!mods_root.join("Demo").exists());
        let mut journal = crate::nte_wal::WalJournal::open(&target_wal_path(&root)).unwrap();
        assert_eq!(
            journal.incomplete_transaction().unwrap().unwrap().state,
            crate::nte_wal::WalState::PausedExternalProcess
        );
        drop(journal);

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            false,
            Some("global"),
            &state_root,
        )
        .unwrap();
        assert!(!mods_root.join("Demo").exists());
    }

    #[test]
    fn delete_pauses_after_target_disable_without_moving_source() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();
        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();

        inject_process_pause_at(Some("quarantine_deleted_source"));
        let paused = delete_mod_inner(&source, &mods_root, "Demo", Some("global"), &state_root);
        inject_process_pause_at(None);

        assert!(paused.is_err());
        assert!(source.join("demo.pak").exists());
        assert!(!mods_root.join("Demo").exists());
        let mut journal = crate::nte_wal::WalJournal::open(&target_wal_path(&root)).unwrap();
        assert_eq!(
            journal.incomplete_transaction().unwrap().unwrap().state,
            crate::nte_wal::WalState::PausedExternalProcess
        );
        drop(journal);

        let deleted =
            delete_mod_inner(&source, &mods_root, "Demo", Some("global"), &state_root).unwrap();
        assert!(!deleted.enabled);
        assert!(!source.exists());
        assert!(!mods_root.join("Demo").exists());
    }

    #[test]
    fn delete_recovers_when_paused_before_manifest_removal() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();
        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();

        inject_process_pause_at(Some("remove_deployment_manifest"));
        let paused = delete_mod_inner(&source, &mods_root, "Demo", Some("global"), &state_root);
        inject_process_pause_at(None);

        assert!(paused.is_err());
        assert!(source.exists());
        assert!(!mods_root.join("Demo").exists());
        delete_mod_inner(&source, &mods_root, "Demo", Some("global"), &state_root).unwrap();
        assert!(!source.exists());
        assert!(!mods_root.join("Demo").exists());
    }

    #[test]
    fn disable_rejects_unmanaged_destination_entries() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            r"Skins\Demo",
            true,
            Some("global"),
            &temp.path().join("state"),
        )
        .unwrap();
        let destination = mods_root.join("Skins").join("Demo");
        fs::write(destination.join("preview.txt"), b"external").unwrap();

        assert!(set_mod_enabled_inner(
            &source,
            &mods_root,
            r"Skins\Demo",
            false,
            Some("global"),
            &temp.path().join("state"),
        )
        .is_err());
        assert!(destination.join("preview.txt").exists());
    }

    #[test]
    fn disabling_a_root_level_mod_keeps_the_canonical_mods_root() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &temp.path().join("state"),
        )
        .unwrap();
        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            false,
            Some("global"),
            &temp.path().join("state"),
        )
        .unwrap();

        assert!(mods_root.is_dir());
    }

    #[test]
    fn disabling_uses_the_enabled_snapshot_after_the_managed_source_is_updated() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &temp.path().join("state"),
        )
        .unwrap();
        fs::write(source.join("demo.pak"), b"version-two").unwrap();

        let disabled = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            false,
            Some("global"),
            &temp.path().join("state"),
        );
        assert!(disabled.is_ok());
        assert!(!mods_root.join("Demo").exists());
    }

    #[test]
    fn enabling_updates_an_existing_managed_deployment_from_its_manifest() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();
        fs::write(source.join("demo.pak"), b"version-two").unwrap();

        let updated = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        );
        assert!(updated.is_ok());
        assert_eq!(
            fs::read(mods_root.join("Demo").join("demo.pak")).unwrap(),
            b"version-two"
        );

        let disabled = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            false,
            Some("global"),
            &state_root,
        );
        assert!(disabled.is_ok());
    }

    #[test]
    fn updating_keeps_deferred_backup_cleanup_outside_the_game_scan_tree() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();
        fs::write(source.join("demo.pak"), b"version-two").unwrap();

        let relative = PathBuf::from("Demo");
        let destination = mods_root.join(&relative);
        let manifest_path = deployment_manifest_path(&state_root, &mods_root, &relative);
        let quarantine_root = deployment_quarantine_root(&mods_root).unwrap();
        let source_files = payload_entries(&source).unwrap();
        replace_deployed_payload_with_cleanup(
            &source_files,
            &destination,
            &manifest_path,
            &relative,
            &quarantine_root,
            None,
            |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected cleanup failure",
                ))
            },
        )
        .unwrap();

        assert_eq!(
            fs::read(destination.join("demo.pak")).unwrap(),
            b"version-two"
        );
        assert!(fs::read_dir(&mods_root)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().contains("imm-backup")));
        let deferred_backup = fs::read_dir(&quarantine_root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains("imm-backup"))
            })
            .expect("old deployment should remain outside the scan tree for deferred cleanup");
        assert_eq!(
            fs::read(deferred_backup.join("demo.pak")).unwrap(),
            b"version-one"
        );
        fs::remove_dir_all(quarantine_root).unwrap();
    }

    #[test]
    fn disabling_commits_after_atomic_quarantine_when_cleanup_is_deferred() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();

        let relative = PathBuf::from("Demo");
        let destination = mods_root.join(&relative);
        let manifest_path = deployment_manifest_path(&state_root, &mods_root, &relative);
        let quarantine_root = deployment_quarantine_root(&mods_root).unwrap();
        remove_deployed_payload_with_cleanup(
            &destination,
            &manifest_path,
            &quarantine_root,
            None,
            |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected cleanup failure",
                ))
            },
        )
        .unwrap();

        assert!(!destination.exists());
        assert!(!manifest_path.exists());
        let deferred_payload = fs::read_dir(&quarantine_root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains("imm-disable"))
            })
            .expect("disabled deployment should remain outside the scan tree for deferred cleanup");
        assert_eq!(
            fs::read(deferred_payload.join("demo.pak")).unwrap(),
            b"version-one"
        );
        fs::remove_dir_all(quarantine_root).unwrap();
    }

    #[test]
    fn enabling_refuses_to_replace_an_externally_modified_deployment() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();
        let deployed = mods_root.join("Demo").join("demo.pak");
        fs::write(&deployed, b"external-change").unwrap();
        fs::write(source.join("demo.pak"), b"version-two").unwrap();

        let updated = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        );
        assert!(updated.is_err());
        assert_eq!(fs::read(deployed).unwrap(), b"external-change");
    }

    #[test]
    fn corrupt_manifest_blocks_disable_without_deleting_the_deployment() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();
        let relative = PathBuf::from("Demo");
        let manifest_path = deployment_manifest_path(&state_root, &mods_root, &relative);
        fs::write(manifest_path, b"{").unwrap();

        let disabled = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            false,
            Some("global"),
            &state_root,
        );
        assert!(disabled.is_err());
        assert!(mods_root.join("Demo").exists());
    }

    #[test]
    fn missing_manifest_uses_the_legacy_source_check_conservatively() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();
        let relative = PathBuf::from("Demo");
        let manifest_path = deployment_manifest_path(&state_root, &mods_root, &relative);
        fs::remove_file(manifest_path).unwrap();
        fs::write(source.join("demo.pak"), b"version-two").unwrap();

        let disabled = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            false,
            Some("global"),
            &state_root,
        );
        assert!(disabled.is_err());
        assert_eq!(
            fs::read(mods_root.join("Demo").join("demo.pak")).unwrap(),
            b"version-one"
        );
    }

    #[test]
    fn deleting_moves_the_source_out_of_managed_state_and_removes_the_deployment() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();

        let deleted = delete_mod_inner(&source, &mods_root, "Demo", Some("global"), &state_root);
        assert!(deleted.is_ok(), "delete failed: {deleted:?}");
        assert!(!source.exists());
        assert!(!mods_root.join("Demo").exists());
    }

    #[test]
    fn public_delete_boundary_recovers_after_source_was_already_quarantined() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        let source_root = temp.path().join("library");
        let managed_root = source_root.join(MANAGED_SOURCE_DIR);
        let source = managed_root.join("Demo");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        fs::write(
            temp.path().join("configNTE.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "game": "NTE",
                "updatedAt": "before-delete",
                "sourceDir": source_root,
                "targetDir": mods_root,
                "nteRegion": "global",
                "data": { "Demo": { "note": "remove me" } },
                "presets": [
                    { "name": "affected", "data": ["Keep", "Demo"] },
                    { "name": "untouched", "data": ["Keep"] }
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let source = source.canonicalize().unwrap();
        set_mod_enabled_inner_with_library_root(NteTargetTransactionRequest {
            source_path: &source,
            trusted_library_root: &managed_root,
            mods_root: &mods_root,
            relative_path: "Demo",
            enabled: true,
            requested_region: Some("global"),
            deployment_state_root: &state_root,
            config_dir: Some(temp.path()),
            config_snapshot: None,
        })
        .unwrap();

        NTE_CLEANUP_TEST_FAIL.with(|fail| fail.set(true));
        let first = delete_mod_inner_with_cleanup(
            NteDeleteRequest {
                source_path: &source,
                trusted_library_root: &managed_root,
                mods_root: &mods_root,
                relative_path: "Demo",
                requested_region: Some("global"),
                deployment_state_root: &state_root,
                config_dir: Some(temp.path()),
                config_snapshot: None,
            },
            |_| Ok(()),
        );
        NTE_CLEANUP_TEST_FAIL.with(|fail| fail.set(false));
        assert!(first.is_err());
        assert!(!source.exists());
        let committed_after: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("configNTE.json")).unwrap()).unwrap();
        assert!(committed_after["data"].get("Demo").is_none());
        assert_eq!(
            committed_after["presets"][0]["data"],
            serde_json::json!(["Keep"])
        );
        assert_ne!(committed_after["updatedAt"], "before-delete");

        let source_quarantine = fs::read_dir(&managed_root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".imm-delete-"))
            })
            .expect("committed delete source quarantine must exist before cleanup");
        fs::remove_dir_all(source_quarantine).unwrap();

        let retried = delete_nte_mod_from_config(temp.path(), &state_root, "Demo").unwrap();
        assert_eq!(retried.message, "NTE Mod was already deleted.");
        assert_eq!(
            retried.config_revision.as_deref(),
            committed_after["updatedAt"].as_str()
        );
        let mut journal = crate::nte_wal::WalJournal::open(&target_wal_path(&root)).unwrap();
        assert!(journal.incomplete_transaction().unwrap().is_none());
    }

    fn configured_enabled_delete_fixture() -> (
        tempfile::TempDir,
        PathBuf,
        PathBuf,
        PathBuf,
        PathBuf,
        PathBuf,
    ) {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        let source_root = temp.path().join("library");
        let managed_root = source_root.join(MANAGED_SOURCE_DIR);
        let source = managed_root.join("Demo");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        fs::write(
            temp.path().join("configNTE.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "game": "NTE",
                "updatedAt": "before-delete",
                "sourceDir": source_root,
                "targetDir": mods_root,
                "nteRegion": "global",
                "data": { "Demo": { "note": "remove me" } },
                "presets": [{ "data": ["Demo", "Keep"] }]
            }))
            .unwrap(),
        )
        .unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let source = source.canonicalize().unwrap();
        let trusted = trusted_nte_paths_from_config(temp.path(), "Demo").unwrap();
        set_mod_enabled_inner_with_library_root(NteTargetTransactionRequest {
            source_path: &source,
            trusted_library_root: &managed_root,
            mods_root: &mods_root,
            relative_path: "Demo",
            enabled: true,
            requested_region: Some("global"),
            deployment_state_root: &state_root,
            config_dir: Some(temp.path()),
            config_snapshot: Some(&trusted.config_snapshot),
        })
        .unwrap();
        (temp, root, managed_root, source, mods_root, state_root)
    }

    #[test]
    fn committed_delete_retries_config_cleanup_before_terminal_cleanup() {
        let (temp, root, managed_root, source, mods_root, state_root) =
            configured_enabled_delete_fixture();
        let trusted = trusted_nte_paths_from_config(temp.path(), "Demo").unwrap();
        NTE_CONFIG_CLEANUP_TEST_FAIL.with(|fail| fail.set(true));
        let first = delete_mod_inner_with_cleanup(
            NteDeleteRequest {
                source_path: &source,
                trusted_library_root: &managed_root,
                mods_root: &mods_root,
                relative_path: "Demo",
                requested_region: Some("global"),
                deployment_state_root: &state_root,
                config_dir: Some(temp.path()),
                config_snapshot: Some(&trusted.config_snapshot),
            },
            |_| Ok(()),
        );
        NTE_CONFIG_CLEANUP_TEST_FAIL.with(|fail| fail.set(false));
        assert!(first.unwrap_err().contains("configuration cleanup failure"));
        assert!(!source.exists());
        let before_retry: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("configNTE.json")).unwrap()).unwrap();
        assert_eq!(before_retry["updatedAt"], "before-delete");
        assert!(before_retry["data"].get("Demo").is_some());
        let mut journal = crate::nte_wal::WalJournal::open(&target_wal_path(&root)).unwrap();
        assert_eq!(
            journal.incomplete_transaction().unwrap().unwrap().state,
            crate::nte_wal::WalState::CommittedAfter
        );
        drop(journal);

        let recovered = delete_nte_mod_from_config(temp.path(), &state_root, "Demo").unwrap();
        let after_retry: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("configNTE.json")).unwrap()).unwrap();
        assert!(after_retry["data"].get("Demo").is_none());
        assert_eq!(
            after_retry["presets"][0]["data"],
            serde_json::json!(["Keep"])
        );
        assert_eq!(
            recovered.config_revision.as_deref(),
            after_retry["updatedAt"].as_str()
        );
    }

    #[test]
    fn standalone_config_save_recovers_active_delete_wal_before_cas() {
        let (temp, root, _, _, _, state_root) = configured_enabled_delete_fixture();
        NTE_CONFIG_CLEANUP_TEST_FAIL.with(|fail| fail.set(true));
        let interrupted = delete_nte_mod_from_config(temp.path(), &state_root, "Demo");
        NTE_CONFIG_CLEANUP_TEST_FAIL.with(|fail| fail.set(false));
        assert!(interrupted
            .unwrap_err()
            .contains("configuration cleanup failure"));

        let mut stale: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("configNTE.json")).unwrap()).unwrap();
        assert_eq!(stale["updatedAt"], "before-delete");
        stale["updatedAt"] = serde_json::Value::String("standalone-save".to_string());
        stale["notice"] = serde_json::Value::Number(1.into());
        let save = save_nte_config_from_dir(
            temp.path(),
            &state_root,
            &stale.to_string(),
            Some("before-delete"),
        );
        assert!(save
            .unwrap_err()
            .contains("changed while this update was pending"));

        let recovered: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("configNTE.json")).unwrap()).unwrap();
        assert!(recovered["data"].get("Demo").is_none());
        assert_eq!(recovered["presets"][0]["data"], serde_json::json!(["Keep"]));
        assert_ne!(recovered["updatedAt"], "standalone-save");
        let mut journal = crate::nte_wal::WalJournal::open(&target_wal_path(&root)).unwrap();
        assert!(journal.incomplete_transaction().unwrap().is_none());
    }

    #[test]
    fn config_save_only_uses_config_only_mode_for_initial_empty_roots() {
        let temp = tempdir().unwrap();
        let config_path = temp.path().join("configNTE.json");
        let initial = serde_json::json!({
            "game": "NTE",
            "updatedAt": 0,
            "sourceDir": "",
            "targetDir": "",
            "nteRegion": "auto",
            "data": {},
            "presets": []
        });
        fs::write(&config_path, initial.to_string()).unwrap();
        let mut next = initial.clone();
        next["updatedAt"] = serde_json::Value::String("initial-save".to_string());
        assert_eq!(
            save_nte_config_from_dir(
                temp.path(),
                &temp.path().join("state"),
                &next.to_string(),
                Some("0"),
            )
            .unwrap(),
            "initial-save"
        );

        let unavailable = serde_json::json!({
            "game": "NTE",
            "updatedAt": "unavailable",
            "sourceDir": temp.path().join("missing-library"),
            "targetDir": temp.path().join("missing-target"),
            "nteRegion": "global",
            "data": {},
            "presets": []
        });
        fs::write(&config_path, unavailable.to_string()).unwrap();
        let mut replacement = unavailable.clone();
        replacement["updatedAt"] = serde_json::Value::String("must-not-save".to_string());
        replacement["sourceDir"] = serde_json::Value::String(String::new());
        replacement["targetDir"] = serde_json::Value::String(String::new());
        let error = save_nte_config_from_dir(
            temp.path(),
            &temp.path().join("state"),
            &replacement.to_string(),
            Some("unavailable"),
        )
        .unwrap_err();
        assert!(error.contains("missing or unsafe"));
        let unchanged: serde_json::Value =
            serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
        assert_eq!(unchanged["updatedAt"], "unavailable");
    }

    #[test]
    fn delete_recovers_physical_commit_before_wal_terminal_and_cleans_config() {
        let (temp, _, _, source, _, state_root) = configured_enabled_delete_fixture();
        inject_process_pause_at(Some("delete_source_quarantined"));
        let paused = delete_nte_mod_from_config(temp.path(), &state_root, "Demo");
        inject_process_pause_at(None);
        assert!(paused.unwrap_err().contains("is running"));
        assert!(!source.exists());
        let before_retry: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("configNTE.json")).unwrap()).unwrap();
        assert_eq!(before_retry["updatedAt"], "before-delete");
        assert!(before_retry["data"].get("Demo").is_some());

        let recovered = delete_nte_mod_from_config(temp.path(), &state_root, "Demo").unwrap();
        let after_retry: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join("configNTE.json")).unwrap()).unwrap();
        assert!(after_retry["data"].get("Demo").is_none());
        assert_eq!(
            after_retry["presets"][0]["data"],
            serde_json::json!(["Keep"])
        );
        assert_eq!(
            recovered.config_revision.as_deref(),
            after_retry["updatedAt"].as_str()
        );
    }

    #[cfg(windows)]
    #[test]
    fn committed_delete_cleanup_is_retried_from_the_wal() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let state_root = temp.path().join("state");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"version-one").unwrap();

        set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &state_root,
        )
        .unwrap();

        NTE_CLEANUP_TEST_FAIL.with(|fail| fail.set(true));
        let deleted = delete_mod_inner_with_cleanup(
            NteDeleteRequest {
                source_path: &source,
                trusted_library_root: temp.path(),
                mods_root: &mods_root,
                relative_path: "Demo",
                requested_region: Some("global"),
                deployment_state_root: &state_root,
                config_dir: None,
                config_snapshot: None,
            },
            |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected cleanup failure",
                ))
            },
        );
        NTE_CLEANUP_TEST_FAIL.with(|fail| fail.set(false));
        assert!(deleted.is_err());
        assert!(
            !source.exists(),
            "source remained after injected cleanup failure: {deleted:?}"
        );
        assert!(!mods_root.join("Demo").exists());

        let quarantine = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".imm-delete-"))
            })
            .expect("committed quarantine must remain until cleanup succeeds");
        let mut journal = crate::nte_wal::WalJournal::open(&target_wal_path(&root)).unwrap();
        assert_eq!(
            journal.incomplete_transaction().unwrap().unwrap().state,
            crate::nte_wal::WalState::CommittedAfter
        );
        drop(journal);

        let retried =
            delete_mod_inner(&source, &mods_root, "Demo", Some("global"), &state_root).unwrap();
        assert_eq!(retried.message, "NTE Mod was already deleted.");
        assert!(!quarantine.exists());
        let mut journal = crate::nte_wal::WalJournal::open(&target_wal_path(&root)).unwrap();
        assert!(journal.incomplete_transaction().unwrap().is_none());
    }

    #[test]
    fn validating_a_mods_root_detects_a_stale_game_installation() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);

        let valid = validate_mods_root(&mods_root, Some("global"));
        assert!(valid.valid);

        fs::remove_file(root.join(NteRegion::Global.launcher())).unwrap();
        let stale = validate_mods_root(&mods_root, Some("global"));
        assert!(!stale.valid);
    }

    #[cfg(windows)]
    #[test]
    fn enabling_rejects_a_junction_inside_the_source_payload() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let source = temp.path().join("source");
        let external = temp.path().join("external");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();
        fs::write(external.join("demo.utoc"), b"utoc").unwrap();
        create_junction(&external, &source.join("linked"));

        let result = set_mod_enabled_inner(
            &source,
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &temp.path().join("state"),
        );

        assert!(result.is_err());
        assert!(!mods_root.join("Demo").exists());
    }

    #[cfg(windows)]
    #[test]
    fn enabling_rejects_a_source_reached_through_a_parent_junction() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("game");
        fs::create_dir_all(&root).unwrap();
        create_shared_layout(&root);
        create_region_layout(&root, NteRegion::Global);
        let mods_root = join_components(&root, MODS_COMPONENTS);
        let real_parent = temp.path().join("real-parent");
        let source = real_parent.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("demo.pak"), b"pak").unwrap();
        let parent_junction = temp.path().join("parent-junction");
        create_junction(&real_parent, &parent_junction);

        let result = set_mod_enabled_inner(
            &parent_junction.join("source"),
            &mods_root,
            "Demo",
            true,
            Some("global"),
            &temp.path().join("state"),
        );

        assert!(result.is_err());
        assert!(!mods_root.join("Demo").exists());
    }
}

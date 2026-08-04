use fd_lock::RwLock as FileRwLock;
use once_cell::sync::Lazy;
use std::fs::{self, OpenOptions};
use std::path::Path;
use std::sync::Mutex;

use crate::nte_wal::WalJournal;

const MUTATION_DIRECTORY_NAME: &str = "mod-mutations";
const GLOBAL_LOCK_NAME: &str = "mod-mutation.lock";
const GLOBAL_WAL_NAME: &str = "mod-mutation.wal";
const LIBRARY_LOCK_NAME: &str = ".imm-mod-mutation.lock";
const LIBRARY_WAL_NAME: &str = ".imm-mod-mutation.wal";
static MOD_MUTATION_PROCESS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn ensure_safe_directory(path: &Path, label: &str) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|err| format!("Unable to create the {label} directory: {err}"))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Unable to inspect the {label} directory: {err}"))?;
    if !metadata.is_dir() || metadata_is_reparse(&metadata) {
        return Err(format!("The {label} directory is unsafe."));
    }
    Ok(())
}

fn open_lock(path: &Path, label: &str) -> Result<FileRwLock<std::fs::File>, String> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|err| format!("Unable to open the {label} lock: {err}"))?;
    let metadata = file
        .metadata()
        .map_err(|err| format!("Unable to inspect the {label} lock: {err}"))?;
    if !metadata.is_file() || metadata_is_reparse(&metadata) {
        return Err(format!("The {label} lock is not a safe regular file."));
    }
    Ok(FileRwLock::new(file))
}

pub(crate) fn with_global_lock<T>(
    control_root: &Path,
    operation: impl FnOnce(&mut WalJournal) -> Result<T, String>,
) -> Result<T, String> {
    let _process_guard = MOD_MUTATION_PROCESS_LOCK
        .lock()
        .map_err(|_| "Mod mutation process lock is poisoned.".to_string())?;
    let directory = control_root.join(MUTATION_DIRECTORY_NAME);
    ensure_safe_directory(control_root, "application control root")?;
    ensure_safe_directory(&directory, "Mod mutation registry")?;
    let mut lock = open_lock(&directory.join(GLOBAL_LOCK_NAME), "global Mod mutation")?;
    let _guard = lock
        .write()
        .map_err(|err| format!("Unable to acquire the global Mod mutation lock: {err}"))?;
    let mut journal = WalJournal::open_mod_mutation(&directory.join(GLOBAL_WAL_NAME))?;
    operation(&mut journal)
}

pub(crate) fn with_library_lock<T>(
    trusted_root: &Path,
    operation: impl FnOnce(&mut WalJournal) -> Result<T, String>,
) -> Result<T, String> {
    ensure_safe_directory(trusted_root, "managed Mod root")?;
    let mut lock = open_lock(&trusted_root.join(LIBRARY_LOCK_NAME), "managed Mod root")?;
    let _guard = lock
        .write()
        .map_err(|err| format!("Unable to acquire the managed Mod root lock: {err}"))?;
    let mut journal = WalJournal::open_mod_mutation(&trusted_root.join(LIBRARY_WAL_NAME))?;
    operation(&mut journal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nte_wal::WalState;
    use tempfile::tempdir;

    #[test]
    fn global_and_library_locks_keep_separate_mutation_journals() {
        let temp = tempdir().expect("tempdir");
        let control = temp.path().join("control");
        let library = temp.path().join("library");
        fs::create_dir_all(&control).expect("control");
        fs::create_dir_all(&library).expect("library");

        with_global_lock(&control, |journal| {
            let transaction = journal.begin(b"global")?;
            journal.append(transaction, WalState::Committing, b"{}")?;
            journal.append(transaction, WalState::CommittedAfter, b"{}")?;
            journal.append(transaction, WalState::CleanupComplete, b"{}")
        })
        .expect("global transaction");
        with_library_lock(&library, |journal| {
            let transaction = journal.begin(b"library")?;
            journal.append(transaction, WalState::Committing, b"{}")?;
            journal.append(transaction, WalState::AbortedBefore, b"{}")?;
            journal.append(transaction, WalState::CleanupComplete, b"{}")
        })
        .expect("library transaction");

        assert!(control
            .join(MUTATION_DIRECTORY_NAME)
            .join(GLOBAL_WAL_NAME)
            .is_file());
        assert!(library.join(LIBRARY_WAL_NAME).is_file());
    }
}

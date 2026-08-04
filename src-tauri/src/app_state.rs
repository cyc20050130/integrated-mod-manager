#[cfg(not(windows))]
use atomic_write_file::AtomicWriteFile;
use fd_lock::RwLock as FileRwLock;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::nte_wal::{WalJournal, WalState};

const STATE_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LOCAL_STORAGE_BYTES: u64 = 64 * 1024;
const MAX_STATE_BYTES: u64 = 64 * 1024 * 1024;
const GLOBAL_CONFIG_NAME: &str = "config.json";
const LOCAL_STORAGE_ARTIFACT: &str = "webview/local-storage.json";
const SUPPORTED_GAMES: &[&str] = &["WW", "ZZ", "GI", "SR", "EF", "NTE"];
const REQUIRED_LOCAL_STORAGE_KEYS: &[&str] = &["game-theme", "imm-lang"];
static STATE_REVISION_COUNTER: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static STATE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static APP_STATE_PROCESS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum BootstrapStatus {
    Ready {
        revision: String,
        runtime_root: String,
        migrated_from_snapshot: Option<String>,
    },
    RecoveryRequired {
        error: String,
        control_root: String,
        snapshot_candidates: Vec<String>,
    },
    Pending,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppConfigSnapshot {
    state_revision: String,
    global_revision: u64,
    pub(crate) game_revision: Option<u64>,
    global: Value,
    pub(crate) game: Option<Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct GameConfigMutationPreflight {
    pub(crate) before_game_config_hash: String,
    pub(crate) after_game_config_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GenerationPointer {
    generation: String,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeRevisions {
    global: u64,
    games: BTreeMap<String, u64>,
    webview: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationRecord {
    source_kind: String,
    snapshot_id: Option<String>,
    imported_at_utc: String,
    imported_artifacts: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppStateDocument {
    schema_version: u32,
    revision: String,
    scope_revisions: ScopeRevisions,
    global: Value,
    games: BTreeMap<String, Value>,
    webview: BTreeMap<String, String>,
    migration: MigrationRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateTransactionPlan {
    before: Option<GenerationPointer>,
    after: GenerationPointer,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetBackupManifest {
    schema_version: u32,
    created_at_utc: String,
    reason: String,
    generation: String,
    sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyBackupManifest {
    schema_version: u32,
    backup_id: String,
    created_at_utc: String,
    reason: String,
    files: BTreeMap<String, String>,
}

#[derive(Debug)]
struct LegacyBackup {
    id: String,
    files: BTreeMap<String, Vec<u8>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    schema_version: u32,
    snapshot_id: String,
    files: Vec<SnapshotFileEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFileEntry {
    artifact_path: String,
    kind: String,
    length: u64,
    sha256: String,
    relative_source_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalStorageSnapshot {
    schema_version: u32,
    records: BTreeMap<String, LocalStorageRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalStorageRecord {
    value: String,
}

#[derive(Debug)]
struct RepositoryPaths {
    control_root: PathBuf,
    legacy_data_root: PathBuf,
    state_root: PathBuf,
    generations_root: PathBuf,
    reset_backups_root: PathBuf,
    legacy_backups_root: PathBuf,
    runtime_root: PathBuf,
    reports_root: PathBuf,
    current_pointer: PathBuf,
    previous_pointer: PathBuf,
    wal_path: PathBuf,
    lock_path: PathBuf,
}

impl RepositoryPaths {
    fn new(control_root: PathBuf, legacy_data_root: PathBuf) -> Self {
        let state_root = control_root.join("state");
        Self {
            generations_root: state_root.join("generations"),
            reset_backups_root: state_root.join("reset-backups"),
            legacy_backups_root: state_root.join("legacy-backups"),
            runtime_root: control_root.join("runtime"),
            reports_root: control_root.join("migration"),
            current_pointer: state_root.join("current.json"),
            previous_pointer: state_root.join("previous.json"),
            wal_path: state_root.join("app-state.wal"),
            lock_path: state_root.join("app-state.lock"),
            control_root,
            legacy_data_root,
            state_root,
        }
    }
}

#[derive(Debug)]
struct RepositoryInner {
    status: BootstrapStatus,
}

pub(crate) struct AppStateRepository {
    paths: RepositoryPaths,
    allow_fresh_defaults: bool,
    initialization_error: Option<String>,
    inner: Mutex<RepositoryInner>,
}

impl AppStateRepository {
    pub(crate) fn from_environment() -> Result<Self, String> {
        if cfg!(debug_assertions) {
            let current = std::env::current_dir()
                .map_err(|err| format!("Unable to resolve the development root: {err}"))?;
            return Ok(Self::new(
                current
                    .join("src-tauri")
                    .join("target")
                    .join("imm-dev-state"),
                current,
                true,
            ));
        }

        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| {
                "LOCALAPPDATA is unavailable; application state cannot be located.".to_string()
            })?;
        Ok(Self::new(
            local_app_data.join("Integrated Mod Manager (IMM) State"),
            local_app_data.join("Integrated Mod Manager (IMM) Data"),
            true,
        ))
    }

    pub(crate) fn new(
        control_root: PathBuf,
        legacy_data_root: PathBuf,
        allow_fresh_defaults: bool,
    ) -> Self {
        Self {
            paths: RepositoryPaths::new(control_root, legacy_data_root),
            allow_fresh_defaults,
            initialization_error: None,
            inner: Mutex::new(RepositoryInner {
                status: BootstrapStatus::Pending,
            }),
        }
    }

    pub(crate) fn unavailable(error: String) -> Self {
        let status = BootstrapStatus::RecoveryRequired {
            error: error.clone(),
            control_root: String::new(),
            snapshot_candidates: Vec::new(),
        };
        Self {
            paths: RepositoryPaths::new(PathBuf::new(), PathBuf::new()),
            allow_fresh_defaults: false,
            initialization_error: Some(error),
            inner: Mutex::new(RepositoryInner { status }),
        }
    }

    pub(crate) fn bootstrap(&self) -> BootstrapStatus {
        let result = self
            .initialization_error
            .as_ref()
            .map_or_else(|| self.bootstrap_locked(), |error| Err(error.clone()));
        let status = match result {
            Ok(state) => BootstrapStatus::Ready {
                revision: state.revision.clone(),
                runtime_root: self.paths.runtime_root.to_string_lossy().into_owned(),
                migrated_from_snapshot: state.migration.snapshot_id.clone(),
            },
            Err(error) => BootstrapStatus::RecoveryRequired {
                error,
                control_root: self.paths.control_root.to_string_lossy().into_owned(),
                snapshot_candidates: snapshot_candidate_names(&self.paths.control_root),
            },
        };
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = status.clone();
        }
        status
    }

    pub(crate) fn status(&self) -> BootstrapStatus {
        self.inner
            .lock()
            .map(|inner| inner.status.clone())
            .unwrap_or_else(|_| BootstrapStatus::RecoveryRequired {
                error: "Application state status lock is poisoned.".to_string(),
                control_root: self.paths.control_root.to_string_lossy().into_owned(),
                snapshot_candidates: Vec::new(),
            })
    }

    pub(crate) fn runtime_root(&self) -> &Path {
        &self.paths.runtime_root
    }

    pub(crate) fn control_root(&self) -> &Path {
        &self.paths.control_root
    }

    pub(crate) fn load_config(&self, game: Option<&str>) -> Result<AppConfigSnapshot, String> {
        self.require_ready()?;
        validate_requested_game(game)?;
        let _process_guard = APP_STATE_PROCESS_LOCK
            .lock()
            .map_err(|_| "Application state process lock is poisoned.".to_string())?;
        let mut file_lock = open_repository_lock(&self.paths.lock_path)?;
        let _file_guard = file_lock
            .try_write()
            .map_err(|err| format!("Unable to lock application state for reading: {err}"))?;
        let mut journal = WalJournal::open_app_state(&self.paths.wal_path)?;
        recover_incomplete_transaction(&self.paths, &mut journal)?;
        let pointer = read_pointer_optional(&self.paths.current_pointer)?
            .ok_or_else(|| "Application state has no current generation.".to_string())?;
        let state = read_generation(&self.paths, &pointer)?;
        config_snapshot(&state, game)
    }

    pub(crate) fn load_game_value(&self, game: &str) -> Result<Value, String> {
        self.load_config(Some(game))?
            .game
            .ok_or_else(|| format!("Application state is missing {game}."))
    }

    pub(crate) fn load_global_value(&self) -> Result<Value, String> {
        Ok(self.load_config(None)?.global)
    }

    pub(crate) fn preflight_game_config_update(
        &self,
        game: &str,
        next_game: &Value,
        expected_game_revision: u64,
    ) -> Result<GameConfigMutationPreflight, String> {
        validate_requested_game(Some(game))?;
        validate_game_config(next_game, game)?;
        let snapshot = self.load_config(Some(game))?;
        if snapshot.game_revision != Some(expected_game_revision) {
            return Err(format!(
                "{game} configuration changed while this Mod mutation was pending."
            ));
        }
        let current_game = snapshot
            .game
            .ok_or_else(|| format!("Application state is missing {game}."))?;
        Ok(GameConfigMutationPreflight {
            before_game_config_hash: stable_json_value_hash(&current_game)?,
            after_game_config_hash: stable_json_value_hash(next_game)?,
        })
    }

    pub(crate) fn save_config(
        &self,
        global: Option<Value>,
        game: Option<Value>,
        expected_global_revision: Option<u64>,
        expected_game_revision: Option<u64>,
    ) -> Result<AppConfigSnapshot, String> {
        crate::mod_mutation::with_global_lock(&self.paths.control_root, |registry| {
            crate::recover_generic_mod_mutation_registry(&self.paths.runtime_root, registry)?;
            self.save_config_for_mod_mutation(
                global,
                game,
                expected_global_revision,
                expected_game_revision,
            )
        })
    }

    pub(crate) fn save_config_for_mod_mutation(
        &self,
        global: Option<Value>,
        game: Option<Value>,
        expected_global_revision: Option<u64>,
        expected_game_revision: Option<u64>,
    ) -> Result<AppConfigSnapshot, String> {
        self.require_ready()?;
        if global.is_none() && game.is_none() {
            return Err("Application config save contains no changes.".to_string());
        }
        let requested_game = game
            .as_ref()
            .and_then(|value| value.get("game"))
            .and_then(Value::as_str)
            .map(str::to_string);
        validate_requested_game(requested_game.as_deref())?;
        if let Some(global) = &global {
            validate_global_config(global)?;
        }
        if let (Some(game), Some(game_name)) = (&game, requested_game.as_deref()) {
            validate_game_config(game, game_name)?;
        } else if game.is_some() {
            return Err("Game config save has no game identity.".to_string());
        }

        let _process_guard = APP_STATE_PROCESS_LOCK
            .lock()
            .map_err(|_| "Application state process lock is poisoned.".to_string())?;
        let mut file_lock = open_repository_lock(&self.paths.lock_path)?;
        let _file_guard = file_lock
            .try_write()
            .map_err(|err| format!("Unable to lock application state for saving: {err}"))?;
        let mut journal = WalJournal::open_app_state(&self.paths.wal_path)?;
        recover_incomplete_transaction(&self.paths, &mut journal)?;
        let pointer = read_pointer_optional(&self.paths.current_pointer)?
            .ok_or_else(|| "Application state has no current generation.".to_string())?;
        let mut state = read_generation(&self.paths, &pointer)?;

        if global.is_some() && expected_global_revision != Some(state.scope_revisions.global) {
            return Err("Global configuration changed while this update was pending.".to_string());
        }
        if let Some(game_name) = requested_game.as_deref() {
            let current = state
                .scope_revisions
                .games
                .get(game_name)
                .copied()
                .ok_or_else(|| format!("Missing {game_name} configuration revision."))?;
            if expected_game_revision != Some(current) {
                return Err(format!(
                    "{game_name} configuration changed while this update was pending."
                ));
            }
        }

        if let Some(global) = global {
            state.global = global;
            state.scope_revisions.global = state
                .scope_revisions
                .global
                .checked_add(1)
                .ok_or_else(|| "Global configuration revision overflow.".to_string())?;
        }
        if let (Some(game), Some(game_name)) = (game, requested_game.as_deref()) {
            state.games.insert(game_name.to_string(), game);
            let revision = state
                .scope_revisions
                .games
                .get_mut(game_name)
                .ok_or_else(|| format!("Missing {game_name} configuration revision."))?;
            *revision = revision
                .checked_add(1)
                .ok_or_else(|| format!("{game_name} configuration revision overflow."))?;
        }
        state.revision = next_revision()?;
        let committed = commit_state(&self.paths, &mut journal, state)?;
        self.set_ready_status(&committed);
        config_snapshot(&committed, requested_game.as_deref())
    }

    pub(crate) fn reset_with_backup(&self) -> Result<AppConfigSnapshot, String> {
        crate::mod_mutation::with_global_lock(&self.paths.control_root, |registry| {
            crate::recover_generic_mod_mutation_registry(&self.paths.runtime_root, registry)?;
            self.reset_with_backup_locked()
        })
    }

    fn reset_with_backup_locked(&self) -> Result<AppConfigSnapshot, String> {
        if let Some(error) = &self.initialization_error {
            return Err(format!(
                "Application state cannot be reset because its storage is unavailable: {error}"
            ));
        }
        let _process_guard = APP_STATE_PROCESS_LOCK
            .lock()
            .map_err(|_| "Application state process lock is poisoned.".to_string())?;
        self.prepare_control_layout()?;
        let mut file_lock = open_repository_lock(&self.paths.lock_path)?;
        let _file_guard = file_lock
            .try_write()
            .map_err(|err| format!("Unable to lock application state for reset: {err}"))?;
        let mut journal = WalJournal::open_app_state(&self.paths.wal_path)?;
        recover_incomplete_transaction(&self.paths, &mut journal)?;
        let before = read_pointer_optional(&self.paths.current_pointer)?;
        if let Some(pointer) = &before {
            read_generation(&self.paths, pointer)?;
        }

        let mut reset_state = fresh_default_state()?;
        reset_state.migration.source_kind = "user-reset".to_string();
        reset_state.migration.snapshot_id = if before.is_none() {
            backup_legacy_configs(&self.paths, "recovery-reset")?
        } else {
            None
        };
        reset_state.migration.imported_at_utc = utc_timestamp()?;
        if let Some(before) = before {
            reset_state.migration.imported_artifacts = BTreeMap::from([(
                "resetBackupGeneration".to_string(),
                before.generation.clone(),
            )]);
            let backup = ResetBackupManifest {
                schema_version: 1,
                created_at_utc: reset_state.migration.imported_at_utc.clone(),
                reason: "user-requested-reset".to_string(),
                generation: before.generation,
                sha256: before.sha256,
            };
            let backup_path = self
                .paths
                .reset_backups_root
                .join(format!("{}.json", reset_state.revision));
            atomic_write(&backup_path, &serialize_pretty(&backup)?)?;
        }

        let committed = commit_state(&self.paths, &mut journal, reset_state)?;
        self.set_ready_status(&committed);
        config_snapshot(&committed, None)
    }

    pub(crate) fn coordinate_runtime_game_mutation<T>(
        &self,
        game: &str,
        operation: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        crate::mod_mutation::with_global_lock(&self.paths.control_root, |registry| {
            crate::recover_generic_mod_mutation_registry(&self.paths.runtime_root, registry)?;
            self.coordinate_runtime_game_mutation_locked(game, operation)
        })
    }

    fn coordinate_runtime_game_mutation_locked<T>(
        &self,
        game: &str,
        operation: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        self.require_ready()?;
        validate_requested_game(Some(game))?;
        let _process_guard = APP_STATE_PROCESS_LOCK
            .lock()
            .map_err(|_| "Application state process lock is poisoned.".to_string())?;
        let mut file_lock = open_repository_lock(&self.paths.lock_path)?;
        let _file_guard = file_lock
            .try_write()
            .map_err(|err| format!("Unable to lock application state for mutation: {err}"))?;
        let mut journal = WalJournal::open_app_state(&self.paths.wal_path)?;
        recover_incomplete_transaction(&self.paths, &mut journal)?;
        let pointer = read_pointer_optional(&self.paths.current_pointer)?
            .ok_or_else(|| "Application state has no current generation.".to_string())?;
        let mut state = read_generation(&self.paths, &pointer)?;
        ensure_runtime_projection_consistent(&self.paths, &state)?;

        let operation_result = operation(&self.paths.runtime_root);
        let projected = read_runtime_game_config(&self.paths, game)?;
        let current = state
            .games
            .get(game)
            .ok_or_else(|| format!("Application state is missing {game}."))?;
        if &projected != current {
            state.games.insert(game.to_string(), projected);
            let revision = state
                .scope_revisions
                .games
                .get_mut(game)
                .ok_or_else(|| format!("Missing {game} configuration revision."))?;
            *revision = revision
                .checked_add(1)
                .ok_or_else(|| format!("{game} configuration revision overflow."))?;
            state.revision = next_revision()?;
            let committed = commit_state(&self.paths, &mut journal, state)?;
            self.set_ready_status(&committed);
        }
        operation_result
    }

    fn require_ready(&self) -> Result<(), String> {
        match self.status() {
            BootstrapStatus::Ready { .. } => Ok(()),
            BootstrapStatus::RecoveryRequired { error, .. } => Err(format!(
                "Application state recovery is required before this operation: {error}"
            )),
            BootstrapStatus::Pending => {
                Err("Application state bootstrap is still pending.".to_string())
            }
        }
    }

    fn set_ready_status(&self, state: &AppStateDocument) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = BootstrapStatus::Ready {
                revision: state.revision.clone(),
                runtime_root: self.paths.runtime_root.to_string_lossy().into_owned(),
                migrated_from_snapshot: state.migration.snapshot_id.clone(),
            };
        }
    }

    fn bootstrap_locked(&self) -> Result<AppStateDocument, String> {
        let _process_guard = APP_STATE_PROCESS_LOCK
            .lock()
            .map_err(|_| "Application state process lock is poisoned.".to_string())?;
        self.prepare_control_layout()?;
        let mut file_lock = open_repository_lock(&self.paths.lock_path)?;
        let _file_guard = file_lock.try_write().map_err(|err| {
            if err.kind() == std::io::ErrorKind::WouldBlock {
                "Another IMM process is changing application state.".to_string()
            } else {
                format!("Unable to acquire the application state file lock: {err}")
            }
        })?;

        let mut journal = WalJournal::open_app_state(&self.paths.wal_path)?;
        recover_incomplete_transaction(&self.paths, &mut journal)?;

        let state = match read_pointer_optional(&self.paths.current_pointer)? {
            Some(pointer) => read_generation(&self.paths, &pointer)?,
            None => {
                let state = self.import_initial_state()?;
                commit_state(&self.paths, &mut journal, state)?
            }
        };
        validate_state_document(&state)?;
        ensure_runtime_projection_consistent(&self.paths, &state)?;
        write_runtime_projection(&self.paths, &state)?;
        write_migration_report(&self.paths, &state)?;
        Ok(state)
    }

    fn prepare_control_layout(&self) -> Result<(), String> {
        for path in [
            &self.paths.control_root,
            &self.paths.state_root,
            &self.paths.generations_root,
            &self.paths.reset_backups_root,
            &self.paths.legacy_backups_root,
            &self.paths.runtime_root,
            &self.paths.reports_root,
        ] {
            fs::create_dir_all(path).map_err(|err| {
                format!(
                    "Unable to create state directory '{}': {err}",
                    path.display()
                )
            })?;
            ensure_directory_without_reparse(path)?;
        }
        Ok(())
    }

    fn import_initial_state(&self) -> Result<AppStateDocument, String> {
        let candidates = snapshot_candidates(&self.paths.control_root)?;
        if let Some(snapshot) = candidates.last() {
            return import_snapshot(snapshot);
        }
        if legacy_configs_exist(&self.paths.legacy_data_root) {
            return import_legacy_state(&self.paths);
        }
        if self.allow_fresh_defaults && !legacy_configs_exist(&self.paths.legacy_data_root) {
            return fresh_default_state();
        }
        Err("No verified migration snapshot is available for existing legacy configuration. Open the recovery center and create or select a snapshot.".to_string())
    }
}

pub(crate) fn stable_json_value_hash(value: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|err| format!("Unable to serialize JSON value for hashing: {err}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn open_repository_lock(path: &Path) -> Result<FileRwLock<File>, String> {
    ensure_safe_file_if_present(path, "application state lock")?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|err| format!("Unable to open the application state lock: {err}"))?;
    if !file
        .metadata()
        .map_err(|err| format!("Unable to inspect the application state lock: {err}"))?
        .is_file()
    {
        return Err("Application state lock is not a regular file.".to_string());
    }
    Ok(FileRwLock::new(file))
}

fn ensure_directory_without_reparse(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Unable to inspect directory '{}': {err}", path.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) {
        return Err(format!("State directory is unsafe: {}", path.display()));
    }
    Ok(())
}

fn ensure_safe_file_if_present(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata_is_reparse(&metadata) =>
        {
            Err(format!("The {label} is not a safe regular file."))
        }
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Unable to inspect the {label}: {err}")),
    }
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

fn read_bounded(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>, String> {
    ensure_safe_file_if_present(path, label)?;
    let mut file = File::open(path).map_err(|err| format!("Unable to open the {label}: {err}"))?;
    let length = file
        .metadata()
        .map_err(|err| format!("Unable to inspect the {label}: {err}"))?
        .len();
    if length > max_bytes {
        return Err(format!("The {label} exceeds the {max_bytes} byte limit."));
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.read_to_end(&mut bytes)
        .map_err(|err| format!("Unable to read the {label}: {err}"))?;
    Ok(bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:X}", Sha256::digest(bytes))
}

fn next_revision() -> Result<String, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock cannot create a state revision: {err}"))?
        .as_nanos();
    let counter = STATE_REVISION_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(format!(
        "state-{timestamp}-{}-{counter}",
        std::process::id()
    ))
}

fn utc_timestamp() -> Result<String, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock cannot create a migration timestamp: {err}"))?
        .as_millis();
    Ok(format!("unix-ms-{millis}"))
}

fn serialize_pretty<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("Unable to serialize application state: {err}"))?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(not(windows))]
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut output = AtomicWriteFile::open(path)
        .map_err(|err| format!("Unable to stage '{}': {err}", path.display()))?;
    output
        .write_all(bytes)
        .map_err(|err| format!("Unable to write '{}': {err}", path.display()))?;
    output
        .commit()
        .map_err(|err| format!("Unable to commit '{}': {err}", path.display()))?;
    flush_directory(
        path.parent()
            .ok_or_else(|| format!("State path has no parent: {}", path.display()))?,
    )
}

#[cfg(windows)]
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::winbase::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};

    ensure_safe_file_if_present(path, "application state destination")?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("State path has no parent: {}", path.display()))?;
    ensure_directory_without_reparse(parent)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("State path has no filename: {}", path.display()))?
        .to_string_lossy();
    let (mut output, temporary_path) = (0..32)
        .find_map(|_| {
            let sequence = STATE_TEMP_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
            let candidate = parent.join(format!(
                ".{file_name}.imm-state-{}-{sequence}.tmp",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((file, candidate))),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(err) => Some(Err(format!("Unable to stage '{}': {err}", path.display()))),
            }
        })
        .transpose()?
        .ok_or_else(|| {
            format!(
                "Unable to allocate a temporary state file for '{}'.",
                path.display()
            )
        })?;

    if let Err(err) = output.write_all(bytes).and_then(|_| output.sync_all()) {
        drop(output);
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Unable to flush staged state '{}': {err}",
            path.display()
        ));
    }
    drop(output);

    let source = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        let err = std::io::Error::last_os_error();
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Unable to publish state '{}': {err}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn flush_directory(_path: &Path) -> Result<(), String> {
    // State publication uses a flushed file plus MOVEFILE_WRITE_THROUGH.
    // Directory sync_all is not supported by Windows.
    Ok(())
}

#[cfg(not(windows))]
fn flush_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|err| format!("Unable to flush directory '{}': {err}", path.display()))
}

fn read_pointer_optional(path: &Path) -> Result<Option<GenerationPointer>, String> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!(
            "Unable to inspect state pointer '{}': {err}",
            path.display()
        )),
        Ok(_) => {
            let bytes = read_bounded(path, 16 * 1024, "application state pointer")?;
            let pointer: GenerationPointer = serde_json::from_slice(&bytes)
                .map_err(|err| format!("Invalid application state pointer: {err}"))?;
            validate_generation_name(&pointer.generation)?;
            if pointer.sha256.len() != 64
                || !pointer.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("Application state pointer has an invalid SHA-256.".to_string());
            }
            Ok(Some(pointer))
        }
    }
}

fn validate_generation_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Application state generation name is unsafe.".to_string());
    }
    Ok(())
}

fn generation_path(paths: &RepositoryPaths, generation: &str) -> Result<PathBuf, String> {
    validate_generation_name(generation)?;
    Ok(paths.generations_root.join(format!("{generation}.json")))
}

fn read_generation(
    paths: &RepositoryPaths,
    pointer: &GenerationPointer,
) -> Result<AppStateDocument, String> {
    let path = generation_path(paths, &pointer.generation)?;
    let bytes = read_bounded(&path, MAX_STATE_BYTES, "application state generation")?;
    if sha256_hex(&bytes) != pointer.sha256.to_ascii_uppercase() {
        return Err("Application state generation SHA-256 does not match its pointer.".to_string());
    }
    let state: AppStateDocument = serde_json::from_slice(&bytes)
        .map_err(|err| format!("Invalid application state generation: {err}"))?;
    if state.revision != pointer.generation {
        return Err(
            "Application state generation identity does not match its pointer.".to_string(),
        );
    }
    validate_state_document(&state)?;
    Ok(state)
}

fn validate_state_document(state: &AppStateDocument) -> Result<(), String> {
    if state.schema_version != STATE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported application state schema {}.",
            state.schema_version
        ));
    }
    validate_generation_name(&state.revision)?;
    validate_global_config(&state.global)?;
    let expected_games = SUPPORTED_GAMES
        .iter()
        .map(|game| (*game).to_string())
        .collect::<BTreeSet<_>>();
    let actual_games = state.games.keys().cloned().collect::<BTreeSet<_>>();
    if actual_games != expected_games {
        return Err(
            "Application state does not contain exactly the supported game configurations."
                .to_string(),
        );
    }
    for game in SUPPORTED_GAMES {
        validate_game_config(
            state
                .games
                .get(*game)
                .ok_or_else(|| format!("Missing {game} configuration."))?,
            game,
        )?;
    }
    let actual_local_keys = state
        .webview
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let expected_local_keys = REQUIRED_LOCAL_STORAGE_KEYS
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if actual_local_keys != expected_local_keys {
        return Err(
            "Application state LocalStorage whitelist is incomplete or contains extra keys."
                .to_string(),
        );
    }
    Ok(())
}

fn validate_requested_game(game: Option<&str>) -> Result<(), String> {
    if game.is_some_and(|game| !SUPPORTED_GAMES.contains(&game)) {
        Err("Application config requested an unsupported game.".to_string())
    } else {
        Ok(())
    }
}

fn config_snapshot(
    state: &AppStateDocument,
    game: Option<&str>,
) -> Result<AppConfigSnapshot, String> {
    validate_requested_game(game)?;
    let game_revision = game
        .map(|game| {
            state
                .scope_revisions
                .games
                .get(game)
                .copied()
                .ok_or_else(|| format!("Missing {game} configuration revision."))
        })
        .transpose()?;
    let game_config = game
        .map(|game| {
            state
                .games
                .get(game)
                .cloned()
                .ok_or_else(|| format!("Missing {game} configuration."))
        })
        .transpose()?;
    Ok(AppConfigSnapshot {
        state_revision: state.revision.clone(),
        global_revision: state.scope_revisions.global,
        game_revision,
        global: state.global.clone(),
        game: game_config,
    })
}

fn read_runtime_config_optional(
    path: &Path,
    max_bytes: u64,
    label: &str,
) -> Result<Option<Value>, String> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Unable to inspect {label}: {err}")),
        Ok(_) => {
            let bytes = read_bounded(path, max_bytes, label)?;
            serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|err| format!("Invalid {label}: {err}"))
        }
    }
}

fn read_runtime_game_config(paths: &RepositoryPaths, game: &str) -> Result<Value, String> {
    let path = paths.runtime_root.join(format!("config{game}.json"));
    let config = read_runtime_config_optional(&path, MAX_CONFIG_BYTES, "runtime game projection")?
        .ok_or_else(|| format!("Runtime {game} projection is missing after mutation."))?;
    validate_game_config(&config, game)?;
    Ok(config)
}

fn ensure_runtime_projection_consistent(
    paths: &RepositoryPaths,
    state: &AppStateDocument,
) -> Result<(), String> {
    if let Some(global) = read_runtime_config_optional(
        &paths.runtime_root.join(GLOBAL_CONFIG_NAME),
        MAX_CONFIG_BYTES,
        "runtime global projection",
    )? {
        if global != state.global {
            return Err(
                "Runtime global projection diverges from the committed application state."
                    .to_string(),
            );
        }
    }
    for game in SUPPORTED_GAMES {
        let Some(projected) = read_runtime_config_optional(
            &paths.runtime_root.join(format!("config{game}.json")),
            MAX_CONFIG_BYTES,
            "runtime game projection",
        )?
        else {
            continue;
        };
        if state.games.get(*game) != Some(&projected) {
            return Err(format!(
                "Runtime {game} projection diverges from the committed application state."
            ));
        }
    }
    Ok(())
}

fn validate_global_config(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Global configuration is not an object.".to_string())?;
    require_string(object, "version", "global configuration")?;
    require_string(object, "game", "global configuration")?;
    require_string(object, "lang", "global configuration")?;
    if let Some(game) = object.get("game").and_then(Value::as_str) {
        if !game.is_empty() && !SUPPORTED_GAMES.contains(&game) {
            return Err("Global configuration selects an unsupported game.".to_string());
        }
    }
    Ok(())
}

pub(crate) fn gamebanana_mod_id_from_profile_url(profile_url: &str) -> Option<u64> {
    let url = reqwest::Url::parse(profile_url).ok()?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("gamebanana.com" | "www.gamebanana.com")
        )
    {
        return None;
    }
    let mut segments = url.path_segments()?.filter(|segment| !segment.is_empty());
    let route = segments.next()?;
    if !route.eq_ignore_ascii_case("mod") && !route.eq_ignore_ascii_case("mods") {
        return None;
    }
    segments.next()?.parse().ok().filter(|mod_id| *mod_id > 0)
}

fn validate_gamebanana_bindings(data: &Map<String, Value>, game: &str) -> Result<(), String> {
    let mut primary_bindings = BTreeMap::<u64, String>::new();
    for (path, value) in data {
        let Some(binding_value) = value.get("gameBanana") else {
            continue;
        };
        let binding = binding_value
            .as_object()
            .ok_or_else(|| format!("{game} Mod '{path}' GameBanana binding is not an object."))?;
        if binding.get("provider").and_then(Value::as_str) != Some("gamebanana") {
            return Err(format!(
                "{game} Mod '{path}' GameBanana binding has an unsupported provider."
            ));
        }
        let mod_id = binding
            .get("modId")
            .and_then(Value::as_u64)
            .filter(|mod_id| *mod_id > 0)
            .ok_or_else(|| format!("{game} Mod '{path}' has an invalid GameBanana Mod ID."))?;
        let profile_url = binding
            .get("profileUrl")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 2_048)
            .ok_or_else(|| format!("{game} Mod '{path}' has an invalid GameBanana profile URL."))?;
        if gamebanana_mod_id_from_profile_url(profile_url) != Some(mod_id) {
            return Err(format!(
                "{game} Mod '{path}' GameBanana profile URL does not match Mod ID {mod_id}."
            ));
        }
        if let Some(source) = value.get("source").and_then(Value::as_str) {
            if gamebanana_mod_id_from_profile_url(source) != Some(mod_id) {
                return Err(format!(
                    "{game} Mod '{path}' source does not match its GameBanana binding."
                ));
            }
        }
        let variant = binding
            .get("variant")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{game} Mod '{path}' GameBanana variant is missing."))?;
        if !matches!(variant, "primary" | "independent") {
            return Err(format!(
                "{game} Mod '{path}' has an invalid GameBanana variant."
            ));
        }
        if binding
            .get("boundAt")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .is_none()
        {
            return Err(format!(
                "{game} Mod '{path}' has an invalid GameBanana binding timestamp."
            ));
        }
        if let Some(selected_file) = binding.get("selectedFile") {
            let file = selected_file.as_object().ok_or_else(|| {
                format!("{game} Mod '{path}' GameBanana selected file is not an object.")
            })?;
            for (field, max_length) in [("id", 2_048_usize), ("name", 1_024_usize)] {
                if file
                    .get(field)
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty() && value.len() <= max_length)
                    .is_none()
                {
                    return Err(format!(
                        "{game} Mod '{path}' GameBanana selected file has an invalid {field}."
                    ));
                }
            }
            for field in ["size", "updatedAt"] {
                if file.get(field).and_then(Value::as_u64).is_none() {
                    return Err(format!(
                        "{game} Mod '{path}' GameBanana selected file has an invalid {field}."
                    ));
                }
            }
        }
        if variant == "primary" {
            if let Some(existing) = primary_bindings.insert(mod_id, path.clone()) {
                return Err(format!(
                    "{game} GameBanana Mod ID {mod_id} has multiple primary bindings: '{existing}' and '{path}'."
                ));
            }
        }
    }
    Ok(())
}

fn validate_game_config(value: &Value, expected_game: &str) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{expected_game} configuration is not an object."))?;
    if object.get("game").and_then(Value::as_str) != Some(expected_game) {
        return Err(format!(
            "{expected_game} configuration has the wrong game identity."
        ));
    }
    for field in ["version", "sourceDir", "targetDir"] {
        require_string(object, field, &format!("{expected_game} configuration"))?;
    }
    require_type(object, "settings", Value::is_object, expected_game)?;
    require_type(object, "data", Value::is_object, expected_game)?;
    require_type(object, "presets", Value::is_array, expected_game)?;
    require_type(object, "downloads", Value::is_object, expected_game)?;
    require_type(object, "categories", Value::is_array, expected_game)?;
    let downloads = object["downloads"]
        .as_object()
        .ok_or_else(|| format!("{expected_game} downloads are invalid."))?;
    for queue in ["queue", "downloading", "extracting", "completed", "failed"] {
        require_type(downloads, queue, Value::is_array, expected_game)?;
    }
    validate_gamebanana_bindings(
        object["data"]
            .as_object()
            .ok_or_else(|| format!("{expected_game} Mod data is invalid."))?,
        expected_game,
    )?;
    if expected_game == "NTE" {
        require_string(object, "nteRegion", "NTE configuration")?;
    }
    Ok(())
}

fn require_string(object: &Map<String, Value>, field: &str, label: &str) -> Result<(), String> {
    if object.get(field).is_some_and(Value::is_string) {
        Ok(())
    } else {
        Err(format!("{label} field '{field}' is not a string."))
    }
}

fn require_type(
    object: &Map<String, Value>,
    field: &str,
    predicate: fn(&Value) -> bool,
    game: &str,
) -> Result<(), String> {
    if object.get(field).is_some_and(predicate) {
        Ok(())
    } else {
        Err(format!(
            "{game} configuration field '{field}' has the wrong type."
        ))
    }
}

fn snapshot_candidates(control_root: &Path) -> Result<Vec<PathBuf>, String> {
    if !control_root.exists() {
        return Ok(Vec::new());
    }
    ensure_directory_without_reparse(control_root)?;
    let mut candidates = Vec::new();
    for entry in fs::read_dir(control_root)
        .map_err(|err| format!("Unable to enumerate migration snapshots: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Unable to read a snapshot entry: {err}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("snapshot-") || name.ends_with(".staging") {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|err| format!("Unable to inspect snapshot '{name}': {err}"))?;
        if !metadata.is_dir() || metadata_is_reparse(&metadata) {
            return Err(format!(
                "Snapshot candidate '{name}' is not a safe directory."
            ));
        }
        candidates.push(entry.path());
    }
    candidates.sort();
    Ok(candidates)
}

fn snapshot_candidate_names(control_root: &Path) -> Vec<String> {
    snapshot_candidates(control_root)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .collect()
}

fn legacy_configs_exist(legacy_root: &Path) -> bool {
    fs::symlink_metadata(legacy_root.join(GLOBAL_CONFIG_NAME)).is_ok()
        || SUPPORTED_GAMES.iter().any(|game| {
            fs::symlink_metadata(legacy_root.join(format!("config{game}.json"))).is_ok()
        })
}

fn legacy_config_names() -> Vec<String> {
    std::iter::once(GLOBAL_CONFIG_NAME.to_string())
        .chain(
            SUPPORTED_GAMES
                .iter()
                .map(|game| format!("config{game}.json")),
        )
        .collect()
}

fn backup_legacy_config_files(
    paths: &RepositoryPaths,
    reason: &str,
) -> Result<Option<LegacyBackup>, String> {
    if !legacy_configs_exist(&paths.legacy_data_root) {
        return Ok(None);
    }
    ensure_directory_without_reparse(&paths.legacy_data_root)?;
    let mut files = BTreeMap::new();
    for name in legacy_config_names() {
        let source = paths.legacy_data_root.join(&name);
        match fs::symlink_metadata(&source) {
            Ok(_) => {
                files.insert(
                    name,
                    read_bounded(&source, MAX_CONFIG_BYTES, "legacy config")?,
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Unable to inspect legacy configuration '{}': {error}",
                    source.display()
                ))
            }
        }
    }
    if files.is_empty() {
        return Ok(None);
    }

    let id = next_revision()?.replacen("state-", "legacy-", 1);
    let staging = paths.legacy_backups_root.join(format!("{id}.staging"));
    let destination = paths.legacy_backups_root.join(&id);
    fs::create_dir(&staging).map_err(|error| {
        format!(
            "Unable to create legacy backup staging '{}': {error}",
            staging.display()
        )
    })?;
    ensure_directory_without_reparse(&staging)?;

    let backup_result = (|| {
        let raw_root = staging.join("raw");
        fs::create_dir(&raw_root)
            .map_err(|error| format!("Unable to create legacy backup raw directory: {error}"))?;
        ensure_directory_without_reparse(&raw_root)?;
        let mut hashes = BTreeMap::new();
        for (name, bytes) in &files {
            atomic_write(&raw_root.join(name), bytes)?;
            hashes.insert(name.clone(), sha256_hex(bytes));
        }
        let manifest = LegacyBackupManifest {
            schema_version: 1,
            backup_id: id.clone(),
            created_at_utc: utc_timestamp()?,
            reason: reason.to_string(),
            files: hashes,
        };
        atomic_write(
            &staging.join("manifest.json"),
            &serialize_pretty(&manifest)?,
        )?;
        fs::rename(&staging, &destination).map_err(|error| {
            format!(
                "Unable to publish legacy backup '{}' as '{}': {error}",
                staging.display(),
                destination.display()
            )
        })?;
        flush_directory(&paths.legacy_backups_root)
    })();
    if let Err(error) = backup_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    Ok(Some(LegacyBackup { id, files }))
}

fn backup_legacy_configs(paths: &RepositoryPaths, reason: &str) -> Result<Option<String>, String> {
    Ok(backup_legacy_config_files(paths, reason)?.map(|backup| backup.id))
}

fn merge_legacy_json(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Object(base), Value::Object(overlay)) => {
            for (key, value) in overlay {
                if let Some(existing) = base.get_mut(&key) {
                    merge_legacy_json(existing, value);
                } else {
                    base.insert(key, value);
                }
            }
        }
        (base, overlay) => *base = overlay,
    }
}

fn import_legacy_state(paths: &RepositoryPaths) -> Result<AppStateDocument, String> {
    let backup = backup_legacy_config_files(paths, "automatic-migration")?
        .ok_or_else(|| "Legacy configuration disappeared before migration.".to_string())?;
    let mut state = fresh_default_state()?;
    let mut imported_artifacts = BTreeMap::new();

    for (name, bytes) in &backup.files {
        let legacy: Value = serde_json::from_slice(bytes)
            .map_err(|error| format!("Invalid JSON in legacy {name}: {error}"))?;
        if !legacy.is_object() {
            return Err(format!("Legacy {name} is not a JSON object."));
        }
        if name == GLOBAL_CONFIG_NAME {
            merge_legacy_json(&mut state.global, legacy);
        } else if let Some(game) = SUPPORTED_GAMES
            .iter()
            .copied()
            .find(|game| name.eq_ignore_ascii_case(&format!("config{game}.json")))
        {
            let target = state
                .games
                .get_mut(game)
                .ok_or_else(|| format!("Bundled state is missing {game}."))?;
            merge_legacy_json(target, legacy);
            target["game"] = Value::String(game.to_string());
        }
        imported_artifacts.insert(format!("legacy/{name}"), sha256_hex(bytes));
    }

    validate_global_config(&state.global)?;
    for game in SUPPORTED_GAMES {
        validate_game_config(
            state
                .games
                .get(*game)
                .ok_or_else(|| format!("Migrated state is missing {game}."))?,
            game,
        )?;
    }
    let language = state
        .global
        .get("lang")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("en");
    state.webview = BTreeMap::from([
        ("game-theme".to_string(), "".to_string()),
        (
            "imm-lang".to_string(),
            serde_json::to_string(language)
                .map_err(|error| format!("Unable to migrate saved language: {error}"))?,
        ),
    ]);
    state.revision = next_revision()?;
    state.migration = MigrationRecord {
        source_kind: "automatic-legacy-backup".to_string(),
        snapshot_id: Some(backup.id),
        imported_at_utc: utc_timestamp()?,
        imported_artifacts,
    };
    validate_state_document(&state)?;
    Ok(state)
}

fn safe_snapshot_artifact(snapshot_root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("Snapshot artifact path is unsafe: {relative}"));
    }
    let root = snapshot_root
        .canonicalize()
        .map_err(|err| format!("Unable to canonicalize snapshot root: {err}"))?;
    let candidate = snapshot_root.join(relative_path);
    let canonical = candidate
        .canonicalize()
        .map_err(|err| format!("Unable to canonicalize snapshot artifact '{relative}': {err}"))?;
    if !canonical.starts_with(&root) {
        return Err(format!("Snapshot artifact escapes its root: {relative}"));
    }
    ensure_safe_file_if_present(&canonical, "snapshot artifact")?;
    Ok(canonical)
}

fn import_snapshot(snapshot_root: &Path) -> Result<AppStateDocument, String> {
    ensure_directory_without_reparse(snapshot_root)?;
    let manifest_path = safe_snapshot_artifact(snapshot_root, "manifest.json")?;
    let declared_hash_path = safe_snapshot_artifact(snapshot_root, "manifest.sha256")?;
    let manifest_bytes = read_bounded(&manifest_path, MAX_MANIFEST_BYTES, "snapshot manifest")?;
    let declared_hash_text = String::from_utf8(read_bounded(
        &declared_hash_path,
        4096,
        "snapshot manifest hash",
    )?)
    .map_err(|_| "Snapshot manifest hash is not UTF-8.".to_string())?;
    let declared_hash = declared_hash_text
        .split_ascii_whitespace()
        .next()
        .ok_or_else(|| "Snapshot manifest hash is empty.".to_string())?
        .to_ascii_uppercase();
    if declared_hash.len() != 64
        || !declared_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || sha256_hex(&manifest_bytes) != declared_hash
    {
        return Err("Snapshot manifest SHA-256 verification failed.".to_string());
    }

    let manifest: SnapshotManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|err| format!("Invalid snapshot manifest: {err}"))?;
    if manifest.schema_version != SNAPSHOT_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported snapshot schema {}.",
            manifest.schema_version
        ));
    }
    if manifest.snapshot_id.is_empty() || manifest.snapshot_id.len() > 128 {
        return Err("Snapshot id is missing or too long.".to_string());
    }

    let mut artifacts = BTreeMap::<String, (SnapshotFileEntry, Vec<u8>)>::new();
    let mut imported_hashes = BTreeMap::new();
    for entry in manifest.files {
        if artifacts.contains_key(&entry.artifact_path) {
            return Err(format!(
                "Duplicate snapshot artifact: {}",
                entry.artifact_path
            ));
        }
        let max_bytes = if entry.artifact_path == LOCAL_STORAGE_ARTIFACT {
            MAX_LOCAL_STORAGE_BYTES
        } else {
            MAX_CONFIG_BYTES
        };
        let path = safe_snapshot_artifact(snapshot_root, &entry.artifact_path)?;
        let bytes = read_bounded(&path, max_bytes, "snapshot artifact")?;
        if bytes.len() as u64 != entry.length
            || sha256_hex(&bytes) != entry.sha256.to_ascii_uppercase()
        {
            return Err(format!(
                "Snapshot artifact verification failed: {}",
                entry.artifact_path
            ));
        }
        imported_hashes.insert(
            entry.artifact_path.clone(),
            entry.sha256.to_ascii_uppercase(),
        );
        artifacts.insert(entry.artifact_path.clone(), (entry, bytes));
    }

    let mut global = None;
    let mut games = BTreeMap::new();
    let mut local_storage = None;
    for (artifact_path, (entry, bytes)) in artifacts {
        match entry.kind.as_str() {
            "legacy-config-raw" => {
                let source_name = entry.relative_source_path.as_deref().ok_or_else(|| {
                    format!("Config artifact has no source filename: {artifact_path}")
                })?;
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|err| format!("Invalid JSON in {source_name}: {err}"))?;
                if source_name == GLOBAL_CONFIG_NAME {
                    if global.replace(value).is_some() {
                        return Err(
                            "Snapshot contains more than one global configuration.".to_string()
                        );
                    }
                    continue;
                }
                let game = SUPPORTED_GAMES
                    .iter()
                    .copied()
                    .find(|game| source_name.eq_ignore_ascii_case(&format!("config{game}.json")))
                    .ok_or_else(|| format!("Snapshot contains an unknown config: {source_name}"))?;
                if games.insert(game.to_string(), value).is_some() {
                    return Err(format!("Snapshot contains duplicate {game} configuration."));
                }
            }
            "chromium-localstorage-whitelist" if artifact_path == LOCAL_STORAGE_ARTIFACT => {
                let parsed: LocalStorageSnapshot = serde_json::from_slice(&bytes)
                    .map_err(|err| format!("Invalid LocalStorage snapshot: {err}"))?;
                if parsed.schema_version != 1 {
                    return Err("Unsupported LocalStorage snapshot schema.".to_string());
                }
                let values = parsed
                    .records
                    .into_iter()
                    .map(|(key, record)| (key, record.value))
                    .collect::<BTreeMap<_, _>>();
                if local_storage.replace(values).is_some() {
                    return Err("Snapshot contains duplicate LocalStorage artifacts.".to_string());
                }
            }
            _ => {
                return Err(format!(
                    "Snapshot contains an unsupported artifact: {artifact_path}"
                ))
            }
        }
    }

    let global = global.ok_or_else(|| "Snapshot is missing config.json.".to_string())?;
    validate_global_config(&global)?;
    for game in SUPPORTED_GAMES {
        validate_game_config(
            games
                .get(*game)
                .ok_or_else(|| format!("Snapshot is missing config{game}.json."))?,
            game,
        )?;
    }
    let webview =
        local_storage.ok_or_else(|| "Snapshot is missing LocalStorage state.".to_string())?;

    let state = AppStateDocument {
        schema_version: STATE_SCHEMA_VERSION,
        revision: next_revision()?,
        scope_revisions: ScopeRevisions {
            global: 1,
            games: SUPPORTED_GAMES
                .iter()
                .map(|game| ((*game).to_string(), 1))
                .collect(),
            webview: 1,
        },
        global,
        games,
        webview,
        migration: MigrationRecord {
            source_kind: "snapshot".to_string(),
            snapshot_id: Some(manifest.snapshot_id),
            imported_at_utc: utc_timestamp()?,
            imported_artifacts: imported_hashes,
        },
    };
    validate_state_document(&state)?;
    Ok(state)
}

fn fresh_default_state() -> Result<AppStateDocument, String> {
    let global: Value = serde_json::from_str(include_str!("../../src/default.json"))
        .map_err(|err| format!("Bundled global defaults are invalid: {err}"))?;
    let generic: Value = serde_json::from_str(include_str!("../../src/defaultXX.json"))
        .map_err(|err| format!("Bundled game defaults are invalid: {err}"))?;
    let nte: Value = serde_json::from_str(include_str!("../../src/defaultNTE.json"))
        .map_err(|err| format!("Bundled NTE defaults are invalid: {err}"))?;
    let mut games = BTreeMap::new();
    for game in SUPPORTED_GAMES {
        let mut value = if *game == "NTE" {
            nte.clone()
        } else {
            generic.clone()
        };
        value
            .as_object_mut()
            .ok_or_else(|| "Bundled game defaults are not an object.".to_string())?
            .insert("game".to_string(), Value::String((*game).to_string()));
        games.insert((*game).to_string(), value);
    }
    let state = AppStateDocument {
        schema_version: STATE_SCHEMA_VERSION,
        revision: next_revision()?,
        scope_revisions: ScopeRevisions {
            global: 1,
            games: SUPPORTED_GAMES
                .iter()
                .map(|game| ((*game).to_string(), 1))
                .collect(),
            webview: 1,
        },
        global,
        games,
        webview: BTreeMap::from([
            ("game-theme".to_string(), "".to_string()),
            ("imm-lang".to_string(), "\"en\"".to_string()),
        ]),
        migration: MigrationRecord {
            source_kind: "fresh-install".to_string(),
            snapshot_id: None,
            imported_at_utc: utc_timestamp()?,
            imported_artifacts: BTreeMap::new(),
        },
    };
    validate_state_document(&state)?;
    Ok(state)
}

fn write_pointer(path: &Path, pointer: &GenerationPointer) -> Result<(), String> {
    atomic_write(path, &serialize_pretty(pointer)?)
}

fn commit_state(
    paths: &RepositoryPaths,
    journal: &mut WalJournal,
    state: AppStateDocument,
) -> Result<AppStateDocument, String> {
    validate_state_document(&state)?;
    let before = read_pointer_optional(&paths.current_pointer)?;
    if before.is_none() && paths.previous_pointer.exists() {
        return Err("Previous state pointer exists without a current pointer.".to_string());
    }

    let generation_bytes = serialize_pretty(&state)?;
    if generation_bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Application state exceeds the generation size limit.".to_string());
    }
    let after = GenerationPointer {
        generation: state.revision.clone(),
        sha256: sha256_hex(&generation_bytes),
    };
    let plan = StateTransactionPlan {
        before: before.clone(),
        after: after.clone(),
    };
    let plan_bytes = serde_json::to_vec(&plan)
        .map_err(|err| format!("Unable to serialize state transaction plan: {err}"))?;
    let transaction_id = journal.begin(&plan_bytes)?;

    let generation_path = generation_path(paths, &after.generation)?;
    atomic_write(&generation_path, &generation_bytes)?;
    journal.append(transaction_id, WalState::Committing, b"generation-written")?;

    if let Some(before) = &before {
        write_pointer(&paths.previous_pointer, before)?;
    }
    journal.append(
        transaction_id,
        WalState::StepReceipt,
        b"previous-pointer-written",
    )?;
    write_pointer(&paths.current_pointer, &after)?;
    journal.append(
        transaction_id,
        WalState::StepReceipt,
        b"current-pointer-written",
    )?;
    journal.append(
        transaction_id,
        WalState::CommittedAfter,
        b"state-pointer-committed",
    )?;

    write_runtime_projection(paths, &state)?;
    write_migration_report(paths, &state)?;
    journal.append(
        transaction_id,
        WalState::CleanupComplete,
        b"projection-complete",
    )?;
    Ok(state)
}

fn recover_incomplete_transaction(
    paths: &RepositoryPaths,
    journal: &mut WalJournal,
) -> Result<(), String> {
    let Some(incomplete) = journal.incomplete_transaction()? else {
        return Ok(());
    };
    let plan: StateTransactionPlan = serde_json::from_slice(&incomplete.prepared_payload)
        .map_err(|err| format!("Invalid application state recovery plan: {err}"))?;
    validate_generation_name(&plan.after.generation)?;
    if let Some(before) = &plan.before {
        validate_generation_name(&before.generation)?;
    }
    let current = read_pointer_optional(&paths.current_pointer)?;

    if current.as_ref() == Some(&plan.after) {
        if incomplete.state == WalState::AbortedBefore {
            return Err("State pointer committed after the WAL recorded an abort.".to_string());
        }
        if incomplete.state == WalState::Prepared {
            journal.append(incomplete.transaction_id, WalState::Committing, b"recovery")?;
        }
        if !matches!(incomplete.state, WalState::CommittedAfter) {
            journal.append(
                incomplete.transaction_id,
                WalState::CommittedAfter,
                b"recovered-after-pointer",
            )?;
        }
        let state = read_generation(paths, &plan.after)?;
        write_runtime_projection(paths, &state)?;
        write_migration_report(paths, &state)?;
        journal.append(
            incomplete.transaction_id,
            WalState::CleanupComplete,
            b"recovery-projection-complete",
        )?;
        return Ok(());
    }

    if current == plan.before {
        if incomplete.state == WalState::CommittedAfter {
            return Err("WAL committed application state but the current pointer is still at the before generation.".to_string());
        }
        if incomplete.state == WalState::Prepared {
            journal.append(incomplete.transaction_id, WalState::Committing, b"recovery")?;
        }
        if incomplete.state != WalState::AbortedBefore {
            journal.append(
                incomplete.transaction_id,
                WalState::AbortedBefore,
                b"recovered-before-pointer",
            )?;
        }
        let after_path = generation_path(paths, &plan.after.generation)?;
        match fs::remove_file(&after_path) {
            Ok(()) => flush_directory(&paths.generations_root)?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("Unable to remove aborted state generation: {err}")),
        }
        if let Some(before) = &plan.before {
            let state = read_generation(paths, before)?;
            write_runtime_projection(paths, &state)?;
            write_migration_report(paths, &state)?;
        }
        journal.append(
            incomplete.transaction_id,
            WalState::CleanupComplete,
            b"recovery-abort-complete",
        )?;
        return Ok(());
    }

    Err(
        "Application state pointer matches neither the transaction before nor after generation."
            .to_string(),
    )
}

fn write_runtime_projection(
    paths: &RepositoryPaths,
    state: &AppStateDocument,
) -> Result<(), String> {
    ensure_directory_without_reparse(&paths.runtime_root)?;
    let global_path = paths.runtime_root.join(GLOBAL_CONFIG_NAME);
    atomic_write(&global_path, &serialize_pretty(&state.global)?)?;
    for game in SUPPORTED_GAMES {
        let config = state
            .games
            .get(*game)
            .ok_or_else(|| format!("State projection is missing {game}."))?;
        atomic_write(
            &paths.runtime_root.join(format!("config{game}.json")),
            &serialize_pretty(config)?,
        )?;
    }
    Ok(())
}

fn write_migration_report(paths: &RepositoryPaths, state: &AppStateDocument) -> Result<(), String> {
    let report = serde_json::json!({
        "schemaVersion": 1,
        "status": "verified",
        "stateRevision": &state.revision,
        "migration": &state.migration,
        "games": SUPPORTED_GAMES,
        "localStorageKeys": REQUIRED_LOCAL_STORAGE_KEYS,
    });
    atomic_write(
        &paths.reports_root.join("latest.json"),
        &serialize_pretty(&report)?,
    )
}

#[tauri::command]
pub(crate) fn get_app_state_bootstrap_status(
    repository: tauri::State<'_, AppStateRepository>,
) -> BootstrapStatus {
    repository.status()
}

#[tauri::command]
pub(crate) fn retry_app_state_bootstrap(
    repository: tauri::State<'_, AppStateRepository>,
) -> BootstrapStatus {
    let status = repository.bootstrap();
    if matches!(status, BootstrapStatus::Ready { .. }) {
        if let Err(error) = std::env::set_current_dir(repository.runtime_root()) {
            return BootstrapStatus::RecoveryRequired {
                error: format!("Unable to activate recovered application state: {error}"),
                control_root: repository.control_root().to_string_lossy().into_owned(),
                snapshot_candidates: snapshot_candidate_names(repository.control_root()),
            };
        }
    }
    status
}

#[tauri::command]
pub(crate) fn load_app_config(
    repository: tauri::State<'_, AppStateRepository>,
    game: Option<String>,
) -> Result<AppConfigSnapshot, String> {
    repository.load_config(game.as_deref())
}

#[tauri::command]
pub(crate) fn save_app_config(
    repository: tauri::State<'_, AppStateRepository>,
    global: Option<Value>,
    game: Option<Value>,
    expected_global_revision: Option<u64>,
    expected_game_revision: Option<u64>,
) -> Result<AppConfigSnapshot, String> {
    repository.save_config(
        global,
        game,
        expected_global_revision,
        expected_game_revision,
    )
}

#[tauri::command]
pub(crate) fn reset_app_state_with_backup(
    repository: tauri::State<'_, AppStateRepository>,
) -> Result<AppConfigSnapshot, String> {
    let snapshot = repository.reset_with_backup()?;
    std::env::set_current_dir(repository.runtime_root())
        .map_err(|error| format!("Unable to activate reset application state: {error}"))?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture_game_config(game: &str) -> Value {
        let source = if game == "NTE" {
            include_str!("../../src/defaultNTE.json")
        } else {
            include_str!("../../src/defaultXX.json")
        };
        let mut value: Value = serde_json::from_str(source).expect("fixture defaults");
        let object = value.as_object_mut().expect("fixture object");
        object.insert("game".to_string(), Value::String(game.to_string()));
        object.insert(
            "sourceDir".to_string(),
            Value::String(format!(r"D:\Fixture\{game}\Library")),
        );
        object.insert(
            "targetDir".to_string(),
            Value::String(format!(r"D:\Fixture\{game}\Target")),
        );
        object.insert(
            "downloads".to_string(),
            serde_json::json!({
                "queue": [{"file": "queued.zip"}],
                "downloading": [{"file": "active.zip"}],
                "extracting": [{"file": "extracting.zip"}],
                "completed": [{"file": "complete.zip"}],
                "failed": [{"file": "failed.zip"}],
            }),
        );
        if game == "WW" {
            object.insert(
                "data".to_string(),
                serde_json::json!({
                    r"D:\Fixture\WW\Library\Mod Alpha": {
                        "enabled": true,
                        "source": "gamebanana:1001"
                    },
                    r"D:\Fixture\WW\Library\Mod Beta": {
                        "enabled": false,
                        "source": "gamebanana:1002"
                    }
                }),
            );
            object.insert(
                "categories".to_string(),
                serde_json::json!([
                    {"_sName": "Characters"},
                    {"_sName": "UI"}
                ]),
            );
        }
        if game == "NTE" {
            object.insert("nteRegion".to_string(), Value::String("global".to_string()));
        }
        value
    }

    fn write_fixture_snapshot(
        control_root: &Path,
        legacy_root: &Path,
        wrong_identity: Option<&str>,
    ) -> BTreeMap<String, Vec<u8>> {
        let snapshot_root = control_root.join("snapshot-fixture-001");
        let raw_root = snapshot_root.join("raw").join("fixture-source");
        fs::create_dir_all(&raw_root).expect("snapshot fixture directories");
        fs::create_dir_all(legacy_root).expect("legacy fixture directory");

        let mut manifest_files = Vec::new();
        let mut legacy_bytes = BTreeMap::new();
        let mut configs = vec![(
            GLOBAL_CONFIG_NAME.to_string(),
            serde_json::from_str::<Value>(include_str!("../../src/default.json"))
                .expect("global fixture"),
        )];
        configs.extend(SUPPORTED_GAMES.iter().map(|game| {
            let mut value = fixture_game_config(game);
            if wrong_identity == Some(*game) {
                value["game"] = Value::String("WRONG".to_string());
            }
            (format!("config{game}.json"), value)
        }));

        for (name, value) in configs {
            let bytes = serialize_pretty(&value).expect("serialize fixture config");
            let artifact_path = format!("raw/fixture-source/{name}");
            fs::write(snapshot_root.join(&artifact_path), &bytes).expect("write snapshot config");
            fs::write(legacy_root.join(&name), &bytes).expect("write legacy fixture config");
            legacy_bytes.insert(name.clone(), bytes.clone());
            manifest_files.push(serde_json::json!({
                "artifactPath": artifact_path,
                "kind": "legacy-config-raw",
                "length": bytes.len(),
                "relativeSourcePath": name,
                "sha256": sha256_hex(&bytes),
            }));
        }

        let local_storage = serialize_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "records": {
                "game-theme": {"value": "wuwa"},
                "imm-lang": {"value": "\"cn\""}
            }
        }))
        .expect("serialize LocalStorage fixture");
        let local_storage_path = snapshot_root.join(LOCAL_STORAGE_ARTIFACT);
        fs::create_dir_all(local_storage_path.parent().expect("LocalStorage parent"))
            .expect("LocalStorage fixture directory");
        fs::write(&local_storage_path, &local_storage).expect("write LocalStorage fixture");
        manifest_files.push(serde_json::json!({
            "artifactPath": LOCAL_STORAGE_ARTIFACT,
            "kind": "chromium-localstorage-whitelist",
            "length": local_storage.len(),
            "sha256": sha256_hex(&local_storage),
        }));

        let manifest = serialize_pretty(&serde_json::json!({
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
            "snapshotId": "fixture-001",
            "files": manifest_files,
        }))
        .expect("serialize fixture manifest");
        fs::write(snapshot_root.join("manifest.json"), &manifest).expect("write fixture manifest");
        fs::write(
            snapshot_root.join("manifest.sha256"),
            format!("{}  manifest.json\n", sha256_hex(&manifest)),
        )
        .expect("write fixture manifest hash");
        legacy_bytes
    }

    fn assert_legacy_unchanged(legacy_root: &Path, expected: &BTreeMap<String, Vec<u8>>) {
        for (name, bytes) in expected {
            assert_eq!(
                fs::read(legacy_root.join(name)).expect("read legacy fixture after bootstrap"),
                *bytes,
                "legacy source changed: {name}"
            );
        }
    }

    fn tree_hashes(root: &Path) -> BTreeMap<PathBuf, String> {
        fn visit(root: &Path, current: &Path, hashes: &mut BTreeMap<PathBuf, String>) {
            for entry in fs::read_dir(current).expect("read snapshot tree") {
                let entry = entry.expect("snapshot tree entry");
                let file_type = entry.file_type().expect("snapshot entry type");
                assert!(
                    !file_type.is_symlink(),
                    "snapshot test source contains a symlink"
                );
                if file_type.is_dir() {
                    visit(root, &entry.path(), hashes);
                } else if file_type.is_file() {
                    let relative = entry
                        .path()
                        .strip_prefix(root)
                        .expect("snapshot relative path")
                        .to_path_buf();
                    hashes.insert(
                        relative,
                        sha256_hex(&fs::read(entry.path()).expect("read snapshot file")),
                    );
                }
            }
        }

        let mut hashes = BTreeMap::new();
        visit(root, root, &mut hashes);
        hashes
    }

    fn copy_tree(source: &Path, destination: &Path) {
        fs::create_dir_all(destination).expect("create snapshot destination");
        for entry in fs::read_dir(source).expect("read snapshot source") {
            let entry = entry.expect("snapshot source entry");
            let file_type = entry.file_type().expect("snapshot source type");
            assert!(
                !file_type.is_symlink(),
                "snapshot test source contains a symlink"
            );
            let target = destination.join(entry.file_name());
            if file_type.is_dir() {
                copy_tree(&entry.path(), &target);
            } else if file_type.is_file() {
                fs::copy(entry.path(), target).expect("copy snapshot file");
            }
        }
    }

    #[test]
    fn imports_verified_snapshot_without_writing_legacy_sources() {
        let temp = TempDir::new().expect("temp repository");
        let control_root = temp.path().join("control");
        let legacy_root = temp.path().join("legacy");
        let legacy_before = write_fixture_snapshot(&control_root, &legacy_root, None);
        let repository = AppStateRepository::new(control_root, legacy_root.clone(), false);

        let status = repository.bootstrap();

        assert!(matches!(
            status,
            BootstrapStatus::Ready {
                migrated_from_snapshot: Some(ref snapshot),
                ..
            } if snapshot == "fixture-001"
        ));
        assert_legacy_unchanged(&legacy_root, &legacy_before);
        let pointer = read_pointer_optional(&repository.paths.current_pointer)
            .expect("read current pointer")
            .expect("current pointer");
        let state = read_generation(&repository.paths, &pointer).expect("read imported generation");
        assert_eq!(state.games["WW"]["data"].as_object().map(Map::len), Some(2));
        assert_eq!(
            state.games["WW"]["categories"].as_array().map(Vec::len),
            Some(2)
        );
        assert_eq!(state.games["NTE"]["nteRegion"], "global");
        for queue in ["queue", "downloading", "extracting", "completed", "failed"] {
            assert_eq!(
                state.games["WW"]["downloads"][queue]
                    .as_array()
                    .map(Vec::len),
                Some(1)
            );
        }
    }

    #[test]
    fn valid_legacy_configs_are_backed_up_and_imported_without_a_manual_snapshot() {
        let temp = TempDir::new().expect("temp repository");
        let control_root = temp.path().join("control");
        let legacy_root = temp.path().join("legacy");
        let legacy_before = write_fixture_snapshot(&control_root, &legacy_root, None);
        fs::remove_dir_all(control_root.join("snapshot-fixture-001"))
            .expect("remove manual snapshot fixture");
        let repository = AppStateRepository::new(control_root, legacy_root.clone(), false);

        let status = repository.bootstrap();

        let backup_id = match status {
            BootstrapStatus::Ready {
                migrated_from_snapshot: Some(backup_id),
                ..
            } => backup_id,
            other => panic!("expected automatic legacy migration, got {other:?}"),
        };
        assert!(backup_id.starts_with("legacy-"));
        assert_legacy_unchanged(&legacy_root, &legacy_before);
        let backup_root = repository.paths.legacy_backups_root.join(backup_id);
        let manifest: LegacyBackupManifest = serde_json::from_slice(
            &fs::read(backup_root.join("manifest.json")).expect("read legacy manifest"),
        )
        .expect("parse legacy manifest");
        for (name, bytes) in legacy_before {
            assert_eq!(
                fs::read(backup_root.join("raw").join(&name)).expect("read raw legacy backup"),
                bytes
            );
            assert_eq!(manifest.files[&name], sha256_hex(&bytes));
        }
    }

    #[test]
    fn recovery_reset_backs_up_invalid_legacy_config_without_a_current_generation() {
        let temp = TempDir::new().expect("temp repository");
        let legacy_root = temp.path().join("legacy");
        fs::create_dir_all(&legacy_root).expect("legacy root");
        let invalid = b"{not valid json}";
        fs::write(legacy_root.join(GLOBAL_CONFIG_NAME), invalid).expect("invalid legacy config");
        let repository = AppStateRepository::new(temp.path().join("control"), legacy_root, false);
        assert!(matches!(
            repository.bootstrap(),
            BootstrapStatus::RecoveryRequired { .. }
        ));
        assert!(!repository.paths.current_pointer.exists());

        let reset = repository.reset_with_backup().expect("recovery reset");

        assert_eq!(reset.global["game"], "");
        assert!(matches!(repository.status(), BootstrapStatus::Ready { .. }));
        let backups = fs::read_dir(&repository.paths.legacy_backups_root)
            .expect("read legacy backups")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect legacy backups");
        assert_eq!(
            backups.len(),
            2,
            "failed migration and reset both preserve input"
        );
        assert!(backups.iter().any(|entry| {
            fs::read(entry.path().join("raw").join(GLOBAL_CONFIG_NAME))
                .map(|bytes| bytes == invalid)
                .unwrap_or(false)
        }));
    }

    #[test]
    fn wrong_game_identity_fails_closed_without_publishing_state() {
        let temp = TempDir::new().expect("temp repository");
        let control_root = temp.path().join("control");
        let legacy_root = temp.path().join("legacy");
        let legacy_before = write_fixture_snapshot(&control_root, &legacy_root, Some("NTE"));
        let repository = AppStateRepository::new(control_root, legacy_root.clone(), false);

        let status = repository.bootstrap();

        assert!(matches!(
            status,
            BootstrapStatus::RecoveryRequired { ref error, .. }
                if error.contains("wrong game identity")
        ));
        assert!(!repository.paths.current_pointer.exists());
        assert!(!repository.paths.runtime_root.join("config.json").exists());
        assert_legacy_unchanged(&legacy_root, &legacy_before);
    }

    #[test]
    fn committed_wal_recovers_missing_runtime_projection() {
        let temp = TempDir::new().expect("temp repository");
        let repository = AppStateRepository::new(
            temp.path().join("control"),
            temp.path().join("legacy"),
            true,
        );
        repository.prepare_control_layout().expect("control layout");
        let mut journal =
            WalJournal::open_app_state(&repository.paths.wal_path).expect("open state WAL");
        let original = commit_state(
            &repository.paths,
            &mut journal,
            fresh_default_state().expect("default state"),
        )
        .expect("initial state commit");
        let before = read_pointer_optional(&repository.paths.current_pointer)
            .expect("read initial pointer")
            .expect("initial pointer");

        let mut after_state = original;
        after_state.revision = next_revision().expect("next revision");
        after_state.global["game"] = Value::String("NTE".to_string());
        let generation_bytes = serialize_pretty(&after_state).expect("serialize after state");
        let after = GenerationPointer {
            generation: after_state.revision.clone(),
            sha256: sha256_hex(&generation_bytes),
        };
        let plan = StateTransactionPlan {
            before: Some(before.clone()),
            after: after.clone(),
        };
        let transaction_id = journal
            .begin(&serde_json::to_vec(&plan).expect("serialize transaction plan"))
            .expect("begin state transaction");
        atomic_write(
            &generation_path(&repository.paths, &after.generation).expect("generation path"),
            &generation_bytes,
        )
        .expect("write after generation");
        journal
            .append(transaction_id, WalState::Committing, b"generation-written")
            .expect("record generation");
        write_pointer(&repository.paths.previous_pointer, &before).expect("write previous pointer");
        journal
            .append(
                transaction_id,
                WalState::StepReceipt,
                b"previous-pointer-written",
            )
            .expect("record previous pointer");
        write_pointer(&repository.paths.current_pointer, &after).expect("write current pointer");
        journal
            .append(
                transaction_id,
                WalState::StepReceipt,
                b"current-pointer-written",
            )
            .expect("record current pointer");
        journal
            .append(
                transaction_id,
                WalState::CommittedAfter,
                b"state-pointer-committed",
            )
            .expect("commit state pointer");
        drop(journal);
        fs::remove_file(repository.paths.runtime_root.join("config.json"))
            .expect("remove runtime projection");

        let status = repository.bootstrap();

        assert!(matches!(status, BootstrapStatus::Ready { .. }));
        let projected: Value = serde_json::from_slice(
            &fs::read(repository.paths.runtime_root.join("config.json"))
                .expect("read recovered projection"),
        )
        .expect("parse recovered projection");
        assert_eq!(projected["game"], "NTE");
        let mut reopened =
            WalJournal::open_app_state(&repository.paths.wal_path).expect("reopen recovered WAL");
        assert!(reopened
            .incomplete_transaction()
            .expect("inspect recovered WAL")
            .is_none());
    }

    #[test]
    fn app_state_reader_rejects_nte_wal_domain() {
        let temp = TempDir::new().expect("temp WAL");
        let wal_path = temp.path().join("foreign.wal");
        let mut nte_journal = WalJournal::open(&wal_path).expect("open NTE WAL");
        nte_journal.begin(b"{}").expect("write NTE WAL record");
        drop(nte_journal);

        assert!(WalJournal::open_app_state(&wal_path).is_err());
    }

    #[test]
    fn scoped_revision_save_is_atomic_and_rejects_stale_writers() {
        let temp = TempDir::new().expect("temp repository");
        let repository = AppStateRepository::new(
            temp.path().join("control"),
            temp.path().join("legacy"),
            true,
        );
        assert!(matches!(
            repository.bootstrap(),
            BootstrapStatus::Ready { .. }
        ));
        let loaded = repository.load_config(Some("WW")).expect("load WW config");
        let mut global = loaded.global.clone();
        global["game"] = Value::String("WW".to_string());
        let mut game = loaded.game.clone().expect("WW game config");
        game["sourceDir"] = Value::String(r"D:\Fixture\WW\Changed".to_string());

        let saved = repository
            .save_config(
                Some(global.clone()),
                Some(game.clone()),
                Some(loaded.global_revision),
                loaded.game_revision,
            )
            .expect("save scoped configs");

        assert_eq!(saved.global_revision, loaded.global_revision + 1);
        assert_eq!(
            saved.game_revision,
            loaded.game_revision.map(|value| value + 1)
        );
        assert_eq!(saved.global, global);
        assert_eq!(saved.game, Some(game));
        let stale_error = repository
            .save_config(
                Some(loaded.global),
                None,
                Some(loaded.global_revision),
                None,
            )
            .expect_err("stale global writer must fail");
        assert!(stale_error.contains("changed while this update was pending"));
        assert_eq!(
            repository
                .load_config(None)
                .expect("reload current global")
                .global,
            global
        );
    }

    #[test]
    fn mod_mutation_preflight_hashes_configs_without_writing_state() {
        let temp = TempDir::new().expect("temp repository");
        let repository = AppStateRepository::new(
            temp.path().join("control"),
            temp.path().join("legacy"),
            true,
        );
        assert!(matches!(
            repository.bootstrap(),
            BootstrapStatus::Ready { .. }
        ));
        let before = repository.load_config(Some("WW")).expect("load WW config");
        let mut after_game = before.game.clone().expect("WW game config");
        after_game["data"] = serde_json::json!({
            "Characters/Demo": {
                "source": "https://gamebanana.com/mods/42",
                "gameBanana": {
                    "provider": "gamebanana",
                    "modId": 42,
                    "profileUrl": "https://gamebanana.com/mods/42",
                    "variant": "primary",
                    "boundAt": 1000
                }
            }
        });
        let expected_revision = before.game_revision.expect("game revision");

        let preflight = repository
            .preflight_game_config_update("WW", &after_game, expected_revision)
            .expect("preflight");

        assert_ne!(
            preflight.before_game_config_hash,
            preflight.after_game_config_hash
        );
        let unchanged = repository
            .load_config(Some("WW"))
            .expect("unchanged WW config");
        assert_eq!(unchanged.game_revision, before.game_revision);
        assert_eq!(unchanged.game, before.game);
        let stale = repository
            .preflight_game_config_update("WW", &after_game, expected_revision + 1)
            .expect_err("stale preflight must fail");
        assert!(stale.contains("changed while this Mod mutation was pending"));
    }

    #[test]
    fn coordinated_nte_mutation_is_adopted_into_the_state_generation() {
        let temp = TempDir::new().expect("temp repository");
        let repository = AppStateRepository::new(
            temp.path().join("control"),
            temp.path().join("legacy"),
            true,
        );
        assert!(matches!(
            repository.bootstrap(),
            BootstrapStatus::Ready { .. }
        ));
        let before = repository
            .load_config(Some("NTE"))
            .expect("load NTE config");

        repository
            .coordinate_runtime_game_mutation("NTE", |runtime_root| {
                let path = runtime_root.join("configNTE.json");
                let mut config: Value = serde_json::from_slice(
                    &fs::read(&path).map_err(|err| format!("read NTE projection: {err}"))?,
                )
                .map_err(|err| format!("parse NTE projection: {err}"))?;
                config["updatedAt"] = Value::String("coordinated-revision".to_string());
                atomic_write(&path, &serialize_pretty(&config)?)
            })
            .expect("coordinate NTE mutation");

        let after = repository
            .load_config(Some("NTE"))
            .expect("reload NTE config");
        assert_eq!(
            after.game.expect("NTE config")["updatedAt"],
            "coordinated-revision"
        );
        assert_eq!(
            after.game_revision,
            before.game_revision.map(|value| value + 1)
        );
    }

    #[test]
    fn divergent_runtime_projection_fails_closed_without_overwrite() {
        let temp = TempDir::new().expect("temp repository");
        let repository = AppStateRepository::new(
            temp.path().join("control"),
            temp.path().join("legacy"),
            true,
        );
        assert!(matches!(
            repository.bootstrap(),
            BootstrapStatus::Ready { .. }
        ));
        let projection_path = repository.paths.runtime_root.join("configNTE.json");
        let mut divergent: Value =
            serde_json::from_slice(&fs::read(&projection_path).expect("read NTE projection"))
                .expect("parse NTE projection");
        divergent["updatedAt"] = Value::String("orphaned-native-commit".to_string());
        let divergent_bytes = serialize_pretty(&divergent).expect("serialize divergent config");
        atomic_write(&projection_path, &divergent_bytes).expect("write divergent projection");

        let status = repository.bootstrap();

        assert!(matches!(
            status,
            BootstrapStatus::RecoveryRequired { ref error, .. }
                if error.contains("diverges from the committed application state")
        ));
        assert_eq!(
            fs::read(&projection_path).expect("read preserved divergent projection"),
            divergent_bytes
        );
    }

    #[test]
    fn reset_preserves_a_verified_generation_and_commits_bundled_defaults() {
        let temp = TempDir::new().expect("temp repository");
        let repository = AppStateRepository::new(
            temp.path().join("control"),
            temp.path().join("legacy"),
            true,
        );
        assert!(matches!(
            repository.bootstrap(),
            BootstrapStatus::Ready { .. }
        ));
        let loaded = repository.load_config(Some("WW")).expect("load defaults");
        let mut global = loaded.global;
        global["game"] = Value::String("WW".to_string());
        let mut game = loaded.game.expect("WW config");
        game["sourceDir"] = Value::String(r"D:\Fixture\Reset\Library".to_string());
        repository
            .save_config(
                Some(global),
                Some(game),
                Some(loaded.global_revision),
                loaded.game_revision,
            )
            .expect("save reset fixture");
        let before = read_pointer_optional(&repository.paths.current_pointer)
            .expect("read current pointer")
            .expect("current pointer");

        let reset = repository.reset_with_backup().expect("reset state");

        assert_eq!(reset.global["game"], "");
        let previous = read_pointer_optional(&repository.paths.previous_pointer)
            .expect("read previous pointer")
            .expect("previous pointer");
        assert_eq!(previous, before);
        assert!(generation_path(&repository.paths, &before.generation)
            .expect("generation path")
            .is_file());
        let backups = fs::read_dir(&repository.paths.reset_backups_root)
            .expect("read reset backups")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect reset backups");
        assert_eq!(backups.len(), 1);
        let manifest: ResetBackupManifest = serde_json::from_slice(
            &fs::read(backups[0].path()).expect("read reset backup manifest"),
        )
        .expect("parse reset backup manifest");
        assert_eq!(manifest.generation, before.generation);
        assert_eq!(manifest.sha256, before.sha256);
    }

    #[test]
    fn reset_recovers_from_a_divergent_runtime_projection() {
        let temp = TempDir::new().expect("temp repository");
        let repository = AppStateRepository::new(
            temp.path().join("control"),
            temp.path().join("legacy"),
            true,
        );
        assert!(matches!(
            repository.bootstrap(),
            BootstrapStatus::Ready { .. }
        ));
        let projection_path = repository.paths.runtime_root.join("configWW.json");
        let mut divergent: Value =
            serde_json::from_slice(&fs::read(&projection_path).expect("read WW projection"))
                .expect("parse WW projection");
        divergent["sourceDir"] = Value::String(r"D:\Orphaned\Runtime".to_string());
        atomic_write(
            &projection_path,
            &serialize_pretty(&divergent).expect("serialize divergent projection"),
        )
        .expect("write divergent projection");
        assert!(matches!(
            repository.bootstrap(),
            BootstrapStatus::RecoveryRequired { .. }
        ));

        repository
            .reset_with_backup()
            .expect("reset recovery state");

        assert!(matches!(repository.status(), BootstrapStatus::Ready { .. }));
        let defaults = repository
            .load_config(Some("WW"))
            .expect("load reset defaults");
        assert_eq!(defaults.game.expect("WW defaults")["sourceDir"], "");
    }

    #[test]
    #[ignore = "requires IMM_VERIFIED_SNAPSHOT_PATH"]
    fn imports_external_verified_snapshot_from_a_temporary_copy() {
        let source = PathBuf::from(
            std::env::var_os("IMM_VERIFIED_SNAPSHOT_PATH")
                .expect("IMM_VERIFIED_SNAPSHOT_PATH must name a verified snapshot"),
        );
        let before = tree_hashes(&source);
        let temp = TempDir::new().expect("temporary external snapshot repository");
        let control_root = temp.path().join("control");
        let copied_snapshot = control_root.join(
            source
                .file_name()
                .expect("external snapshot directory name"),
        );
        copy_tree(&source, &copied_snapshot);
        let repository = AppStateRepository::new(
            control_root,
            temp.path().join("legacy-does-not-exist"),
            false,
        );

        let status = repository.bootstrap();

        assert!(
            matches!(status, BootstrapStatus::Ready { .. }),
            "{status:?}"
        );
        assert_eq!(tree_hashes(&source), before);
    }

    #[test]
    fn gamebanana_binding_schema_rejects_duplicate_primary_ids() {
        let mut config = fixture_game_config("WW");
        config["data"] = serde_json::json!({
            "Characters/Primary A": {
                "source": "https://gamebanana.com/mods/42",
                "gameBanana": {
                    "provider": "gamebanana",
                    "modId": 42,
                    "profileUrl": "https://gamebanana.com/mods/42",
                    "variant": "primary",
                    "boundAt": 1000
                }
            },
            "Characters/Primary B": {
                "source": "https://gamebanana.com/Mod/42",
                "gameBanana": {
                    "provider": "gamebanana",
                    "modId": 42,
                    "profileUrl": "https://gamebanana.com/Mod/42",
                    "variant": "primary",
                    "boundAt": 1001
                }
            }
        });

        let error = validate_game_config(&config, "WW")
            .expect_err("duplicate primary GameBanana IDs must fail");
        assert!(error.contains("multiple primary bindings"), "{error}");
    }

    #[test]
    fn gamebanana_binding_schema_allows_an_explicit_independent_variant() {
        let mut config = fixture_game_config("WW");
        config["data"] = serde_json::json!({
            "Characters/Primary": {
                "source": "https://gamebanana.com/mods/42",
                "gameBanana": {
                    "provider": "gamebanana",
                    "modId": 42,
                    "profileUrl": "https://gamebanana.com/mods/42",
                    "variant": "primary",
                    "boundAt": 1000
                }
            },
            "Characters/Variant": {
                "source": "https://gamebanana.com/Mod/42",
                "gameBanana": {
                    "provider": "gamebanana",
                    "modId": 42,
                    "profileUrl": "https://gamebanana.com/Mod/42",
                    "variant": "independent",
                    "boundAt": 1001,
                    "selectedFile": {
                        "id": "7",
                        "name": "variant.zip",
                        "size": 1200,
                        "updatedAt": 100
                    }
                }
            }
        });

        validate_game_config(&config, "WW").expect("explicit independent variant is valid");
    }
}

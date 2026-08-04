use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use winapi::shared::minwindef::HKEY;
use winapi::shared::winerror::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
};
use winapi::um::winnt::{
    KEY_READ, KEY_WOW64_64KEY, KEY_WRITE, REG_BINARY, REG_DWORD, REG_EXPAND_SZ,
    REG_OPTION_NON_VOLATILE,
};
use winapi::um::winreg::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegFlushKey, RegOpenKeyExW, RegQueryValueExW,
    RegSetValueExW, HKEY_LOCAL_MACHINE,
};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

const SCHEMA_VERSION: u16 = 1;
const MAX_REGISTRY_VALUE_BYTES: usize = 64 * 1024;
const MUTEX_WAIT_MILLISECONDS: u32 = 30_000;
const OWNER_KEY_PATH: &str = r"SOFTWARE\jp.bhatt.wwmm\WerLocalDumps";
const OWNER_STATE_VALUE: &str = "OwnerState";
const TRANSACTION_VALUE: &str = "PendingTransaction";
const WER_ROOT_PATH: &str = r"SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps";
const WER_MUTEX_NAME: &str = r"Global\jp.bhatt.wwmm.wer-local-dumps";
const DUMP_FOLDER_TEMPLATE: &str =
    r"%LOCALAPPDATA%\Integrated Mod Manager (IMM) Data\diagnostics\dumps";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WerRegistryAction {
    Configure,
    Remove,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WerRegistryStatus {
    pub(crate) available: bool,
    pub(crate) state: String,
    pub(crate) current_install_registered: bool,
    pub(crate) owner_count: usize,
    pub(crate) dump_folder_template: String,
}

impl WerRegistryStatus {
    pub(crate) fn unsupported_build() -> Self {
        Self {
            available: false,
            state: "unsupported_build".to_string(),
            current_install_registered: false,
            owner_count: 0,
            dump_folder_template: DUMP_FOLDER_TEMPLATE.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct RegistryValue {
    value_type: u32,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
enum OptionalRegistryValue {
    Missing,
    Present(RegistryValue),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct WerState {
    dump_folder: OptionalRegistryValue,
    dump_count: OptionalRegistryValue,
    dump_type: OptionalRegistryValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct OwnerState {
    schema_version: u16,
    executable_name: String,
    before: WerState,
    managed: WerState,
    owners: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
enum TransactionPhase {
    Prepared,
    WerApplied,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct RegistryTransaction {
    schema_version: u16,
    operation_id: String,
    phase: TransactionPhase,
    before_owner: Option<OwnerState>,
    after_owner: Option<OwnerState>,
    before_wer: WerState,
    after_wer: WerState,
}

#[derive(Debug)]
struct OwnedRegistryKey(HKEY);

impl Drop for OwnedRegistryKey {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

#[derive(Debug)]
struct RegistryMutex {
    handle: HANDLE,
}

impl RegistryMutex {
    fn acquire() -> Result<Self, String> {
        let name = wide_null(WER_MUTEX_NAME);
        let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(last_error("Unable to create the WER ownership mutex"));
        }
        let result = unsafe { WaitForSingleObject(handle, MUTEX_WAIT_MILLISECONDS) };
        if result != WAIT_OBJECT_0 && result != WAIT_ABANDONED {
            unsafe {
                CloseHandle(handle);
            }
            return Err(if result == windows_sys::Win32::Foundation::WAIT_TIMEOUT {
                "Timed out waiting for the WER ownership mutex".to_string()
            } else {
                last_error("Unable to acquire the WER ownership mutex")
            });
        }
        Ok(Self { handle })
    }
}

impl Drop for RegistryMutex {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
    }
}

pub(crate) fn execute(
    action: WerRegistryAction,
    executable_name: &str,
    image_key: &str,
) -> Result<(), String> {
    validate_executable_name(executable_name)?;
    if image_key.is_empty() {
        return Err("The WER owner image identity is empty".to_string());
    }
    let _mutex = RegistryMutex::acquire()?;
    let owner_key = match action {
        WerRegistryAction::Configure => create_registry_key(OWNER_KEY_PATH)?,
        WerRegistryAction::Remove => {
            let Some(key) =
                open_registry_key(OWNER_KEY_PATH, KEY_READ | KEY_WRITE | KEY_WOW64_64KEY)?
            else {
                return Ok(());
            };
            key
        }
    };
    recover_pending_transaction(&owner_key, executable_name)?;

    let current_owner: Option<OwnerState> = read_json_value(&owner_key, OWNER_STATE_VALUE)?;
    validate_owner_state(current_owner.as_ref(), executable_name)?;
    let current_wer = read_wer_state(executable_name)?;
    let owner_id = owner_id(image_key);
    let transaction = match action {
        WerRegistryAction::Configure => {
            plan_configure(current_owner, current_wer, executable_name, owner_id)?
        }
        WerRegistryAction::Remove => {
            let Some(transaction) = plan_remove(current_owner, current_wer, &owner_id)? else {
                return Ok(());
            };
            transaction
        }
    };
    execute_transaction(&owner_key, executable_name, transaction)
}

pub(crate) fn status(executable_name: &str, image_key: &str) -> Result<WerRegistryStatus, String> {
    validate_executable_name(executable_name)?;
    if image_key.is_empty() {
        return Err("The WER owner image identity is empty".to_string());
    }
    let current_wer = read_wer_state(executable_name)?;
    let Some(owner_key) = open_registry_key(OWNER_KEY_PATH, KEY_READ | KEY_WOW64_64KEY)? else {
        return Ok(WerRegistryStatus {
            available: true,
            state: if current_wer.all_missing() {
                "disabled"
            } else {
                "unmanaged"
            }
            .to_string(),
            current_install_registered: false,
            owner_count: 0,
            dump_folder_template: DUMP_FOLDER_TEMPLATE.to_string(),
        });
    };
    if read_json_value::<RegistryTransaction>(&owner_key, TRANSACTION_VALUE)?.is_some() {
        return Ok(WerRegistryStatus {
            available: true,
            state: "recovery_required".to_string(),
            current_install_registered: false,
            owner_count: 0,
            dump_folder_template: DUMP_FOLDER_TEMPLATE.to_string(),
        });
    }
    let owner: Option<OwnerState> = read_json_value(&owner_key, OWNER_STATE_VALUE)?;
    let Some(owner) = owner else {
        return Ok(WerRegistryStatus {
            available: true,
            state: if current_wer.all_missing() {
                "disabled"
            } else {
                "unmanaged"
            }
            .to_string(),
            current_install_registered: false,
            owner_count: 0,
            dump_folder_template: DUMP_FOLDER_TEMPLATE.to_string(),
        });
    };
    validate_owner_state(Some(&owner), executable_name)?;
    let current_install_registered = owner.owners.contains(&owner_id(image_key));
    Ok(WerRegistryStatus {
        available: true,
        state: if current_wer != owner.managed {
            "drifted"
        } else if current_install_registered {
            "enabled"
        } else {
            "managed_by_other_install"
        }
        .to_string(),
        current_install_registered,
        owner_count: owner.owners.len(),
        dump_folder_template: DUMP_FOLDER_TEMPLATE.to_string(),
    })
}

fn plan_configure(
    current_owner: Option<OwnerState>,
    current_wer: WerState,
    executable_name: &str,
    owner_id: String,
) -> Result<RegistryTransaction, String> {
    let managed = managed_wer_state();
    let after_owner = match current_owner.as_ref() {
        Some(owner) => {
            if current_wer != owner.managed {
                return Err(
                    "The current WER values no longer match the IMM-managed state; refusing to overwrite them"
                        .to_string(),
                );
            }
            let mut after = owner.clone();
            if !after.owners.contains(&owner_id) {
                after.owners.push(owner_id);
                after.owners.sort();
            }
            after
        }
        None => {
            if !current_wer.all_missing() {
                return Err(
                    "WER values already exist without an IMM ownership record; refusing to overwrite them"
                        .to_string(),
                );
            }
            OwnerState {
                schema_version: SCHEMA_VERSION,
                executable_name: executable_name.to_string(),
                before: current_wer.clone(),
                managed: managed.clone(),
                owners: vec![owner_id],
            }
        }
    };
    Ok(RegistryTransaction::new(
        current_owner,
        Some(after_owner),
        current_wer,
        managed,
    ))
}

fn plan_remove(
    current_owner: Option<OwnerState>,
    current_wer: WerState,
    owner_id: &str,
) -> Result<Option<RegistryTransaction>, String> {
    let Some(owner) = current_owner else {
        return Ok(None);
    };
    if !owner.owners.iter().any(|candidate| candidate == owner_id) {
        return Ok(None);
    }
    if current_wer != owner.managed {
        return Err(
            "The current WER values no longer match the IMM-managed state; ownership evidence was preserved"
                .to_string(),
        );
    }

    let mut after_owner = owner.clone();
    after_owner.owners.retain(|candidate| candidate != owner_id);
    let (after_owner, after_wer) = if after_owner.owners.is_empty() {
        (None, owner.before.clone())
    } else {
        (Some(after_owner), owner.managed.clone())
    };
    Ok(Some(RegistryTransaction::new(
        Some(owner),
        after_owner,
        current_wer,
        after_wer,
    )))
}

impl RegistryTransaction {
    fn new(
        before_owner: Option<OwnerState>,
        after_owner: Option<OwnerState>,
        before_wer: WerState,
        after_wer: WerState,
    ) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            operation_id: format!(
                "{}-{}",
                unsafe { windows_sys::Win32::System::Threading::GetCurrentProcessId() },
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            phase: TransactionPhase::Prepared,
            before_owner,
            after_owner,
            before_wer,
            after_wer,
        }
    }
}

fn execute_transaction(
    owner_key: &OwnedRegistryKey,
    executable_name: &str,
    mut transaction: RegistryTransaction,
) -> Result<(), String> {
    write_json_value(owner_key, TRANSACTION_VALUE, &transaction)?;
    flush_key(owner_key, "Unable to flush the prepared WER transaction")?;

    apply_wer_state(executable_name, &transaction.after_wer)?;
    transaction.phase = TransactionPhase::WerApplied;
    write_json_value(owner_key, TRANSACTION_VALUE, &transaction)?;
    flush_key(owner_key, "Unable to flush the applied WER transaction")?;

    write_owner_state(owner_key, transaction.after_owner.as_ref())?;
    transaction.phase = TransactionPhase::Committed;
    write_json_value(owner_key, TRANSACTION_VALUE, &transaction)?;
    flush_key(owner_key, "Unable to flush the committed WER transaction")?;
    cleanup_transaction(owner_key)
}

fn recover_pending_transaction(
    owner_key: &OwnedRegistryKey,
    executable_name: &str,
) -> Result<(), String> {
    let Some(mut transaction) =
        read_json_value::<RegistryTransaction>(owner_key, TRANSACTION_VALUE)?
    else {
        return Ok(());
    };
    validate_transaction(&transaction, executable_name)?;
    let current_owner: Option<OwnerState> = read_json_value(owner_key, OWNER_STATE_VALUE)?;
    let current_wer = read_wer_state(executable_name)?;

    match transaction.phase {
        TransactionPhase::Prepared | TransactionPhase::WerApplied => {
            if current_owner != transaction.before_owner && current_owner != transaction.after_owner
            {
                return Err(
                    "WER recovery found an unknown owner state; the pending transaction was preserved"
                        .to_string(),
                );
            }
            if !current_wer.componentwise_between(&transaction.before_wer, &transaction.after_wer) {
                return Err(
                    "WER recovery found unknown registry values; the pending transaction was preserved"
                        .to_string(),
                );
            }
            apply_wer_state(executable_name, &transaction.after_wer)?;
            transaction.phase = TransactionPhase::WerApplied;
            write_json_value(owner_key, TRANSACTION_VALUE, &transaction)?;
            flush_key(owner_key, "Unable to flush recovered WER values")?;
            write_owner_state(owner_key, transaction.after_owner.as_ref())?;
            transaction.phase = TransactionPhase::Committed;
            write_json_value(owner_key, TRANSACTION_VALUE, &transaction)?;
            flush_key(owner_key, "Unable to flush recovered WER ownership")?;
            cleanup_transaction(owner_key)
        }
        TransactionPhase::Committed => {
            if current_owner != transaction.after_owner || current_wer != transaction.after_wer {
                return Err(
                    "A committed WER transaction no longer matches registry state; evidence was preserved"
                        .to_string(),
                );
            }
            cleanup_transaction(owner_key)
        }
    }
}

fn validate_transaction(
    transaction: &RegistryTransaction,
    executable_name: &str,
) -> Result<(), String> {
    if transaction.schema_version != SCHEMA_VERSION || transaction.operation_id.is_empty() {
        return Err("The pending WER transaction has an unsupported schema".to_string());
    }
    if transaction.operation_id.len() > 128
        || !transaction
            .operation_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
    {
        return Err("The pending WER transaction operation ID is invalid".to_string());
    }
    validate_owner_state(transaction.before_owner.as_ref(), executable_name)?;
    validate_owner_state(transaction.after_owner.as_ref(), executable_name)?;

    match transaction.before_owner.as_ref() {
        Some(owner) if transaction.before_wer != owner.managed => {
            return Err("The pending WER transaction before-state is inconsistent".to_string())
        }
        None if !transaction.before_wer.all_missing() => {
            return Err(
                "The pending first-owner WER transaction has an unknown before-state".to_string(),
            )
        }
        _ => {}
    }
    match transaction.after_owner.as_ref() {
        Some(owner) if transaction.after_wer != owner.managed => {
            return Err(
                "The pending WER transaction managed after-state is inconsistent".to_string(),
            )
        }
        Some(owner) => {
            if let Some(before) = transaction.before_owner.as_ref() {
                if before.before != owner.before
                    || before.managed != owner.managed
                    || before.executable_name != owner.executable_name
                {
                    return Err(
                        "The pending WER transaction changed immutable ownership state".to_string(),
                    );
                }
            } else if owner.before != transaction.before_wer {
                return Err(
                    "The pending first-owner WER transaction did not preserve before-state"
                        .to_string(),
                );
            }
        }
        None => {
            let before = transaction.before_owner.as_ref().ok_or_else(|| {
                "The pending WER transaction removed an owner state that never existed".to_string()
            })?;
            if transaction.after_wer != before.before {
                return Err(
                    "The pending last-owner WER transaction did not restore before-state"
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

fn validate_owner_state(owner: Option<&OwnerState>, executable_name: &str) -> Result<(), String> {
    let Some(owner) = owner else {
        return Ok(());
    };
    let mut normalized_owners = owner.owners.clone();
    normalized_owners.sort();
    normalized_owners.dedup();
    if owner.schema_version != SCHEMA_VERSION
        || !owner.executable_name.eq_ignore_ascii_case(executable_name)
        || owner.owners.is_empty()
        || normalized_owners != owner.owners
        || owner.owners.iter().any(|value| {
            value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        || owner.managed != managed_wer_state()
    {
        return Err(
            "The WER ownership state is invalid or belongs to another executable".to_string(),
        );
    }
    Ok(())
}

impl WerState {
    fn all_missing(&self) -> bool {
        matches!(self.dump_folder, OptionalRegistryValue::Missing)
            && matches!(self.dump_count, OptionalRegistryValue::Missing)
            && matches!(self.dump_type, OptionalRegistryValue::Missing)
    }

    fn componentwise_between(&self, before: &Self, after: &Self) -> bool {
        (self.dump_folder == before.dump_folder || self.dump_folder == after.dump_folder)
            && (self.dump_count == before.dump_count || self.dump_count == after.dump_count)
            && (self.dump_type == before.dump_type || self.dump_type == after.dump_type)
    }
}

fn managed_wer_state() -> WerState {
    WerState {
        dump_folder: OptionalRegistryValue::Present(RegistryValue {
            value_type: REG_EXPAND_SZ,
            bytes: utf16_registry_bytes(DUMP_FOLDER_TEMPLATE),
        }),
        dump_count: OptionalRegistryValue::Present(RegistryValue {
            value_type: REG_DWORD,
            bytes: 3u32.to_le_bytes().to_vec(),
        }),
        dump_type: OptionalRegistryValue::Present(RegistryValue {
            value_type: REG_DWORD,
            bytes: 1u32.to_le_bytes().to_vec(),
        }),
    }
}

fn read_wer_state(executable_name: &str) -> Result<WerState, String> {
    let path = format!(r"{WER_ROOT_PATH}\{executable_name}");
    let Some(key) = open_registry_key(&path, KEY_READ | KEY_WOW64_64KEY)? else {
        return Ok(WerState {
            dump_folder: OptionalRegistryValue::Missing,
            dump_count: OptionalRegistryValue::Missing,
            dump_type: OptionalRegistryValue::Missing,
        });
    };
    Ok(WerState {
        dump_folder: read_registry_value(&key, "DumpFolder")?,
        dump_count: read_registry_value(&key, "DumpCount")?,
        dump_type: read_registry_value(&key, "DumpType")?,
    })
}

fn apply_wer_state(executable_name: &str, state: &WerState) -> Result<(), String> {
    let path = format!(r"{WER_ROOT_PATH}\{executable_name}");
    let key = create_registry_key(&path)?;
    apply_registry_value(&key, "DumpFolder", &state.dump_folder)?;
    apply_registry_value(&key, "DumpCount", &state.dump_count)?;
    apply_registry_value(&key, "DumpType", &state.dump_type)?;
    flush_key(&key, "Unable to flush the WER LocalDumps key")
}

fn read_registry_value(
    key: &OwnedRegistryKey,
    value_name: &str,
) -> Result<OptionalRegistryValue, String> {
    let name = wide_null(value_name);
    let mut value_type = 0u32;
    let mut length = 0u32;
    let first = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            null_mut(),
            &mut value_type,
            null_mut(),
            &mut length,
        )
    };
    if first as u32 == ERROR_FILE_NOT_FOUND {
        return Ok(OptionalRegistryValue::Missing);
    }
    if first as u32 != ERROR_SUCCESS && first as u32 != ERROR_MORE_DATA {
        return Err(registry_error(
            "Unable to size a registry value",
            first as u32,
        ));
    }
    if length as usize > MAX_REGISTRY_VALUE_BYTES {
        return Err("A WER registry value exceeds the ownership snapshot limit".to_string());
    }
    let mut bytes = vec![0u8; length as usize];
    if length > 0 {
        let mut actual = length;
        let second = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                null_mut(),
                &mut value_type,
                bytes.as_mut_ptr(),
                &mut actual,
            )
        };
        if second as u32 != ERROR_SUCCESS {
            return Err(registry_error(
                "Unable to read a registry value",
                second as u32,
            ));
        }
        bytes.truncate(actual as usize);
    }
    Ok(OptionalRegistryValue::Present(RegistryValue {
        value_type,
        bytes,
    }))
}

fn apply_registry_value(
    key: &OwnedRegistryKey,
    name: &str,
    value: &OptionalRegistryValue,
) -> Result<(), String> {
    let name = wide_null(name);
    match value {
        OptionalRegistryValue::Missing => {
            let result = unsafe { RegDeleteValueW(key.0, name.as_ptr()) };
            if result as u32 == ERROR_SUCCESS || result as u32 == ERROR_FILE_NOT_FOUND {
                Ok(())
            } else {
                Err(registry_error(
                    "Unable to remove a WER registry value",
                    result as u32,
                ))
            }
        }
        OptionalRegistryValue::Present(value) => {
            let result = unsafe {
                RegSetValueExW(
                    key.0,
                    name.as_ptr(),
                    0,
                    value.value_type,
                    value.bytes.as_ptr(),
                    value.bytes.len() as u32,
                )
            };
            if result as u32 == ERROR_SUCCESS {
                Ok(())
            } else {
                Err(registry_error(
                    "Unable to write a WER registry value",
                    result as u32,
                ))
            }
        }
    }
}

fn open_registry_key(path: &str, access: u32) -> Result<Option<OwnedRegistryKey>, String> {
    let path = wide_null(path);
    let mut key = null_mut();
    let result = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, access, &mut key) };
    if result as u32 == ERROR_FILE_NOT_FOUND || result as u32 == ERROR_PATH_NOT_FOUND {
        Ok(None)
    } else if result as u32 == ERROR_SUCCESS && !key.is_null() {
        Ok(Some(OwnedRegistryKey(key)))
    } else {
        Err(registry_error(
            "Unable to open a registry key",
            result as u32,
        ))
    }
}

fn create_registry_key(path: &str) -> Result<OwnedRegistryKey, String> {
    let path = wide_null(path);
    let mut key = null_mut();
    let mut disposition = 0u32;
    let result = unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            0,
            null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_READ | KEY_WRITE | KEY_WOW64_64KEY,
            null_mut(),
            &mut key,
            &mut disposition,
        )
    };
    if result as u32 == ERROR_SUCCESS && !key.is_null() {
        Ok(OwnedRegistryKey(key))
    } else {
        Err(registry_error(
            "Unable to create a registry key",
            result as u32,
        ))
    }
}

fn read_json_value<T>(key: &OwnedRegistryKey, name: &str) -> Result<Option<T>, String>
where
    T: for<'de> Deserialize<'de>,
{
    match read_registry_value(key, name)? {
        OptionalRegistryValue::Missing => Ok(None),
        OptionalRegistryValue::Present(value) if value.value_type == REG_BINARY => {
            serde_json::from_slice(&value.bytes)
                .map(Some)
                .map_err(|error| format!("Invalid WER ownership state: {error}"))
        }
        OptionalRegistryValue::Present(_) => {
            Err("A WER ownership value has an unexpected registry type".to_string())
        }
    }
}

fn write_json_value<T>(key: &OwnedRegistryKey, name: &str, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("Unable to serialize WER ownership state: {error}"))?;
    if bytes.len() > MAX_REGISTRY_VALUE_BYTES {
        return Err("The WER ownership state exceeds the registry limit".to_string());
    }
    apply_registry_value(
        key,
        name,
        &OptionalRegistryValue::Present(RegistryValue {
            value_type: REG_BINARY,
            bytes,
        }),
    )
}

fn write_owner_state(key: &OwnedRegistryKey, owner: Option<&OwnerState>) -> Result<(), String> {
    match owner {
        Some(owner) => write_json_value(key, OWNER_STATE_VALUE, owner),
        None => apply_registry_value(key, OWNER_STATE_VALUE, &OptionalRegistryValue::Missing),
    }
}

fn cleanup_transaction(key: &OwnedRegistryKey) -> Result<(), String> {
    apply_registry_value(key, TRANSACTION_VALUE, &OptionalRegistryValue::Missing)?;
    flush_key(key, "Unable to remove the completed WER transaction")
}

fn flush_key(key: &OwnedRegistryKey, context: &str) -> Result<(), String> {
    let result = unsafe { RegFlushKey(key.0) };
    if result as u32 == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(registry_error(context, result as u32))
    }
}

fn owner_id(image_key: &str) -> String {
    format!("{:x}", Sha256::digest(image_key.as_bytes()))
}

fn validate_executable_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 260
        || !name.to_ascii_lowercase().ends_with(".exe")
        || name.contains(['\\', '/', ':'])
    {
        Err("Invalid executable name for WER LocalDumps".to_string())
    } else {
        Ok(())
    }
}

fn utf16_registry_bytes(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect()
}

fn wide_null(value: impl AsRef<OsStr>) -> Vec<u16> {
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn registry_error(context: &str, code: u32) -> String {
    format!(
        "{context}: {}",
        std::io::Error::from_raw_os_error(code as i32)
    )
}

fn last_error(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn missing() -> WerState {
        WerState {
            dump_folder: OptionalRegistryValue::Missing,
            dump_count: OptionalRegistryValue::Missing,
            dump_type: OptionalRegistryValue::Missing,
        }
    }

    fn owner(before: WerState, owners: &[&str]) -> OwnerState {
        OwnerState {
            schema_version: SCHEMA_VERSION,
            executable_name: "imm.exe".to_string(),
            before,
            managed: managed_wer_state(),
            owners: owners.iter().map(|value| (*value).to_string()).collect(),
        }
    }

    #[test]
    fn configure_refuses_unknown_existing_values() {
        let mut existing = missing();
        existing.dump_type = OptionalRegistryValue::Present(RegistryValue {
            value_type: REG_DWORD,
            bytes: 2u32.to_le_bytes().to_vec(),
        });
        assert!(plan_configure(None, existing, "imm.exe", "a".repeat(64)).is_err());
    }

    #[test]
    fn configure_is_idempotent_and_tracks_distinct_owners() {
        let first = plan_configure(None, missing(), "imm.exe", "a".repeat(64)).unwrap();
        let first_owner = first.after_owner.unwrap();
        let second = plan_configure(
            Some(first_owner.clone()),
            managed_wer_state(),
            "imm.exe",
            "a".repeat(64),
        )
        .unwrap();
        assert_eq!(second.after_owner.as_ref().unwrap().owners.len(), 1);

        let third = plan_configure(
            Some(first_owner),
            managed_wer_state(),
            "imm.exe",
            "b".repeat(64),
        )
        .unwrap();
        assert_eq!(third.after_owner.as_ref().unwrap().owners.len(), 2);
    }

    #[test]
    fn final_owner_removal_restores_the_exact_before_state() {
        let before = missing();
        let current_owner = owner(before.clone(), &[&"a".repeat(64)]);
        let transaction = plan_remove(Some(current_owner), managed_wer_state(), &"a".repeat(64))
            .unwrap()
            .unwrap();
        assert!(transaction.after_owner.is_none());
        assert_eq!(transaction.after_wer, before);
    }

    #[test]
    fn recovery_only_accepts_values_from_the_recorded_before_after_pair() {
        let before = missing();
        let after = managed_wer_state();
        let mut mixed = before.clone();
        mixed.dump_type = after.dump_type.clone();
        assert!(mixed.componentwise_between(&before, &after));

        mixed.dump_count = OptionalRegistryValue::Present(RegistryValue {
            value_type: REG_DWORD,
            bytes: 99u32.to_le_bytes().to_vec(),
        });
        assert!(!mixed.componentwise_between(&before, &after));
    }

    #[test]
    fn owner_state_requires_sorted_unique_lowercase_hex_ids() {
        let valid_a = "a".repeat(64);
        let valid_b = "b".repeat(64);
        assert!(
            validate_owner_state(Some(&owner(missing(), &[&valid_a, &valid_b])), "imm.exe").is_ok()
        );
        assert!(
            validate_owner_state(Some(&owner(missing(), &[&valid_b, &valid_a])), "imm.exe")
                .is_err()
        );
        assert!(
            validate_owner_state(Some(&owner(missing(), &[&valid_a, &valid_a])), "imm.exe")
                .is_err()
        );
        assert!(
            validate_owner_state(Some(&owner(missing(), &[&"Z".repeat(64)])), "imm.exe").is_err()
        );
    }

    #[test]
    fn transaction_validation_rejects_tampered_immutable_and_restore_states() {
        let mut configure = plan_configure(None, missing(), "imm.exe", "a".repeat(64)).unwrap();
        validate_transaction(&configure, "imm.exe").unwrap();
        configure.after_owner.as_mut().unwrap().before.dump_count = managed_wer_state().dump_count;
        assert!(validate_transaction(&configure, "imm.exe").is_err());

        let current_owner = owner(missing(), &[&"a".repeat(64)]);
        let mut remove = plan_remove(Some(current_owner), managed_wer_state(), &"a".repeat(64))
            .unwrap()
            .unwrap();
        validate_transaction(&remove, "imm.exe").unwrap();
        remove.after_wer = managed_wer_state();
        assert!(validate_transaction(&remove, "imm.exe").is_err());
    }

    #[test]
    fn managed_values_match_the_fixed_local_dump_contract() {
        let managed = managed_wer_state();
        assert_eq!(
            managed.dump_count,
            OptionalRegistryValue::Present(RegistryValue {
                value_type: REG_DWORD,
                bytes: 3u32.to_le_bytes().to_vec(),
            })
        );
        assert_eq!(
            managed.dump_type,
            OptionalRegistryValue::Present(RegistryValue {
                value_type: REG_DWORD,
                bytes: 1u32.to_le_bytes().to_vec(),
            })
        );
        assert_eq!(
            managed.dump_folder,
            OptionalRegistryValue::Present(RegistryValue {
                value_type: REG_EXPAND_SZ,
                bytes: utf16_registry_bytes(DUMP_FOLDER_TEMPLATE),
            })
        );
    }
}

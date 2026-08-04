use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::ffi::OsString;
use std::mem::{size_of, size_of_val};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut, NonNull};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use tokio::time::{sleep, timeout};
use winapi::shared::bcrypt::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
use winapi::shared::sddl::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use winapi::um::securitybaseapi::SetFileSecurityW;
use winapi::um::shellapi::{
    ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use winapi::um::softpub::WINTRUST_ACTION_GENERIC_VERIFY_V2;
use winapi::um::winnt::{DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION};
use winapi::um::wintrust::{
    WinVerifyTrust, WINTRUST_DATA, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL,
    WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
    WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};
use winapi::um::winuser::SW_HIDE;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, HANDLE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsValidSid,
    TokenIntegrityLevel, TokenSessionId, TokenUser, SECURITY_ATTRIBUTES, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
use windows_sys::Win32::System::SystemServices::{
    SECURITY_MANDATORY_HIGH_RID, SECURITY_MANDATORY_MEDIUM_RID, SECURITY_MANDATORY_SYSTEM_RID,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcessId, GetProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
};

const HELPER_ARGUMENT_PREFIX: &str = "--imm-privileged-helper=";
const PIPE_PREFIX: &str = r"\\.\pipe\jp.bhatt.wwmm.privileged.";
const PIPE_TOKEN_LENGTH: usize = 32;
const PROTOCOL_VERSION: u16 = 1;
const CHALLENGE_LENGTH: usize = 32;
const MAX_FRAME_BYTES: usize = 16 * 1024;
const PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PIPE_IO_TIMEOUT: Duration = Duration::from_secs(10);
const PIPE_ACCEPT_TIMEOUT: Duration = Duration::from_secs(60);
const HELPER_EXIT_TIMEOUT_MILLISECONDS: u32 = 5_000;
const DUMP_DIRECTORY_RELATIVE: &str = r"Integrated Mod Manager (IMM) Data\diagnostics\dumps";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HelperRunStatus {
    NotRequested,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessIdentity {
    pid: u32,
    user_sid: String,
    session_id: u32,
    image_key: String,
    integrity_rid: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PrivilegedAction {
    Probe,
    ConfigureWer,
    RemoveWer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
enum HelperFrame {
    Hello {
        protocol_version: u16,
        helper_pid: u32,
    },
    Proof {
        protocol_version: u16,
        challenge: Vec<u8>,
        helper_pid: u32,
        gui_pid: u32,
    },
    Completed {
        protocol_version: u16,
        challenge: Vec<u8>,
        success: bool,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerFrame {
    Challenge {
        protocol_version: u16,
        challenge: Vec<u8>,
        gui_pid: u32,
    },
    Execute {
        protocol_version: u16,
        challenge: Vec<u8>,
        action: PrivilegedAction,
    },
}

struct OwnedHandle(HANDLE);

// Windows kernel handles are process-wide values and may be waited/closed from another thread.
unsafe impl Send for OwnedHandle {}

impl OwnedHandle {
    fn new(handle: HANDLE, context: &str) -> Result<Self, String> {
        if handle.is_null() {
            Err(last_error(context))
        } else {
            Ok(Self(handle))
        }
    }
}

struct OwnedLocalAllocation(*mut winapi::ctypes::c_void);

impl Drop for OwnedLocalAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0.cast());
        }
    }
}

struct ElevatedProcess {
    handle: OwnedHandle,
    completed: bool,
}

impl ElevatedProcess {
    fn pid(&self) -> Result<u32, String> {
        let pid = unsafe { GetProcessId(self.handle.0) };
        if pid == 0 {
            Err(last_error("Unable to identify the elevated helper process"))
        } else {
            Ok(pid)
        }
    }

    fn finish(mut self) -> Result<(), String> {
        self.completed = true;
        match unsafe { WaitForSingleObject(self.handle.0, HELPER_EXIT_TIMEOUT_MILLISECONDS) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => {
                unsafe {
                    TerminateProcess(self.handle.0, 1);
                }
                Err("The privileged helper did not exit after completing its action".to_string())
            }
            _ => Err(last_error(
                "Unable to wait for the privileged helper to exit",
            )),
        }
    }
}

impl Drop for ElevatedProcess {
    fn drop(&mut self) {
        if !self.completed {
            unsafe {
                TerminateProcess(self.handle.0, 1);
            }
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub(crate) fn run_if_requested() -> Result<HelperRunStatus, String> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let Some(pipe_name) = parse_helper_pipe_argument(&arguments)? else {
        return Ok(HelperRunStatus::NotRequested);
    };

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|error| format!("Unable to create the privileged helper runtime: {error}"))?;
    runtime.block_on(run_helper_client(&pipe_name))?;
    Ok(HelperRunStatus::Completed)
}

fn parse_helper_pipe_argument(arguments: &[String]) -> Result<Option<String>, String> {
    let helper_arguments = arguments
        .iter()
        .filter(|argument| argument.starts_with(HELPER_ARGUMENT_PREFIX))
        .collect::<Vec<_>>();
    if helper_arguments.is_empty()
        && !arguments
            .iter()
            .any(|argument| argument.starts_with("--imm-privileged-helper"))
    {
        return Ok(None);
    }
    if helper_arguments.is_empty() {
        return Err("Invalid privileged helper routing argument".to_string());
    }
    if arguments.len() != 1 || helper_arguments.len() != 1 {
        return Err("Privileged helper mode accepts exactly one routing argument".to_string());
    }

    let token = helper_arguments[0]
        .strip_prefix(HELPER_ARGUMENT_PREFIX)
        .ok_or_else(|| "Invalid privileged helper routing argument".to_string())?;
    if token.len() != PIPE_TOKEN_LENGTH
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Invalid privileged helper pipe token".to_string());
    }
    Ok(Some(format!("{PIPE_PREFIX}{token}")))
}

async fn run_helper_client(pipe_name: &str) -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("Unable to resolve the helper executable: {error}"))?;
    verify_authenticode_signature(&current_exe)?;
    let expected_image = canonical_image_key(&current_exe)?;
    let helper_pid = unsafe { GetCurrentProcessId() };
    let helper_identity = process_identity(helper_pid)?;
    let mut pipe = connect_to_server(pipe_name).await?;
    let gui_pid = named_pipe_server_pid(&pipe)?;
    let gui_identity = process_identity(gui_pid)?;
    validate_channel_identities(
        &gui_identity,
        &helper_identity,
        gui_pid,
        helper_pid,
        &expected_image,
    )?;

    write_frame(
        &mut pipe,
        &HelperFrame::Hello {
            protocol_version: PROTOCOL_VERSION,
            helper_pid,
        },
    )
    .await?;

    let challenge_frame = read_frame::<_, ServerFrame>(&mut pipe).await?;
    let challenge = match challenge_frame {
        ServerFrame::Challenge {
            protocol_version,
            challenge,
            gui_pid: claimed_gui_pid,
        } => {
            require_protocol(protocol_version)?;
            if claimed_gui_pid != gui_pid {
                return Err(
                    "The privileged helper server PID claim did not match the pipe owner"
                        .to_string(),
                );
            }
            validate_challenge(&challenge)?;
            challenge
        }
        ServerFrame::Execute { .. } => {
            return Err(
                "The privileged helper received an action before authentication".to_string(),
            )
        }
    };

    write_frame(
        &mut pipe,
        &HelperFrame::Proof {
            protocol_version: PROTOCOL_VERSION,
            challenge: challenge.clone(),
            helper_pid,
            gui_pid,
        },
    )
    .await?;

    let execute_frame = read_frame::<_, ServerFrame>(&mut pipe).await?;
    let action = match execute_frame {
        ServerFrame::Execute {
            protocol_version,
            challenge: execute_challenge,
            action,
        } => {
            require_protocol(protocol_version)?;
            require_same_challenge(&challenge, &execute_challenge)?;
            action
        }
        ServerFrame::Challenge { .. } => {
            return Err("The privileged helper received a repeated challenge".to_string())
        }
    };

    let action_result = execute_action(action, &helper_identity, &current_exe);
    write_frame(
        &mut pipe,
        &HelperFrame::Completed {
            protocol_version: PROTOCOL_VERSION,
            challenge,
            success: action_result.is_ok(),
            error: action_result.as_ref().err().cloned(),
        },
    )
    .await?;
    action_result
}

fn execute_action(
    action: PrivilegedAction,
    helper_identity: &ProcessIdentity,
    current_exe: &Path,
) -> Result<(), String> {
    match action {
        PrivilegedAction::Probe => Ok(()),
        PrivilegedAction::ConfigureWer | PrivilegedAction::RemoveWer => {
            let executable_name = current_exe
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| "Unable to determine the WER executable name".to_string())?;
            let action = if action == PrivilegedAction::ConfigureWer {
                crate::wer_registry::WerRegistryAction::Configure
            } else {
                crate::wer_registry::WerRegistryAction::Remove
            };
            crate::wer_registry::execute(action, executable_name, &helper_identity.image_key)
        }
    }
}

#[tauri::command]
pub(crate) async fn configure_wer_local_dumps() -> Result<(), String> {
    require_release_helper()?;
    prepare_dump_directory()?;
    invoke_privileged_action(PrivilegedAction::ConfigureWer).await
}

#[tauri::command]
pub(crate) async fn remove_wer_local_dumps() -> Result<(), String> {
    require_release_helper()?;
    invoke_privileged_action(PrivilegedAction::RemoveWer).await
}

#[tauri::command]
pub(crate) fn get_wer_local_dumps_status() -> Result<crate::wer_registry::WerRegistryStatus, String>
{
    if cfg!(debug_assertions) {
        return Ok(crate::wer_registry::WerRegistryStatus::unsupported_build());
    }
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("Unable to resolve the GUI executable: {error}"))?;
    let executable_name = current_exe
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Unable to determine the WER executable name".to_string())?;
    let image_key = canonical_image_key(&current_exe)?;
    crate::wer_registry::status(executable_name, &image_key)
}

fn require_release_helper() -> Result<(), String> {
    if cfg!(debug_assertions) {
        Err("WER LocalDumps is disabled for development and portable builds".to_string())
    } else {
        Ok(())
    }
}

async fn invoke_privileged_action(action: PrivilegedAction) -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("Unable to resolve the GUI executable: {error}"))?;
    verify_authenticode_signature(&current_exe)?;
    let expected_image = canonical_image_key(&current_exe)?;
    let gui_pid = unsafe { GetCurrentProcessId() };
    let gui_identity = process_identity(gui_pid)?;
    let token = random_bytes::<16>()?
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let pipe_name = format!("{PIPE_PREFIX}{token}");
    let challenge = random_bytes::<CHALLENGE_LENGTH>()?.to_vec();
    validate_challenge(&challenge)?;
    let mut server = create_authenticated_pipe_server(&pipe_name, &gui_identity.user_sid)?;
    let elevated = launch_elevated_helper(&current_exe, &token)?;
    let launched_pid = elevated.pid()?;

    timeout(PIPE_ACCEPT_TIMEOUT, server.connect())
        .await
        .map_err(|_| "Timed out waiting for the privileged helper to connect".to_string())?
        .map_err(|error| format!("Unable to accept the privileged helper connection: {error}"))?;
    let client_pid = named_pipe_client_pid(&server)?;
    if client_pid != launched_pid {
        return Err(
            "The named-pipe client did not match the process returned by the UAC launch"
                .to_string(),
        );
    }
    let helper_identity = process_identity(client_pid)?;
    validate_channel_identities(
        &gui_identity,
        &helper_identity,
        gui_pid,
        client_pid,
        &expected_image,
    )?;

    match read_frame::<_, HelperFrame>(&mut server).await? {
        HelperFrame::Hello {
            protocol_version,
            helper_pid,
        } => {
            require_protocol(protocol_version)?;
            if helper_pid != client_pid {
                return Err(
                    "The privileged helper hello PID did not match the pipe client".to_string(),
                );
            }
        }
        _ => return Err("The privileged helper did not begin with a hello frame".to_string()),
    }
    write_frame(
        &mut server,
        &ServerFrame::Challenge {
            protocol_version: PROTOCOL_VERSION,
            challenge: challenge.clone(),
            gui_pid,
        },
    )
    .await?;
    match read_frame::<_, HelperFrame>(&mut server).await? {
        HelperFrame::Proof {
            protocol_version,
            challenge: proof_challenge,
            helper_pid,
            gui_pid: proof_gui_pid,
        } => {
            require_protocol(protocol_version)?;
            require_same_challenge(&challenge, &proof_challenge)?;
            if helper_pid != client_pid || proof_gui_pid != gui_pid {
                return Err("The privileged helper proof identities did not match".to_string());
            }
        }
        _ => {
            return Err("The privileged helper did not provide an authentication proof".to_string())
        }
    }
    write_frame(
        &mut server,
        &ServerFrame::Execute {
            protocol_version: PROTOCOL_VERSION,
            challenge: challenge.clone(),
            action,
        },
    )
    .await?;
    match read_frame::<_, HelperFrame>(&mut server).await? {
        HelperFrame::Completed {
            protocol_version,
            challenge: result_challenge,
            success,
            error,
        } => {
            require_protocol(protocol_version)?;
            require_same_challenge(&challenge, &result_challenge)?;
            if !success {
                return Err(error.unwrap_or_else(|| {
                    "The privileged helper action failed without an error".to_string()
                }));
            }
            if error.is_some() {
                return Err(
                    "The privileged helper returned contradictory result fields".to_string()
                );
            }
        }
        _ => return Err("The privileged helper did not return a completion frame".to_string()),
    }
    drop(server);
    elevated.finish()
}

fn create_authenticated_pipe_server(
    pipe_name: &str,
    user_sid: &str,
) -> Result<NamedPipeServer, String> {
    let descriptor = security_descriptor_from_sddl(&format!("D:P(A;;GA;;;{user_sid})"))?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0.cast(),
        bInheritHandle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .max_instances(1)
        .in_buffer_size(MAX_FRAME_BYTES as u32)
        .out_buffer_size(MAX_FRAME_BYTES as u32);
    unsafe {
        options
            .create_with_security_attributes_raw(
                pipe_name,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
            .map_err(|error| format!("Unable to create the privileged helper pipe: {error}"))
    }
}

fn launch_elevated_helper(executable: &Path, token: &str) -> Result<ElevatedProcess, String> {
    if token.len() != PIPE_TOKEN_LENGTH {
        return Err("Invalid privileged helper launch token".to_string());
    }
    let executable = wide_os_null(executable.as_os_str());
    let parameters = wide_os_null(OsString::from(format!("{HELPER_ARGUMENT_PREFIX}{token}")));
    let verb = wide_os_null(OsString::from("runas"));
    let mut execute: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    execute.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
    execute.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    execute.hwnd = null_mut();
    execute.lpVerb = verb.as_ptr();
    execute.lpFile = executable.as_ptr();
    execute.lpParameters = parameters.as_ptr();
    execute.lpDirectory = null();
    execute.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut execute) } == 0 {
        return Err(last_error(
            "Unable to start the signed privileged helper (UAC may have been cancelled)",
        ));
    }
    Ok(ElevatedProcess {
        handle: OwnedHandle::new(
            execute.hProcess as HANDLE,
            "UAC did not return a helper process handle",
        )?,
        completed: false,
    })
}

fn named_pipe_client_pid(pipe: &NamedPipeServer) -> Result<u32, String> {
    let mut pid = 0u32;
    let result =
        unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle().cast(), &mut pid as *mut u32) };
    if result == 0 || pid == 0 {
        Err(last_error(
            "Unable to identify the privileged helper pipe client",
        ))
    } else {
        Ok(pid)
    }
}

fn random_bytes<const LENGTH: usize>() -> Result<[u8; LENGTH], String> {
    let mut bytes = [0u8; LENGTH];
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            LENGTH as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status == 0 {
        Ok(bytes)
    } else {
        Err(format!(
            "Unable to generate a privileged helper challenge: NTSTATUS 0x{:08x}",
            status as u32
        ))
    }
}

fn security_descriptor_from_sddl(sddl: &str) -> Result<OwnedLocalAllocation, String> {
    let sddl = wide_os_null(OsString::from(sddl));
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            u32::from(SDDL_REVISION_1),
            &mut descriptor,
            null_mut(),
        )
    } == 0
        || descriptor.is_null()
    {
        Err(last_error(
            "Unable to build the privileged helper security descriptor",
        ))
    } else {
        Ok(OwnedLocalAllocation(descriptor))
    }
}

fn prepare_dump_directory() -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| {
            "LOCALAPPDATA is unavailable; the dump directory cannot be created".to_string()
        })?;
    let canonical_root = std::fs::canonicalize(&local_app_data).map_err(|error| {
        format!(
            "Unable to canonicalize LOCALAPPDATA '{}': {error}",
            local_app_data.display()
        )
    })?;
    let dump_directory = local_app_data.join(DUMP_DIRECTORY_RELATIVE);
    std::fs::create_dir_all(&dump_directory)
        .map_err(|error| format!("Unable to create the local dump directory: {error}"))?;
    let mut inspected = local_app_data.clone();
    for component in Path::new(DUMP_DIRECTORY_RELATIVE).components() {
        inspected.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&inspected).map_err(|error| {
            format!(
                "Unable to inspect dump directory component '{}': {error}",
                inspected.display()
            )
        })?;
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "Dump directory component '{}' is a reparse point",
                inspected.display()
            ));
        }
        if !metadata.is_dir() {
            return Err(format!(
                "Dump directory component '{}' is not a directory",
                inspected.display()
            ));
        }
    }
    let metadata = std::fs::symlink_metadata(&dump_directory)
        .map_err(|error| format!("Unable to inspect the local dump directory: {error}"))?;
    use std::os::windows::fs::MetadataExt;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("The local dump directory is a reparse point".to_string());
    }
    let canonical_dump = std::fs::canonicalize(&dump_directory)
        .map_err(|error| format!("Unable to canonicalize the local dump directory: {error}"))?;
    if !canonical_dump.starts_with(&canonical_root) {
        return Err("The local dump directory escaped LOCALAPPDATA".to_string());
    }
    let current_identity = process_identity(unsafe { GetCurrentProcessId() })?;
    let descriptor = security_descriptor_from_sddl(&format!(
        "D:P(A;OICI;FA;;;{})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
        current_identity.user_sid
    ))?;
    let path = wide_os_null(canonical_dump.as_os_str());
    if unsafe {
        SetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.0,
        )
    } == 0
    {
        return Err(last_error("Unable to secure the local dump directory"));
    }
    Ok(canonical_dump)
}

fn verify_authenticode_signature(path: &Path) -> Result<(), String> {
    let path = wide_os_null(path.as_os_str());
    let mut file: WINTRUST_FILE_INFO = unsafe { std::mem::zeroed() };
    file.cbStruct = size_of::<WINTRUST_FILE_INFO>() as u32;
    file.pcwszFilePath = path.as_ptr();
    let mut data: WINTRUST_DATA = unsafe { std::mem::zeroed() };
    data.cbStruct = size_of::<WINTRUST_DATA>() as u32;
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    unsafe {
        *data.u.pFile_mut() = &mut file;
    }
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let status = unsafe {
        WinVerifyTrust(
            null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        )
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(
            null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        );
    }
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "The privileged helper executable does not have a trusted Authenticode signature: 0x{:08x}",
            status as u32
        ))
    }
}

fn wide_os_null(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

async fn connect_to_server(pipe_name: &str) -> Result<NamedPipeClient, String> {
    let started = Instant::now();
    loop {
        match ClientOptions::new().open(pipe_name) {
            Ok(pipe) => return Ok(pipe),
            Err(error)
                if matches!(error.raw_os_error(), Some(2) | Some(231))
                    && started.elapsed() < PIPE_CONNECT_TIMEOUT =>
            {
                sleep(Duration::from_millis(50)).await;
            }
            Err(error) => {
                return Err(format!(
                    "Unable to connect to the privileged helper pipe: {error}"
                ))
            }
        }
    }
}

fn named_pipe_server_pid(pipe: &NamedPipeClient) -> Result<u32, String> {
    let mut pid = 0u32;
    let result =
        unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle().cast(), &mut pid as *mut u32) };
    if result == 0 || pid == 0 {
        Err(last_error(
            "Unable to identify the privileged helper pipe server",
        ))
    } else {
        Ok(pid)
    }
}

fn process_identity(pid: u32) -> Result<ProcessIdentity, String> {
    if pid == 0 {
        return Err("A zero process ID cannot be authenticated".to_string());
    }
    let process = OwnedHandle::new(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) },
        "Unable to open the process for identity verification",
    )?;
    let mut token_handle = null_mut();
    if unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token_handle) } == 0 {
        return Err(last_error(
            "Unable to open the process token for identity verification",
        ));
    }
    let token = OwnedHandle::new(token_handle, "Windows returned an invalid process token")?;

    Ok(ProcessIdentity {
        pid,
        user_sid: token_user_sid(token.0)?,
        session_id: token_session_id(token.0)?,
        image_key: process_image_key(process.0)?,
        integrity_rid: token_integrity_rid(token.0)?,
    })
}

fn token_information_buffer(token: HANDLE, information_class: i32) -> Result<Vec<usize>, String> {
    let mut required = 0u32;
    unsafe {
        GetTokenInformation(
            token,
            information_class,
            null_mut(),
            0,
            &mut required as *mut u32,
        );
    }
    if required == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(last_error("Unable to size the process token identity"));
    }

    let word_count = (required as usize).div_ceil(size_of::<usize>());
    let mut buffer = vec![0usize; word_count];
    let mut actual = required;
    if unsafe {
        GetTokenInformation(
            token,
            information_class,
            buffer.as_mut_ptr().cast(),
            required,
            &mut actual as *mut u32,
        )
    } == 0
    {
        return Err(last_error("Unable to read the process token identity"));
    }
    if actual > required {
        return Err("The process token identity changed while it was being read".to_string());
    }
    Ok(buffer)
}

fn token_user_sid(token: HANDLE) -> Result<String, String> {
    let buffer = token_information_buffer(token, TokenUser)?;
    let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    sid_to_string(token_user.User.Sid)
}

fn token_session_id(token: HANDLE) -> Result<u32, String> {
    let buffer = token_information_buffer(token, TokenSessionId)?;
    if size_of_val(buffer.as_slice()) < size_of::<u32>() {
        return Err("Windows returned a truncated token session ID".to_string());
    }
    Ok(unsafe { *buffer.as_ptr().cast::<u32>() })
}

fn token_integrity_rid(token: HANDLE) -> Result<u32, String> {
    let buffer = token_information_buffer(token, TokenIntegrityLevel)?;
    let label = unsafe { &*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>() };
    let sid = label.Label.Sid;
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err("Windows returned an invalid token integrity SID".to_string());
    }
    let count = NonNull::new(unsafe { GetSidSubAuthorityCount(sid) })
        .ok_or_else(|| "Windows returned an invalid integrity SID authority count".to_string())?;
    let count = unsafe { *count.as_ptr() };
    if count == 0 {
        return Err("Windows returned an empty integrity SID".to_string());
    }
    let rid = NonNull::new(unsafe { GetSidSubAuthority(sid, u32::from(count - 1)) })
        .ok_or_else(|| "Windows returned an invalid integrity SID authority".to_string())?;
    Ok(unsafe { *rid.as_ptr() })
}

fn sid_to_string(sid: *mut core::ffi::c_void) -> Result<String, String> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err("Windows returned an invalid user SID".to_string());
    }
    let mut sid_text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut sid_text) } == 0 || sid_text.is_null() {
        return Err(last_error("Unable to format the process user SID"));
    }
    let length = (0..)
        .find(|offset| unsafe { *sid_text.add(*offset) } == 0)
        .ok_or_else(|| "Windows returned an unterminated user SID".to_string())?;
    let value = String::from_utf16(unsafe { std::slice::from_raw_parts(sid_text, length) })
        .map_err(|error| format!("Windows returned an invalid user SID: {error}"));
    unsafe {
        LocalFree(sid_text.cast());
    }
    value
}

fn process_image_key(process: HANDLE) -> Result<String, String> {
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length as *mut u32)
    } == 0
    {
        return Err(last_error("Unable to resolve the process image path"));
    }
    let path = PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
    canonical_image_key(&path)
}

fn canonical_image_key(path: &Path) -> Result<String, String> {
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        format!(
            "Unable to canonicalize the executable image '{}': {error}",
            path.display()
        )
    })?;
    Ok(canonical
        .to_string_lossy()
        .replace('/', "\\")
        .trim_start_matches(r"\\?\")
        .to_ascii_lowercase())
}

fn validate_channel_identities(
    gui: &ProcessIdentity,
    helper: &ProcessIdentity,
    expected_gui_pid: u32,
    expected_helper_pid: u32,
    expected_image_key: &str,
) -> Result<(), String> {
    if gui.pid != expected_gui_pid || helper.pid != expected_helper_pid {
        return Err("The privileged helper process ID did not match the pipe endpoint".to_string());
    }
    if gui.user_sid != helper.user_sid {
        return Err("The privileged helper and GUI belong to different users".to_string());
    }
    if gui.session_id != helper.session_id {
        return Err("The privileged helper and GUI belong to different sessions".to_string());
    }
    if gui.image_key != expected_image_key || helper.image_key != expected_image_key {
        return Err(
            "The privileged helper endpoint image did not match this executable".to_string(),
        );
    }
    let medium = SECURITY_MANDATORY_MEDIUM_RID as u32;
    let high = SECURITY_MANDATORY_HIGH_RID as u32;
    let system = SECURITY_MANDATORY_SYSTEM_RID as u32;
    if gui.integrity_rid < medium || gui.integrity_rid >= high {
        return Err("The privileged helper server was not a medium-integrity GUI".to_string());
    }
    if helper.integrity_rid < high || helper.integrity_rid >= system {
        return Err("The privileged helper client was not a high-integrity process".to_string());
    }
    Ok(())
}

fn require_protocol(version: u16) -> Result<(), String> {
    if version == PROTOCOL_VERSION {
        Ok(())
    } else {
        Err("Unsupported privileged helper protocol version".to_string())
    }
}

fn validate_challenge(challenge: &[u8]) -> Result<(), String> {
    if challenge.len() != CHALLENGE_LENGTH || challenge.iter().all(|byte| *byte == 0) {
        Err("Invalid privileged helper challenge".to_string())
    } else {
        Ok(())
    }
}

fn require_same_challenge(expected: &[u8], actual: &[u8]) -> Result<(), String> {
    validate_challenge(expected)?;
    if expected == actual {
        Ok(())
    } else {
        Err("The privileged helper challenge did not match".to_string())
    }
}

async fn write_frame<W, T>(writer: &mut W, value: &T) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = serde_json::to_vec(value)
        .map_err(|error| format!("Unable to serialize a privileged helper frame: {error}"))?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err("The privileged helper frame exceeded the protocol limit".to_string());
    }
    let length = u32::try_from(payload.len())
        .map_err(|_| "The privileged helper frame length overflowed".to_string())?
        .to_le_bytes();
    timeout(PIPE_IO_TIMEOUT, async {
        writer.write_all(&length).await?;
        writer.write_all(&payload).await?;
        writer.flush().await
    })
    .await
    .map_err(|_| "Timed out writing a privileged helper frame".to_string())?
    .map_err(|error| format!("Unable to write a privileged helper frame: {error}"))
}

async fn read_frame<R, T>(reader: &mut R) -> Result<T, String>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut length = [0u8; 4];
    timeout(PIPE_IO_TIMEOUT, reader.read_exact(&mut length))
        .await
        .map_err(|_| "Timed out reading a privileged helper frame header".to_string())?
        .map_err(|error| format!("Unable to read a privileged helper frame header: {error}"))?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("The privileged helper frame length was invalid".to_string());
    }
    let mut payload = vec![0u8; length];
    timeout(PIPE_IO_TIMEOUT, reader.read_exact(&mut payload))
        .await
        .map_err(|_| "Timed out reading a privileged helper frame body".to_string())?
        .map_err(|error| format!("Unable to read a privileged helper frame body: {error}"))?;
    serde_json::from_slice(&payload)
        .map_err(|error| format!("Invalid privileged helper frame: {error}"))
}

fn last_error(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(
        pid: u32,
        sid: &str,
        session_id: u32,
        image: &str,
        integrity: u32,
    ) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            user_sid: sid.to_string(),
            session_id,
            image_key: image.to_string(),
            integrity_rid: integrity,
        }
    }

    #[test]
    fn helper_argument_only_accepts_a_fixed_lowercase_hex_token() {
        let token = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_helper_pipe_argument(&[format!("{HELPER_ARGUMENT_PREFIX}{token}")]).unwrap(),
            Some(format!("{PIPE_PREFIX}{token}"))
        );
        assert!(parse_helper_pipe_argument(&[]).unwrap().is_none());
        assert!(parse_helper_pipe_argument(&["--imm-privileged-helper".to_string()]).is_err());
        assert!(
            parse_helper_pipe_argument(&[format!("{HELPER_ARGUMENT_PREFIX}..\\arbitrary")])
                .is_err()
        );
        assert!(parse_helper_pipe_argument(&[
            format!("{HELPER_ARGUMENT_PREFIX}{token}"),
            "--extra".to_string(),
        ])
        .is_err());
    }

    #[test]
    fn channel_identity_requires_same_user_session_image_and_expected_integrity() {
        let medium = SECURITY_MANDATORY_MEDIUM_RID as u32;
        let high = SECURITY_MANDATORY_HIGH_RID as u32;
        let gui = identity(10, "S-1-5-21-1", 4, "c:\\imm.exe", medium);
        let helper = identity(11, "S-1-5-21-1", 4, "c:\\imm.exe", high);
        validate_channel_identities(&gui, &helper, 10, 11, "c:\\imm.exe").unwrap();

        let mut wrong = helper.clone();
        wrong.user_sid = "S-1-5-21-2".to_string();
        assert!(validate_channel_identities(&gui, &wrong, 10, 11, "c:\\imm.exe").is_err());
        wrong = helper.clone();
        wrong.session_id = 5;
        assert!(validate_channel_identities(&gui, &wrong, 10, 11, "c:\\imm.exe").is_err());
        wrong = helper.clone();
        wrong.image_key = "c:\\other.exe".to_string();
        assert!(validate_channel_identities(&gui, &wrong, 10, 11, "c:\\imm.exe").is_err());
        wrong = helper.clone();
        wrong.integrity_rid = medium;
        assert!(validate_channel_identities(&gui, &wrong, 10, 11, "c:\\imm.exe").is_err());
    }

    #[test]
    fn challenge_must_be_nonzero_exact_length_and_match() {
        let challenge = vec![7u8; CHALLENGE_LENGTH];
        validate_challenge(&challenge).unwrap();
        require_same_challenge(&challenge, &challenge).unwrap();
        assert!(validate_challenge(&[0u8; CHALLENGE_LENGTH]).is_err());
        assert!(validate_challenge(&challenge[..CHALLENGE_LENGTH - 1]).is_err());
        assert!(require_same_challenge(&challenge, &[8u8; CHALLENGE_LENGTH]).is_err());
    }

    #[tokio::test]
    async fn protocol_frames_are_length_bounded_and_round_trip() {
        let (mut client, mut server) = tokio::io::duplex(MAX_FRAME_BYTES * 2);
        let expected = HelperFrame::Proof {
            protocol_version: PROTOCOL_VERSION,
            challenge: vec![9u8; CHALLENGE_LENGTH],
            helper_pid: 11,
            gui_pid: 10,
        };
        let sent = expected.clone();
        let writer = tokio::spawn(async move { write_frame(&mut client, &sent).await });
        let received: HelperFrame = read_frame(&mut server).await.unwrap();
        writer.await.unwrap().unwrap();
        assert_eq!(received, expected);

        let (mut client, mut server) = tokio::io::duplex(8);
        client
            .write_all(&((MAX_FRAME_BYTES as u32) + 1).to_le_bytes())
            .await
            .unwrap();
        assert!(read_frame::<_, HelperFrame>(&mut server).await.is_err());
    }

    #[test]
    fn random_challenges_are_nonzero_and_have_the_protocol_length() {
        let first = random_bytes::<CHALLENGE_LENGTH>().unwrap();
        let second = random_bytes::<CHALLENGE_LENGTH>().unwrap();
        validate_challenge(&first).unwrap();
        validate_challenge(&second).unwrap();
        assert_ne!(first, second);
    }
}

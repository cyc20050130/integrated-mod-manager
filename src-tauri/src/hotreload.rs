#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_tracing::tracing;
use std::sync::RwLock;
#[cfg(windows)]
use std::time::Duration;
#[cfg(windows)]
use winapi::um::{
    handleapi::CloseHandle,
    processthreadsapi::OpenProcess,
    psapi::{EnumProcesses, GetModuleBaseNameW},
    winnt::{PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
    winuser::{
        keybd_event, EnumWindows, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
        MapVirtualKeyW, SetForegroundWindow, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VK_F10,
    },
};

#[cfg(windows)]
static HOTRELOAD_ENABLED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
static MONITORING_ACTIVE: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
static CHANGE: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]

static MOD_MANAGER_TITLE: &str = "Integrated Mod Manager";
static WINDOW_TARGET: RwLock<String> = RwLock::new(String::new());
static WW_TITLE: &str = "wuthering waves  ";
static ZZ_TITLE: &str = "zenlesszonezero";
static GI_TITLE: &str = "genshin impact";
static SR_TITLE: &str = "honkai: star rail";
static EF_TITLE: &str = "Endfield";

#[cfg(windows)]
fn init_window_target() {
    if let Ok(mut window_target) = WINDOW_TARGET.write() {
        if window_target.is_empty() {
            *window_target = WW_TITLE.to_string();
        }
    }
}

#[tauri::command]
pub fn set_window_target(target_game: i32) -> Result<(), String> {
    #[cfg(windows)]
    {
        if let Ok(mut window_target) = WINDOW_TARGET.write() {
            *window_target = match target_game {
                0 => MOD_MANAGER_TITLE.to_string(),
                1 => WW_TITLE.to_string(),
                2 => ZZ_TITLE.to_string(),
                3 => GI_TITLE.to_string(),
                4 => SR_TITLE.to_string(),
                5 => EF_TITLE.to_string(),
                _ => {
                    return Err(format!(
                        "Invalid target_game value: {}. Must be 0-5",
                        target_game
                    ))
                }
            };
            tracing::info!("Window target set to: {}", *window_target);
            Ok(())
        } else {
            Err("Failed to acquire write lock for window target".to_string())
        }
    }
    #[cfg(not(windows))]
    {
        Err("Window target is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn set_hotreload(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        HOTRELOAD_ENABLED.store(enabled, Ordering::SeqCst);
        tracing::info!("Hotreload set to: {}", enabled);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Hotreload is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn set_change(trigger: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        CHANGE.store(trigger, Ordering::SeqCst);
        tracing::info!("Change trigger set to: {}", trigger);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Change trigger is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn start_window_monitoring() -> Result<(), String> {
    #[cfg(windows)]
    {
        if MONITORING_ACTIVE.load(Ordering::SeqCst) {
            return Ok(());
        }

        MONITORING_ACTIVE.store(true, Ordering::SeqCst);
        tracing::info!("Starting window monitoring for hotreload");

        tauri::async_runtime::spawn(async {
            window_monitor_loop().await;
        });

        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Window monitoring is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn stop_window_monitoring() -> Result<(), String> {
    #[cfg(windows)]
    {
        MONITORING_ACTIVE.store(false, Ordering::SeqCst);
        tracing::info!("Stopped window monitoring");
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Window monitoring is only supported on Windows".to_string())
    }
}

#[cfg(windows)]
fn get_focused_window_title() -> Option<String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }

        let mut buffer = [0u16; 512];
        let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);

        if len > 0 {
            let title = OsString::from_wide(&buffer[..len as usize])
                .to_string_lossy()
                .to_string();
            Some(title)
        } else {
            None
        }
    }
}

#[cfg(windows)]
fn get_focused_window_process_name() -> Option<String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }

        let mut process_id = 0;
        GetWindowThreadProcessId(hwnd, &mut process_id);

        if process_id == 0 {
            return None;
        }

        let process_handle =
            OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, process_id);

        if process_handle.is_null() {
            return None;
        }

        let mut buffer = [0u16; 512];
        let len = GetModuleBaseNameW(
            process_handle,
            std::ptr::null_mut(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
        );

        CloseHandle(process_handle);

        if len > 0 {
            let process_name = OsString::from_wide(&buffer[..len as usize])
                .to_string_lossy()
                .to_string();
            Some(process_name)
        } else {
            None
        }
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn is_game_process_running(game_id: i32) -> bool {
    let game_title = match game_id {
        0 => WW_TITLE,
        1 => ZZ_TITLE,
        2 => GI_TITLE,
        3 => SR_TITLE,
        4 => EF_TITLE,
        _ => return false, // Invalid game_id
    };

    check_process_running(game_title)
}

#[cfg(windows)]
fn check_process_running(title: &str) -> bool {
    unsafe {
        let mut process_ids: [u32; 1024] = [0; 1024];
        let mut bytes_needed: u32 = 0;

        if EnumProcesses(
            process_ids.as_mut_ptr(),
            (process_ids.len() * std::mem::size_of::<u32>()) as u32,
            &mut bytes_needed,
        ) == 0
        {
            tracing::error!("Failed to enumerate processes");
            return false;
        }

        let process_count = (bytes_needed as usize) / std::mem::size_of::<u32>();
        let target_title_lower = title.to_lowercase();

        for i in 0..process_count {
            let process_id = process_ids[i];
            if process_id == 0 {
                continue;
            }

            let process_handle =
                OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, process_id);
            if process_handle.is_null() {
                continue;
            }
            CloseHandle(process_handle);

            if check_process_windows(process_id, &target_title_lower) {
                tracing::info!(
                    "Found running process with window title matching: {}",
                    title
                );
                return true;
            }
        }

        false
    }
}

#[cfg(windows)]
fn check_process_windows(process_id: u32, target_title_lower: &str) -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    unsafe {
        let found = Arc::new(AtomicBool::new(false));
        let found_clone = Arc::clone(&found);
        let target_title = target_title_lower.to_string();
        let target_process_id = process_id;

        extern "system" fn enum_windows_proc(
            hwnd: winapi::shared::windef::HWND,
            lparam: isize,
        ) -> i32 {
            unsafe {
                let data = &*(lparam as *const (u32, String, Arc<AtomicBool>));
                let (target_process_id, target_title, found) = data;

                let mut window_process_id = 0;
                GetWindowThreadProcessId(hwnd, &mut window_process_id);

                if window_process_id == *target_process_id {
                    let mut buffer = [0u16; 512];
                    let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);

                    if len > 0 {
                        let window_title = OsString::from_wide(&buffer[..len as usize])
                            .to_string_lossy()
                            .to_string()
                            .to_lowercase();

                        println!(
                            "Found window: {} for process {}",
                            window_title, window_process_id
                        );

                        if window_title == *target_title {
                            found.store(true, Ordering::SeqCst);
                            return 0;
                        }
                    }
                }
                1
            }
        }

        let data = (target_process_id, target_title, found_clone);
        EnumWindows(Some(enum_windows_proc), &data as *const _ as isize);

        found.load(Ordering::SeqCst)
    }
}

#[cfg(windows)]
fn send_f10_key() -> Result<(), String> {
    let result = send_f10_with_legacy_keybd_event();
    if result.is_ok() {
        tracing::info!("F10 key sent successfully using Legacy keybd_event method");
        println!("F10 key sent successfully using Legacy keybd_event method");
        Ok(())
    } else {
        let error_msg = format!("Legacy keybd_event method failed: {:?}", result.err());
        tracing::error!("{}", error_msg);
        println!("Legacy keybd_event method failed");
        Err(error_msg)
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn focus_mod_manager_send_f10_return_to_game() -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::winuser::{FindWindowW, GetForegroundWindow, SetForegroundWindow};

    unsafe {
        if let Ok(window_target) = WINDOW_TARGET.read() {
            if *window_target == MOD_MANAGER_TITLE {
                let game_hwnd = GetForegroundWindow();
                let wide_title: Vec<u16> = OsStr::new(MOD_MANAGER_TITLE)
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();

                let mod_manager_hwnd = FindWindowW(std::ptr::null(), wide_title.as_ptr());
                if mod_manager_hwnd.is_null() {
                    return Err("Mod manager window not found".to_string());
                }

                tracing::info!("Focusing mod manager window");
                if SetForegroundWindow(mod_manager_hwnd) == 0 {
                    return Err("Failed to focus mod manager window".to_string());
                }

                std::thread::sleep(Duration::from_millis(100));

                tracing::info!("Sending F10 to mod manager");
                if let Err(e) = send_f10_key() {
                    tracing::error!("Failed to send F10 to mod manager: {}", e);
                }

                std::thread::sleep(Duration::from_millis(50));

                tracing::info!("Returning focus to game window");
                if SetForegroundWindow(game_hwnd) == 0 {
                    return Err("Failed to return focus to game window".to_string());
                }

                tracing::info!("Successfully focused mod manager, sent F10, and returned to game");
            } else {
                tracing::info!("Sending F10 to game");
                if let Err(e) = send_f10_key() {
                    tracing::error!("Failed to send F10 to game: {}", e);
                }
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn focus_mod_manager_send_f10_return_to_game() -> Result<(), String> {
    Err("Focus switching is only supported on Windows".to_string())
}

#[cfg(windows)]
fn send_f10_with_legacy_keybd_event() -> Result<(), String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return Err("No focused window found".to_string());
        }

        SetForegroundWindow(hwnd);
        std::thread::sleep(Duration::from_millis(20));

        let scan_code = MapVirtualKeyW(VK_F10 as u32, MAPVK_VK_TO_VSC) as u8;

        keybd_event(VK_F10 as u8, scan_code, 0, 0);

        std::thread::sleep(Duration::from_millis(10));

        keybd_event(VK_F10 as u8, scan_code, KEYEVENTF_KEYUP as u32, 0);

        tracing::debug!(
            "F10 sent via legacy keybd_event with scan code: {}",
            scan_code
        );
        Ok(())
    }
}

#[cfg(windows)]
fn is_game_window(title: &str, process_name: &str) -> bool {
    let title_lower = title.to_lowercase();
    let process_lower = process_name.to_lowercase();

    init_window_target();

    if let Ok(window_target) = WINDOW_TARGET.read() {
        if !window_target.is_empty()
            && (title_lower.contains(&window_target.to_lowercase())
                || process_lower.contains(&window_target.to_lowercase()))
        {
            return true;
        }
    }

    false
}

#[cfg(windows)]
async fn window_monitor_loop() {
    let mut last_game_state = false;

    while MONITORING_ACTIVE.load(Ordering::SeqCst) {
        if !HOTRELOAD_ENABLED.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            continue;
        }

        let window_title = get_focused_window_title().unwrap_or_default();
        let process_name = get_focused_window_process_name().unwrap_or_default();
        let is_game = is_game_window(&window_title, &process_name);

        if is_game != last_game_state {
            if is_game {
                tracing::info!(
                    "Game window detected - Title: '{}', Process: '{}'",
                    window_title,
                    process_name
                );
            } else {
                tracing::info!("Game window lost focus - now focused: '{}'", window_title);
            }
            last_game_state = is_game;
        }

        if is_game && CHANGE.load(Ordering::SeqCst) {
            CHANGE.store(false, Ordering::SeqCst);
            tokio::spawn(send_f10_async());
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    tracing::info!("Window monitoring stopped.");
}

#[cfg(windows)]
async fn send_f10_async() {
    tokio::time::sleep(Duration::from_millis(100)).await;
    if let Err(e) = send_f10_key() {
        tracing::error!("Failed to send F10 key: {}", e);
    }
}

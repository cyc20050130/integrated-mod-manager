use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn open_logs_folder(app_handle: tauri::AppHandle) -> Result<(), String> {
    let log_dir = app_handle
        .path()
        .app_log_dir()
        .map_err(|e| format!("Could not determine log directory: {}", e))?;

    if !log_dir.exists() {
        return Err(format!("Log directory does not exist: {:?}", log_dir));
    }

    let file = log_dir.join("app.log");

    if file.exists() {
        app_handle
            .opener()
            .reveal_item_in_dir(&file)
            .map_err(|e| format!("Failed to open log directory: {}", e))?;
    } else {
        app_handle
            .opener()
            .reveal_item_in_dir(&log_dir)
            .map_err(|e| format!("Failed to open log directory: {}", e))?;
    }

    Ok(())
}
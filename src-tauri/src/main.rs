// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::env;
fn main() {
    #[cfg(not(dev))]
    if let Ok(exe_path) = env::current_exe() {
        // Get the directory containing the executable
        if let Some(exe_dir) = exe_path.parent() {
            // Set the current working directory to the exe's location
            if let Err(e) = env::set_current_dir(exe_dir) {
                eprintln!("Failed to set working directory: {}", e);
            }
        }
    }
    wuwa_mod_manager_lib::run()
}

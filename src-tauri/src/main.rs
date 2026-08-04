// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = wuwa_mod_manager_lib::run_privileged_helper_if_requested() {
        std::process::exit(exit_code);
    }
    wuwa_mod_manager_lib::run()
}

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(not(dev))]
use std::env;
#[cfg(all(not(dev), target_os = "windows"))]
use std::fs;
#[cfg(all(not(dev), target_os = "windows"))]
use std::io;
#[cfg(all(not(dev), target_os = "windows"))]
use std::path::{Path, PathBuf};
#[cfg(all(not(dev), not(target_os = "windows")))]
use std::path::{Path, PathBuf};

#[cfg(all(not(dev), target_os = "windows"))]
fn copy_dir_missing(src: &Path, dst: &Path) -> io::Result<()> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = match entry {
            Ok(v) => v,
            Err(_) => continue,
        };
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let file_type = match entry.file_type() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            let _ = copy_dir_missing(&src_path, &dst_path);
            continue;
        }
        if !dst_path.exists() {
            let _ = fs::copy(&src_path, &dst_path);
        }
    }
    Ok(())
}

#[cfg(all(not(dev), target_os = "windows"))]
fn migrate_legacy_runtime_files(exe_dir: &Path, data_dir: &Path) {
    let runtime_files = [
        "config.json",
        "configWW.json",
        "configZZ.json",
        "configGI.json",
        "configSR.json",
        "configEF.json",
    ];

    for file in runtime_files {
        let src = exe_dir.join(file);
        let dst = data_dir.join(file);
        if src.exists() && !dst.exists() {
            let _ = fs::copy(src, dst);
        }
    }

    let _ = copy_dir_missing(&exe_dir.join("backups"), &data_dir.join("backups"));
}

#[cfg(all(not(dev), target_os = "windows"))]
fn resolve_runtime_dir(exe_dir: &Path) -> PathBuf {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| exe_dir.to_path_buf());
    let data_dir = local_app_data.join("Integrated Mod Manager (IMM)");
    if let Err(e) = fs::create_dir_all(&data_dir) {
        eprintln!("Failed to create runtime data directory: {e}");
        return exe_dir.to_path_buf();
    }
    migrate_legacy_runtime_files(exe_dir, &data_dir);
    data_dir
}

#[cfg(all(not(dev), not(target_os = "windows")))]
fn resolve_runtime_dir(exe_dir: &Path) -> PathBuf {
    exe_dir.to_path_buf()
}

fn main() {
    #[cfg(not(dev))]
    if let Ok(exe_path) = env::current_exe() {
        // Get the directory containing the executable
        if let Some(exe_dir) = exe_path.parent() {
            // Persist runtime state under local app data so updater installs don't wipe configs.
            let runtime_dir = resolve_runtime_dir(exe_dir);
            if let Err(e) = env::set_current_dir(runtime_dir) {
                eprintln!("Failed to set working directory: {}", e);
            }
        }
    }
    wuwa_mod_manager_lib::run()
}

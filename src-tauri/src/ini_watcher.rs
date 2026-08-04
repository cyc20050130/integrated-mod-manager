use log as tracing;
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const INI_STATE_EVENT: &str = "ini-state-changed";
const SUPPORTED_GAMES: &[&str] = &["WW", "ZZ", "GI", "SR", "EF"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedGamePaths {
    game: Option<String>,
    target_dir: String,
}

#[derive(Clone, Serialize)]
struct IniStateChanged {
    path: String,
}

struct IniWatcherState {
    path: PathBuf,
    _watcher: RecommendedWatcher,
}

static INI_WATCHER: Lazy<Mutex<Option<IniWatcherState>>> = Lazy::new(|| Mutex::new(None));

fn normalized_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('/', "\\");
    let normalized = normalized.strip_prefix(r"\\?\").unwrap_or(&normalized);
    if cfg!(windows) {
        normalized.to_ascii_lowercase()
    } else {
        normalized.to_owned()
    }
}

fn event_touches_ini(event: &Event, ini_path: &Path) -> bool {
    let expected = normalized_path(ini_path);
    event
        .paths
        .iter()
        .any(|candidate| normalized_path(candidate) == expected)
}

fn resolve_ini_state_path(config_dir: &Path, game: &str) -> Result<PathBuf, String> {
    if !SUPPORTED_GAMES.contains(&game) {
        return Err("INI state watching is supported only for registered XXMI games.".to_string());
    }
    let config_path = config_dir.join(format!("config{game}.json"));
    let config: PersistedGamePaths = serde_json::from_slice(
        &std::fs::read(&config_path)
            .map_err(|err| format!("Unable to read persisted {game} configuration: {err}"))?,
    )
    .map_err(|err| format!("Invalid persisted {game} configuration: {err}"))?;
    if config
        .game
        .as_deref()
        .is_some_and(|persisted| persisted != game)
    {
        return Err("Persisted game configuration does not match the requested game.".to_string());
    }
    if config.target_dir.trim().is_empty() {
        return Err("The configured game target folder is empty.".to_string());
    }
    let target = PathBuf::from(config.target_dir)
        .canonicalize()
        .map_err(|err| format!("Unable to resolve the configured game target folder: {err}"))?;
    let parent = target
        .parent()
        .ok_or_else(|| "The configured game target folder has no parent.".to_string())?;
    Ok(parent.join("d3dx_user.ini"))
}

fn create_ini_watcher<F>(ini_path: &Path, on_change: F) -> Result<RecommendedWatcher, String>
where
    F: Fn() + Send + Sync + 'static,
{
    let watched_parent = ini_path
        .parent()
        .ok_or_else(|| "The d3dx_user.ini path has no parent.".to_string())?
        .to_path_buf();
    let expected_path = ini_path.to_path_buf();
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| match result {
            Ok(event) if event_touches_ini(&event, &expected_path) => on_change(),
            Ok(_) => {}
            Err(err) => tracing::warn!("Native d3dx_user.ini watcher error: {}", err),
        },
        Config::default(),
    )
    .map_err(|err| format!("Unable to create native d3dx_user.ini watcher: {err}"))?;
    watcher
        .watch(&watched_parent, RecursiveMode::NonRecursive)
        .map_err(|err| format!("Unable to watch the d3dx_user.ini parent folder: {err}"))?;
    Ok(watcher)
}

#[tauri::command]
pub fn start_ini_state_watch(app_handle: AppHandle, game: String) -> Result<String, String> {
    let config_dir = std::env::current_dir()
        .map_err(|err| format!("Unable to resolve the runtime configuration folder: {err}"))?;
    let ini_path = resolve_ini_state_path(&config_dir, &game)?;
    let display_path = ini_path.to_string_lossy().into_owned();

    let mut state = INI_WATCHER
        .lock()
        .map_err(|_| "Native INI watcher state is unavailable.".to_string())?;
    if state
        .as_ref()
        .is_some_and(|current| normalized_path(&current.path) == normalized_path(&ini_path))
    {
        return Ok(display_path);
    }

    let emitted_path = display_path.clone();
    let watcher = create_ini_watcher(&ini_path, move || {
        if let Err(err) = app_handle.emit(
            INI_STATE_EVENT,
            IniStateChanged {
                path: emitted_path.clone(),
            },
        ) {
            tracing::warn!("Unable to emit native d3dx_user.ini change event: {}", err);
        }
    })?;
    *state = Some(IniWatcherState {
        path: ini_path,
        _watcher: watcher,
    });
    Ok(display_path)
}

#[tauri::command]
pub fn stop_ini_state_watch() -> Result<(), String> {
    let mut state = INI_WATCHER
        .lock()
        .map_err(|_| "Native INI watcher state is unavailable.".to_string())?;
    *state = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::EventKind;
    use std::fs;
    use std::sync::mpsc;
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn persisted_target_resolves_only_the_sibling_ini_path() {
        let temp = tempdir().expect("tempdir");
        let target = temp.path().join("WWMI").join("Mods");
        fs::create_dir_all(&target).expect("target");
        fs::write(
            temp.path().join("configWW.json"),
            serde_json::to_vec(&serde_json::json!({
                "game": "WW",
                "targetDir": target,
            }))
            .expect("config"),
        )
        .expect("write config");

        assert_eq!(
            normalized_path(&resolve_ini_state_path(temp.path(), "WW").expect("resolved path")),
            normalized_path(&target.parent().unwrap().join("d3dx_user.ini"))
        );
        assert!(resolve_ini_state_path(temp.path(), "NTE").is_err());
        assert!(resolve_ini_state_path(temp.path(), "UNKNOWN").is_err());
    }

    #[test]
    fn event_filter_accepts_only_the_exact_ini_path() {
        let ini = PathBuf::from(r"C:\\Games\\WWMI\\d3dx_user.ini");
        let exact = Event::new(EventKind::Any).add_path(ini.clone());
        let sibling =
            Event::new(EventKind::Any).add_path(PathBuf::from(r"C:\\Games\\WWMI\\d3dx.ini"));
        assert!(event_touches_ini(&exact, &ini));
        assert!(!event_touches_ini(&sibling, &ini));
    }

    #[test]
    fn native_watcher_observes_create_and_modify_without_recursive_scope() {
        let temp = tempdir().expect("tempdir");
        let ini = temp.path().join("d3dx_user.ini");
        let unrelated = temp.path().join("unrelated.ini");
        let (sender, receiver) = mpsc::channel();
        let _watcher = create_ini_watcher(&ini, move || {
            let _ = sender.send(());
        })
        .expect("watcher");

        fs::write(&unrelated, "ignored").expect("unrelated");
        fs::write(&ini, "[Include]").expect("ini");
        receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("exact INI event");
    }
}

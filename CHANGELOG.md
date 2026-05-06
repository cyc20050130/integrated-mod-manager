# Changelog

## 3.2.5 - 2026-05-07

### Fixed
- Switched XXMI config and importer file access to native Tauri commands so `%APPDATA%` paths are no longer blocked by frontend filesystem scope checks.
- Made default XXMI auto-discovery try both the direct Roaming folder and the sibling app-data case before giving up.

## 3.2.4 - 2026-05-06

### Fixed
- Corrected default XXMI auto-discovery to target the Roaming-level `XXMI Launcher` folder instead of the app-specific IMM data folder.
- Restored automatic detection of `XXMI Launcher Config.json` for standard XXMI installs under `%APPDATA%`.

## 3.2.3 - 2026-05-06

### Fixed
- Allowed IMM to access XXMI under `%APPDATA%`, so XXMI launcher detection and config reads no longer fail on standard installs.
- Added APPDATA coverage to filesystem, opener, and asset scopes used by XXMI paths and previews.

## 3.2.2 - 2026-05-06

### Fixed
- Prevented startup-time background health checks from overwriting runtime config with default values before initialization completes.
- Stopped launch-time config corruption that could clear the remembered game, language, and XXMI path and leave IMM stuck on the loading/intro flow.

## 3.2.1 - 2026-05-06

### Fixed
- Stopped startup from waiting on the updater check, so IMM can finish loading even if update networking is slow or stuck.
- Switched updater manifest resolution to the committed repository manifest and corrected installer asset URLs for signed update downloads.

## 3.2.0 - 2026-04-27

### Added
- Added GitHub Actions CI for lint, frontend tests, frontend build, and Rust library tests on Windows.
- Added shared `sanitizeHtml()` and `SafeHtml` helpers for external online content.

### Improved
- Sanitized online comments, GameBanana detail text, update notes, unified descriptions, and source notes before rendering.
- Prevented production unified WW online reads from falling back to local dev fixture cache files.
- Replaced the temporary duplicate-compare placeholder with an explicit unsupported error.
- Narrowed Tauri asset, filesystem, opener, and devtools permissions for release builds.

### Fixed
- Added `noreferrer noopener` protection to external browser links.
- Ignored generated local analysis, preview, output, fixture, and nested-copy directories.

## 3.1.9 - 2026-04-10

### Fixed
- Persisted live mod variable state from `d3dx_user.ini` while IMM is open, so in-game hotkey outfit and style changes no longer reset on the next launch.
- Added startup and pre-launch ini state sync to catch the latest XXMI runtime values before the game is started again.

## 3.1.8 - 2026-04-06

### Added
- Added blacklist controls for online and local mod detail panels so GameBanana-linked mods can be marked and unmarked directly from either side.
- Added bundled Wuwa Mod Fixer support so the fixer can be prepared, launched, and resynced from inside IMM.

### Improved
- Blacklisted mods now keep a visible warning state across the online browser, installed list ordering, and linked local entries that share the same source route.
- Improved release/runtime config recovery by merging newer configs and backup candidates more defensively during startup.

## 3.1.7 - 2026-04-04

### Fixed
- Stopped source-linked redownloads from overriding a correct online mod title with an older linked local name unless the path or normalized name clearly matches.
- Made post-install preview downloads skip the global idle wait and refresh local cards as soon as the preview file lands.

## 3.1.6 - 2026-04-04

### Fixed
- Removed the one-day delay that incorrectly hid freshly published IMM updates, so stable releases appear immediately in the updater.
- Replaced string-based version comparisons with numeric semantic version comparison in updater and config migration paths.

## 3.1.5 - 2026-04-04

### Fixed
- Moved runtime config storage to a dedicated LocalAppData data directory so updater installs no longer overwrite live config files.
- Changed startup migration from missing-file copy to incremental config merging, preserving newer source links, download queue state, presets, and categories.
- Hardened download directory creation by sanitizing category and mod path segments, truncating long segments, and persisting the actual created path for follow-up extract and validate steps.
- Fixed mixed slash normalization in shared path joining and made downloaded mod validation tolerate normalized runtime paths.
- Improved failed-download rename recovery so retried tasks prefer the best matching linked local mod name even when multiple entries share the same online source.

## 3.1.4 - 2026-04-04

### Added
- Added a full-game link integrity scanner (WW/ZZ/GI/SR/EF) that reports `matched`, `unlinked`, `orphans`, and `suggestedMappings` without mutating config data.
- Added a Settings entry to run scan on demand and export a JSON review report.
- Added startup preview backfill for linked mods missing local `preview.*`, with cooldown and low-priority throttling.

### Fixed
- Fixed retry/download path failures caused by invalid Windows filename segments (`os error 123`) by separating `displayName` (UI) from `safeName` (filesystem) and recomputing runtime keys on retry.
- Fixed failed retry tasks carrying stale path/key state by forcing clean runtime recomputation before redownload.

## 3.1.1 - 2026-04-04

### Fixed
- Fixed a retry-loop bug where resumed downloads could keep re-downloading after completion when extraction or local path errors occurred.
- Stopped automatic requeue for non-network failures (`extract` / `filesystem`) and path-not-found errors.
- Hardened downloader filesystem handling by ensuring the target directory exists and by reporting finalize/rename failures as filesystem errors.

### Improved
- Updated auto-updater endpoint to the new repository (`cyc20050130/integrated-mod-manager`).
- Prepared signed updater artifacts flow for desktop auto-update delivery.

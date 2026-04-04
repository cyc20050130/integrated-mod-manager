# Changelog

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

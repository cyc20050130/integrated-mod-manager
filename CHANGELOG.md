# Changelog

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

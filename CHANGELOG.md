# Changelog

## 3.1.1 - 2026-04-04

### Fixed
- Fixed a retry-loop bug where resumed downloads could keep re-downloading after completion when extraction or local path errors occurred.
- Stopped automatic requeue for non-network failures (`extract` / `filesystem`) and path-not-found errors.
- Hardened downloader filesystem handling by ensuring the target directory exists and by reporting finalize/rename failures as filesystem errors.

### Improved
- Updated auto-updater endpoint to the new repository (`cyc20050130/integrated-mod-manager`).
- Prepared signed updater artifacts flow for desktop auto-update delivery.

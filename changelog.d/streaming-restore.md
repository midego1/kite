### Added

- The [admin overview](/admin) shows the latest successful backup, its size and how long it took, whether automatic backups are on, and a warning with the error when the latest backup failed.
- Restore a backup straight from its row in [Admin → Backups](/backups), without downloading and uploading it again. The restored backup stays listed.

### Changed

- Restoring a backup no longer loads it into memory. The file is read from storage in pages, checked completely before anything changes, and written in batches, so a backup larger than the Worker's memory restores. The safety backup before every restore and the automatic rollback when a restore fails part way work as before, and an uploaded backup file is streamed to storage first instead of being held in the request.

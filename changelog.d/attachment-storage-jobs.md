### Added

- [Admin → Storage](/storage) has an **Attachment storage** card for the primary admin: how many files have a copy of their own, how many are served from their raw message, how many share a copy with a forward or a sent message, and how much space older mail could free. **Reclaim space** serves older received and imported files from their raw message when their bytes match and deletes the separate copies nobody else uses; **Restore separate copies** gives every file its own copy again. Both run in the background, show their progress, can be stopped and resume where they left off. Every file downloads byte for byte the same before and after. Needs migration 0090 (`0090_add_attachment_storage_job`), applied from the Admin overview; Reclaim space is unavailable while `ATTACHMENT_RAW_INDEX=off`.

### Changed

- Rolling back to a release before 2026.10.31.3, or before attachment sharing, now has one procedure: set `ATTACHMENT_SHARING=off` and `ATTACHMENT_RAW_INDEX=off`, deploy, choose **Restore separate copies** and wait until it reports no files served from the raw message and no shared copies, then roll back. See [Materialize, then roll back](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#materialize-then-roll-back).

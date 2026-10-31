### Fixed

- Files in received or imported mail no longer stay missing after an older Kite release restored a newer backup into a database without migration 0088. Once the migration is applied, the next time such a file is opened Kite finds it in the stored raw message again, and **Restore separate copies** under [Admin → Storage](/storage) now includes these files too. No migration or setting is needed.

### Changed

- The recovery runbook now has one section for rolling back and restoring backups across attachment sharing and raw-backed attachments: what each older release can read, the materialize procedure before a rollback, and what to expect after restoring an older or newer backup (choose **Reclaim space** after restoring a backup taken before a reclaim). See [Attachment storage: rollbacks and restores](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#attachment-storage-rollbacks-and-restores).

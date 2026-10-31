### Changed

- **Do not roll back to an older release once this one has run.** Older releases delete an attachment's file together with the message that has it, without checking whether another message shares it, so after a rollback deleting a forward draft, a sent draft or one of two messages that share a file would delete the other message's file too. Fix forward instead. If a rollback cannot be avoided, follow the [recovery runbook](https://github.com/midego1/kite/blob/main/docs/runbooks/recovery.md#rolling-back-past-attachment-sharing) first. Set the new environment variable `ATTACHMENT_SHARING=off` to stop new sharing (sends and forwards then store their own copies again); it is on by default. A backup taken after this release can only be restored into a database that has migration 0088 applied.
- Sending a draft and forwarding a message no longer store their attachments a second time: the sent message and the forward draft use the stored file of the draft or the original, so each file is kept once. Deleting a draft, a forward or a message removes a file only when no other message still uses it, and the database rows now go before the files, so a storage failure can leave an unused file behind but never a message whose attachment is missing. No migration is needed. Full backups, storage migrations and Admin → Storage count and copy a shared file once.

### Added

- `GET /api/admin/attachment-storage` (admins) reports how many attachment rows and stored files there are, and with `?verify=1` checks that the newest 200 stored files still exist.

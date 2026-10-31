### Changed

- Sending a draft and forwarding a message no longer store their attachments a second time: the sent message and the forward draft use the stored file of the draft or the original, so each file is kept once. Deleting a draft, a forward or a message removes a file only when no other message still uses it, and the database rows now go before the files, so a storage failure can leave an unused file behind but never a message whose attachment is missing. No migration or setting is needed.

### Added

- `GET /api/admin/attachment-storage` (admins) reports how many attachment rows and stored files there are, and with `?verify=1` checks that the newest 200 stored files still exist.

### Changed

- Database migration `0089_attachment_raw_storage` (apply it from the admin overview) prepares storing each mail attachment once: `message_attachments` gains the columns that let an attachment be served from its byte range of the stored raw message, and attachment objects no longer need a key of their own. Nothing is converted yet, and every attachment keeps downloading as before, also while the migration is still pending. Downloads, previews, inline images, large-attachment links, JMAP blobs, Save to Drive, forwarding, sending, the assistant and the risky-attachment check now all read attachments through one place, and full backups and storage migrations copy only attachments that have an object of their own. Design: `docs/specs/attachments-once.md`.

### Fixed

- On the self-hosted (Node/Docker) runtime, reading part of a stored file (the ZIP check of a risky attachment, a module reading the start of an attachment) no longer loads the whole file into memory first.

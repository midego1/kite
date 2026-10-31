# Backup and deployment recovery

## Preconditions

An authorized deployment operator owns production recovery. Mission agents must
not deploy, run remote migrations, or delete production data. Treat backup JSON,
objects and encryption keys as confidential; see [PII handling](../pii-handling.md).

## Failed deployment

1. Record the failing and last known-good revisions from the existing Workers
   Builds/deployment history, the UTC window and sanitized error type.
2. Check whether database migrations were applied after the good revision. A
   code rollback is unsafe if it cannot read the current schema. Review changed
   migrations and backup/restore compatibility before proposing a rollback.
3. Reproduce locally and prepare the fix or rollback recommendation. Run all
   `AGENTS.md` checks. Leave the actual Cloudflare rollback/redeploy to the
   operator under their production procedure.
4. After recovery the operator verifies availability, synthetic mail in both
   directions, pending jobs and backup schedule status. Record the revision and
   operator-confirmed results; do not infer success from build status alone.

## Rolling back past attachment sharing

Since attachment sharing (`docs/specs/attachments-once.md` §5.3), a message sent
from a draft and a forward draft name the stored file of the row they came from
instead of copying it, and deletes remove a file only when no row names it any
more. Every earlier release deletes a message's attachment files unconditionally.
Running one of them against data written by a sharing release loses files: deleting
a forward draft deletes the original's attachment, sending a draft and then
deleting the draft deletes the sent copy's file, and deleting either of two
messages that share a file deletes it for both.

1. Prefer fixing forward. A rollback is safe only to a release that already has
   reference-checked deletion (this one or later).
2. If an older release must run, first set `ATTACHMENT_SHARING=off` on the
   current release (Worker variable, or the Node environment) so no new rows
   share an object, and deploy that.
3. Give every shared row its own copy before the rollback. The admin
   "materialize" job (`docs/specs/attachments-once.md` §8 step 5) does this once it
   exists: it copies each object that more than one row names to a new key per
   extra row. Until it exists, do not roll back past this release; if you must,
   expect files of forwarded and sent mail to go missing when drafts or messages
   are deleted, and use `GET /api/admin/attachment-storage?verify=1` afterwards to
   list the messages whose files are gone.
4. Restoring a backup taken after this release into a database without migration
   0088 fails on the unique `r2_key` index, because shared rows repeat a key. Apply
   the pending migrations on the target first (Admin overview, or
   `AUTO_APPLY_MIGRATIONS=1`), then restore.

## Rolling back past raw-backed attachments

Since raw-backed attachments (`docs/specs/attachments-once.md` §8 step 4), a file
in received or imported mail whose bytes Kite verified inside the raw message has
no object of its own: its row carries the sentinel key `raw:<id>` and the byte
range to read from the raw message. Releases from 2026.10.31.3 on read such rows.
Earlier releases do not: they look the sentinel up as an object key and answer
404 for those files (the raw message and "Show original" are unaffected).

1. Prefer fixing forward. A rollback to 2026.10.31.3 or later keeps every file
   readable; the attachment-sharing rules above still apply to it.
2. Before running an older release, set `ATTACHMENT_RAW_INDEX=off` on the current
   release (Worker variable, or the Node environment) and deploy that, so new mail
   stores a copy of each file again.
3. Give every raw-backed row an object of its own. The admin "materialize" job
   (`docs/specs/attachments-once.md` §8 step 5) does this once it exists. Until it
   exists, files of mail received while raw-backed attachments were on do not
   download on an older release; nothing is lost, since the raw messages are kept
   unchanged, and they download again once a current release runs.
4. A backup taken after this release and restored into a release before
   2026.10.31.3 has the same 404s; restore it into a current release instead.
5. An old backup restored into a current release can name objects that are gone.
   The next read of such a file rebuilds it from its raw message (logged as
   `attachment.repaired`), so it needs no action.

## Backup or restore incident

1. Review the latest successful backup record in **Admin → Backups**, its
   selected groups, completion time and expected deployment retention setting.
   A cron configured in source does not prove it ran successfully in production.
2. Inspect export failures before making a new snapshot. Table additions must
   appear in `BACKUP_TABLES` and exactly one backup table group, with foreign-key
   order preserved (`src/lib/backups/export.ts` and `table-groups.ts`).
3. Preserve a pre-restore snapshot and object-storage recovery plan. Database
   JSON alone may not recover all message/attachment objects. Retain access to
   the applicable stored-secret encryption key through an approved secret store.
4. Rehearse against an isolated local database with a synthetic backup covering
   the relevant schema version. Test both old-backup compatibility and current
   groups. Never download a production backup into the Mission workspace.
5. Document snapshot timestamp, selected groups, estimated loss window and
   recovery steps; obtain the operator's explicit approval for destructive
   restore before they use the existing admin restore flow. A backup still in
   storage is restored from its row in **Admin → Backups**, without a download
   and upload, whatever its size.
6. The operator verifies restored account/mailbox access, expected record counts,
   object retrieval, sending/receiving and future backup completion. Reapply
   deletion requests newer than the restored snapshot. Keep evidence restricted.

See [deployment and backup behavior](../deployment.md). A successful build or
backup row is not proof of restore integrity; record the verification performed.

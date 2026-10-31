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

Prefer fixing forward: a rollback is safe only to a release that already has
reference-checked deletion (this one or later). To run an older release, follow
[Materialize, then roll back](#materialize-then-roll-back) first. Restoring a backup
taken after this release into a database without migration 0088 fails on the unique
`r2_key` index, because shared rows repeat a key: apply the pending migrations on the
target first (Admin overview, or `AUTO_APPLY_MIGRATIONS=1`), then restore.

## Rolling back past raw-backed attachments

Since raw-backed attachments (`docs/specs/attachments-once.md` §8 step 4), a file
in received or imported mail whose bytes Kite verified inside the raw message has
no object of its own: its row carries the sentinel key `raw:<id>` and the byte range
to read from the raw message. Releases from 2026.10.31.3 on read such rows. Earlier
releases do not: they look the sentinel up as an object key and answer 404 for those
files (the raw message and "Show original" are unaffected). Nothing is lost: the raw
messages are kept unchanged, and the files download again once a current release
runs.

Prefer fixing forward: a rollback to 2026.10.31.3 or later keeps every file readable
(the attachment-sharing rules above still apply to it). To run an older release,
follow [Materialize, then roll back](#materialize-then-roll-back) first.

- A backup taken after this release and restored into a release before 2026.10.31.3
  has the same 404s; restore it into a current release instead, or materialize there
  before moving the data back.
- An old backup restored into a current release can name objects that are gone (a
  reclaim deleted them after the backup). The next read of such a file rebuilds it
  from its raw message (logged as `attachment.repaired`), so it needs no action;
  **Reclaim space** converts whatever is left.

## Materialize, then roll back

The procedure before running a release older than attachment sharing or raw-backed
attachments. Materialize never changes a raw message; it only writes objects and
repoints rows with conditional updates, so it is safe to run at any time and again.

1. On the current release, set `ATTACHMENT_SHARING=off` and `ATTACHMENT_RAW_INDEX=off`
   (Worker variables, or the Node environment) and deploy that. New sends and
   forwards then store their own copy of each file, and new mail stores a copy of
   each attachment again.
2. As the primary admin, open **Admin → Storage → Attachment storage** and choose
   **Restore separate copies** (`POST /api/admin/attachment-storage` with
   `{ "action": "materialize" }`). The job gives every file served from its raw
   message an object of its own, then copies every object that more than one row
   names to a new key for each row after the first. It runs in the background in
   batches and the card shows its progress. A job that stopped (a deploy, a lost
   queue message) is restarted by the five-minute cron within the hour, or resumes
   from where it was when you press the button again.
3. Wait until the card says **Separate copies restored** and shows 0 files from the
   raw message and 0 shared copies (`raw.rows` and `shared.rows` in
   `GET /api/admin/attachment-storage`). Files whose raw message or object was already
   gone are counted as "could not be processed" and stay as they were; they are
   missing on every release.
4. Check `GET /api/admin/attachment-storage?verify=1`: `verify.missing` lists the
   messages whose files are gone, and should be empty.
5. Take a database backup (with **Include mail files** if you use full backups), then
   roll back. With both switches off nothing new shares a file or is served from a
   raw message, so the counts stay at 0 until you upgrade again.
6. Back on a current release, remove the two variables and choose **Reclaim space** on
   the same card (`{ "action": "reclaim" }`, which needs `ATTACHMENT_RAW_INDEX` on). It
   serves verified files from their raw messages again and deletes their copies;
   copies that a draft, a forward or a sent message still uses are kept.

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

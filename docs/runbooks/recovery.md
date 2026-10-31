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

## Attachment storage: rollbacks and restores

Two changes store mail attachments once (`docs/specs/attachments-once.md`):

- **Attachment sharing** (2026.10.31.8): a message sent from a draft and a forward
  draft name the stored file of the row they came from instead of copying it, and
  deletes remove a file only when no row names it any more.
- **Raw-backed attachments** (2026.10.31.9): a file in received or imported mail whose
  bytes Kite verified inside the raw message has no object of its own. Its row carries
  the sentinel key `raw:<id>` and the byte range to read from the raw message
  (migration 0088). Releases from 2026.10.31.3 on can read such rows.

Prefer fixing forward. A rollback to 2026.10.31.8 or later needs no preparation. Any
older release needs [Materialize, then roll back](#materialize-then-roll-back) first,
for the reasons in the next two sections.

### Rolling back past attachment sharing

Every release before 2026.10.31.8 deletes a message's attachment files
unconditionally. Running one of them against data written by a sharing release
loses files: deleting a forward draft deletes the original's attachment, sending a
draft and then deleting the draft deletes the sent copy's file, and deleting either
of two messages that share a file deletes it for both. Materialize gives every row a
file of its own first.

### Rolling back past raw-backed attachments

Releases before 2026.10.31.3 look the sentinel `raw:<id>` up as an object key and
answer 404 for those files (the raw message and "Show original" are unaffected).
Nothing is lost: the raw messages are kept unchanged, and the files download again
once a current release runs against the same database. Releases from 2026.10.31.3 to
2026.10.31.7 read them, but delete shared files as described above.

### Materialize, then roll back

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

### Restoring a backup across these releases

A backup holds database rows only (and, with **Include mail files**, the raw messages
and the objects that rows name); the storage columns travel in its JSON. A current
release refuses to restore while database updates are pending: apply them on the
target first (Admin overview, or `AUTO_APPLY_MIGRATIONS=1`).

- **An older backup into a current release** (taken before 0088, or before a reclaim
  ran): it restores. Rows from before 0088 come back as files with a copy of their
  own that reclaim has not looked at yet. A row whose copy a reclaim deleted after
  the backup names an object that is gone: `?verify=1` lists it as missing, and the
  next read rebuilds it from its raw message (logged as `attachment.repaired`), so
  nothing needs to be done before users open their mail. Then choose **Reclaim space**:
  it converts the rows nobody opened yet and deletes the copies the backup brought
  back, so the counts end where they were before the restore.
- **The job in the backup.** The restore brings back the attachment storage job as
  the backup recorded it. The cron restarts a stopped job only within an hour of its
  last batch, so a job from an older backup starts nothing: the card shows it as
  interrupted (or finished), and pressing its button again resumes it on the restored
  rows. Batches of the job that ran before the restore are dropped.
- **A newer backup into an older release, on a database that has migration 0088**
  (a rolled-back release): releases before 2026.10.31.3 show files served from the
  raw message as missing, as above. Restore it into a current release instead, or
  materialize before taking the backup.
- **A newer backup into an older release, on a database without migration 0088** (an
  install that never ran it): rows that share a file repeat a key, which the unique
  index refuses, so the restore fails and is rolled back. Without shared rows the
  restore succeeds but drops where each raw-served file sits in its raw message;
  those files are missing until a current release runs with migration 0088 applied.
  Then the next read finds each one in its raw message again (`attachment.repaired`),
  and **Restore separate copies** includes them. Materialize before taking the
  backup to avoid both.

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

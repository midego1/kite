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
   restore before they use the existing admin restore flow.
6. The operator verifies restored account/mailbox access, expected record counts,
   object retrieval, sending/receiving and future backup completion. Reapply
   deletion requests newer than the restored snapshot. Keep evidence restricted.

See [deployment and backup behavior](../deployment.md). A successful build or
backup row is not proof of restore integrity; record the verification performed.

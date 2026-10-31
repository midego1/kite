-- The admin attachment storage job (docs/specs/attachments-once.md §5.5): one JSON value naming the running or last
-- reclaim or materialize job, its phase, keyset cursor, lease and counters. A NULL means no job has run. The
-- attachment rows themselves stay the source of truth, so a restored backup carrying a stale value only shows an
-- interrupted job that can be started again.
ALTER TABLE `app_settings` ADD `attachment_storage_job` text;

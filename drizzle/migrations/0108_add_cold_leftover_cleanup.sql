-- Cleanup of cold storage leftovers (src/lib/storage/cold-leftovers.ts): `storage_cold_orphans.unreferenced_since`
-- is when a check first saw the leftover's object referenced by nothing at all (null while it is only a superseded
-- copy of an object that is still in use), the start of the window in which no retained backup may hold a
-- reference before the copy can go; `kept_reason` is why the last cleanup kept it, for Admin → Storage.
-- `storage_state.leftover_cleanup` holds the JSON settings (automatic cleanup, grace period) and the last run.
ALTER TABLE `storage_cold_orphans` ADD `unreferenced_since` integer;--> statement-breakpoint
ALTER TABLE `storage_cold_orphans` ADD `kept_reason` text;--> statement-breakpoint
ALTER TABLE `storage_state` ADD `leftover_cleanup` text;

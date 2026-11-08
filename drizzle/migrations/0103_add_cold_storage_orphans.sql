-- The cold storage orphan sweep (round-3 review of #446, src/lib/storage/cold.ts) tracks copies that lost their
-- only reference as candidates in their own table, deleting each only after a grace period that re-checks
-- references at delete time, instead of deleting on first sighting (which a backup restore's "deletes" segment
-- could make look like every cold copy at once). It also tracks the losing side of two deliveries that raced to
-- different targets for the same key, and a migration's cold-moved copy left behind once the object becomes
-- reachable the normal way again, neither of which `object_locations` alone has room for (one row per key).
-- `first_orphaned_at` (round-5 review) is never bumped by a deferral, unlike `orphaned_at`: it bounds the window
-- in which a completed backup could still hold a reference to this exact copy, so a backup taken long after a
-- copy was superseded is no longer a reason to keep it forever. `storage_key_leases` (same review) serializes a
-- cold move and the delete pass per key, so neither can delete the only copy the other just confirmed.
CREATE TABLE `storage_cold_orphans` (`id` text PRIMARY KEY NOT NULL, `store_id` text NOT NULL, `key` text NOT NULL, `object_class` text NOT NULL, `moved_at` integer NOT NULL, `orphaned_at` integer NOT NULL, `first_orphaned_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `storage_cold_orphans_store_key_idx` ON `storage_cold_orphans` (`store_id`,`key`);--> statement-breakpoint
CREATE INDEX `storage_cold_orphans_orphaned_at_idx` ON `storage_cold_orphans` (`orphaned_at`);--> statement-breakpoint
CREATE INDEX `object_locations_moved_at_key_idx` ON `object_locations` (`moved_at`,`key`);--> statement-breakpoint
ALTER TABLE `storage_state` ADD `cold_orphan_cursor` text;--> statement-breakpoint
CREATE INDEX `drive_items_object_key_idx` ON `drive_items` (`object_key`) WHERE `object_key` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `backups_r2_key_idx` ON `backups` (`r2_key`) WHERE `r2_key` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `storage_key_leases` (`key` text PRIMARY KEY NOT NULL, `lease_until` integer NOT NULL);

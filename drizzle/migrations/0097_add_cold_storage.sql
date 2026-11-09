-- Cold storage (ROADMAP Milestone 7 item 3, docs/specs/drive-storage.md §10). One rule per routable class: how
-- old and how big an object has to be before it moves to R2's Infrequent Access class or a second configured
-- store, and whether that rule is on. `object_locations` is the mail and backups fallback the read chain consults
-- on a miss (src/lib/storage/router.ts); Drive files record their own `store_id`/`storage_class` instead
-- (`drive_items`, below). `storage_cold_jobs` is one continuously-resumed sweep per class, on the same
-- claim/lease/batch pattern as `storage_migrations`.
CREATE TABLE `storage_cold_rules` (`object_class` text PRIMARY KEY NOT NULL, `after_days` integer NOT NULL, `min_bytes` integer DEFAULT 0 NOT NULL, `target` text NOT NULL, `enabled` integer DEFAULT false NOT NULL, `updated_at` integer NOT NULL, `updated_by` text REFERENCES `users`(`id`) ON DELETE set null);--> statement-breakpoint
CREATE TABLE `object_locations` (`key` text PRIMARY KEY NOT NULL, `object_class` text NOT NULL, `store_id` text NOT NULL, `storage_class` text, `size` integer NOT NULL, `moved_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `object_locations_class_idx` ON `object_locations` (`object_class`);--> statement-breakpoint
CREATE TABLE `storage_cold_jobs` (`object_class` text PRIMARY KEY NOT NULL, `status` text DEFAULT 'queued' NOT NULL, `cursor` text, `objects_done` integer DEFAULT 0 NOT NULL, `bytes_done` integer DEFAULT 0 NOT NULL, `errors` integer DEFAULT 0 NOT NULL, `last_error` text, `created_at` integer NOT NULL, `started_at` integer, `finished_at` integer);--> statement-breakpoint
ALTER TABLE `drive_items` ADD `storage_class` text;

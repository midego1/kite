-- Full backups: Admin → Backups can also copy the objects mail lives on (raw MIME, attachments and offloaded HTML
-- bodies) next to each database backup, under `backups/objects/<date>-<backup id>/` with a manifest. Off by default.
-- `objects_status` is null for a database-only backup, else `copying`, `completed`, `failed` or `restoring`;
-- `objects_updated_at` is the copy's heartbeat, so an interrupted copy is marked failed like an interrupted export.
ALTER TABLE `backup_settings` ADD `include_objects` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `backups` ADD `objects_status` text;--> statement-breakpoint
ALTER TABLE `backups` ADD `objects_prefix` text;--> statement-breakpoint
ALTER TABLE `backups` ADD `objects_count` integer;--> statement-breakpoint
ALTER TABLE `backups` ADD `objects_size` integer;--> statement-breakpoint
ALTER TABLE `backups` ADD `objects_missing` integer;--> statement-breakpoint
ALTER TABLE `backups` ADD `objects_updated_at` integer;--> statement-breakpoint
-- A new install (no account yet: setup and the Node runtime apply every migration before the first user exists)
-- backs up daily and keeps 14 days of backups. Existing installs keep their settings.
UPDATE `backup_settings` SET `enabled` = 1, `schedule_type` = 'daily', `schedule_value` = NULL, `retention_enabled` = 1, `retention_days` = 14
WHERE `id` = 'default' AND NOT EXISTS (SELECT 1 FROM `users`);

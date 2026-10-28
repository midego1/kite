ALTER TABLE `import_jobs` ADD `scope` text DEFAULT 'folder' NOT NULL;--> statement-breakpoint
ALTER TABLE `import_jobs` ADD `options` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `import_jobs` ADD `estimate_bytes` integer;--> statement-breakpoint
ALTER TABLE `import_jobs` ADD `pause_reason` text;--> statement-breakpoint
ALTER TABLE `import_jobs` ADD `paused_at` integer;--> statement-breakpoint
CREATE TABLE `import_job_folders` (`id` text PRIMARY KEY NOT NULL, `job_id` text NOT NULL REFERENCES `import_jobs`(`id`) ON DELETE cascade, `position` integer NOT NULL, `source_name` text NOT NULL, `role` text NOT NULL, `destination` text NOT NULL, `uidvalidity` integer, `total` integer, `total_bytes` integer, `cursor_uid` integer, `processed` integer DEFAULT 0 NOT NULL, `imported` integer DEFAULT 0 NOT NULL, `skipped` integer DEFAULT 0 NOT NULL, `multi_label` integer DEFAULT 0 NOT NULL, `status` text DEFAULT 'pending' NOT NULL, `last_error` text, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `import_job_folders_job_idx` ON `import_job_folders` (`job_id`,`position`);

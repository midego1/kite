CREATE TABLE `module_settings` (`id` text PRIMARY KEY NOT NULL, `module_id` text NOT NULL, `enabled` integer DEFAULT true NOT NULL, `updated_at` integer NOT NULL, `updated_by` text REFERENCES `users`(`id`) ON DELETE set null);--> statement-breakpoint
CREATE UNIQUE INDEX `module_settings_module_id_unique` ON `module_settings` (`module_id`);--> statement-breakpoint
CREATE TABLE `user_module_access` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `module_id` text NOT NULL, `allowed` integer DEFAULT true NOT NULL, `updated_at` integer NOT NULL, `updated_by` text REFERENCES `users`(`id`) ON DELETE set null);--> statement-breakpoint
CREATE UNIQUE INDEX `user_module_access_user_module_unique` ON `user_module_access` (`user_id`,`module_id`);--> statement-breakpoint
CREATE TABLE `booking_appointments` (`calendar_event_id` text PRIMARY KEY NOT NULL REFERENCES `calendar_events`(`id`) ON DELETE cascade, `booking_event_id` text REFERENCES `booking_events`(`id`) ON DELETE set null, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `booking_appointments_booking_event_idx` ON `booking_appointments` (`booking_event_id`);--> statement-breakpoint
INSERT INTO `module_settings` (`id`, `module_id`, `enabled`, `updated_at`) VALUES ('calendar', 'calendar', 1, unixepoch()), ('booking', 'booking', 1, unixepoch()), ('templates', 'templates', 1, unixepoch()), ('import', 'import', 1, unixepoch());--> statement-breakpoint
-- Search over calendar events, built like messages_fts (0030): an external-content
-- FTS5 index whose triggers keep it in step with every insert, update and delete.
CREATE VIRTUAL TABLE `calendar_events_fts` USING fts5(
	`title`,
	`description`,
	`location`,
	`attendees`,
	content='calendar_events',
	content_rowid='rowid',
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `calendar_events_fts_ai` AFTER INSERT ON `calendar_events` BEGIN
	INSERT INTO `calendar_events_fts`(`rowid`, `title`, `description`, `location`, `attendees`)
	VALUES (new.`rowid`, new.`title`, new.`description`, new.`location`, new.`attendees`);
END;--> statement-breakpoint
CREATE TRIGGER `calendar_events_fts_ad` AFTER DELETE ON `calendar_events` BEGIN
	INSERT INTO `calendar_events_fts`(`calendar_events_fts`, `rowid`, `title`, `description`, `location`, `attendees`)
	VALUES ('delete', old.`rowid`, old.`title`, old.`description`, old.`location`, old.`attendees`);
END;--> statement-breakpoint
CREATE TRIGGER `calendar_events_fts_au` AFTER UPDATE OF `title`, `description`, `location`, `attendees` ON `calendar_events` BEGIN
	INSERT INTO `calendar_events_fts`(`calendar_events_fts`, `rowid`, `title`, `description`, `location`, `attendees`)
	VALUES ('delete', old.`rowid`, old.`title`, old.`description`, old.`location`, old.`attendees`);
	INSERT INTO `calendar_events_fts`(`rowid`, `title`, `description`, `location`, `attendees`)
	VALUES (new.`rowid`, new.`title`, new.`description`, new.`location`, new.`attendees`);
END;--> statement-breakpoint
INSERT INTO `calendar_events_fts`(`calendar_events_fts`) VALUES ('rebuild');

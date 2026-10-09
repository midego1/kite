ALTER TABLE `users` ADD `send_preview_enabled` integer DEFAULT false NOT NULL;
ALTER TABLE `users` ADD `undo_send_seconds` integer DEFAULT 0 NOT NULL;

-- Linked WebDAV folders in Drive (ROADMAP milestone 7 item 4, spec drive-storage.md §11). One row per folder a user
-- links: `base_url` is the folder itself (ending in `/`), `password` the app password sealed with
-- APP_ENCRYPTION_KEY. Listings and transfers are proxied to the server, so nothing of the folder's contents is stored.
-- In the `drive` backup group without the password; a restored row is `auth_failed` until its owner enters it again.
CREATE TABLE `drive_mounts` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `kind` text DEFAULT 'webdav' NOT NULL, `label` text NOT NULL, `base_url` text NOT NULL, `username` text NOT NULL, `password` text NOT NULL, `status` text DEFAULT 'ok' NOT NULL, `last_error` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `drive_mounts_owner_idx` ON `drive_mounts` (`owner_id`);--> statement-breakpoint
-- Uploads to linked folders in progress, one lease row each, so one user has at most 20 at a time across isolates.
-- A row outlives a crashed request only until `expires_at`. Internal: never in a backup.
CREATE TABLE `drive_mount_uploads` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `expires_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `drive_mount_uploads_owner_idx` ON `drive_mount_uploads` (`owner_id`, `expires_at`);

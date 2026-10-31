-- Store each attachment once (docs/specs/attachments-once.md). A row with storage 'raw' is served from the byte range
-- [raw_offset, raw_offset + raw_length) of its message's raw MIME, decoded by transfer_encoding ('base64' or
-- 'identity'); its r2_key is the sentinel 'raw:<id>', which never resolves to an object. sha256 is the hex digest of
-- the decoded bytes and storage_checked_at marks a row the reclaim job has looked at. Object keys may later be shared
-- by several rows (a forward or a send reuses its draft's objects), so r2_key is no longer unique. Every existing row
-- keeps 'object' and its own key: nothing is converted by this migration.
ALTER TABLE `message_attachments` ADD `storage` text DEFAULT 'object' NOT NULL;--> statement-breakpoint
ALTER TABLE `message_attachments` ADD `raw_offset` integer;--> statement-breakpoint
ALTER TABLE `message_attachments` ADD `raw_length` integer;--> statement-breakpoint
ALTER TABLE `message_attachments` ADD `transfer_encoding` text;--> statement-breakpoint
ALTER TABLE `message_attachments` ADD `sha256` text;--> statement-breakpoint
ALTER TABLE `message_attachments` ADD `storage_checked_at` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `message_attachments_r2_key_unique`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_attachments_r2_key_idx` ON `message_attachments` (`r2_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_attachments_sha256_idx` ON `message_attachments` (`sha256`, `size`);

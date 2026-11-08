-- Assistant by email (docs/specs/assistant-by-email.md): one assistant address per domain, shared by every user who
-- opts in; verified extra addresses a user may send the assistant from; and one row per request the assistant
-- accepted (a request that fails authentication, sender mapping or a guard never gets one). The three
-- `assistant_email_*` columns on `user_ai_settings` are read and written through `src/lib/db/pending-columns.ts`.
CREATE TABLE `assistant_addresses` (`id` text PRIMARY KEY NOT NULL, `domain_id` text NOT NULL REFERENCES `domains`(`id`) ON DELETE cascade, `local_part` text NOT NULL, `enabled` integer DEFAULT 1 NOT NULL, `created_by_user_id` text REFERENCES `users`(`id`) ON DELETE set null, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_addresses_address_idx` ON `assistant_addresses` (`domain_id`,`local_part`);--> statement-breakpoint
CREATE TABLE `assistant_sender_addresses` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `address` text NOT NULL, `code_hash` text, `code_expires_at` integer, `verified_at` integer, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_sender_addresses_address_idx` ON `assistant_sender_addresses` (`address`);--> statement-breakpoint
CREATE INDEX `assistant_sender_addresses_user_idx` ON `assistant_sender_addresses` (`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_email_requests` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `assistant_address_id` text REFERENCES `assistant_addresses`(`id`) ON DELETE set null, `mailbox_id` text REFERENCES `mailboxes`(`id`) ON DELETE set null, `conversation_id` text REFERENCES `agent_conversations`(`id`) ON DELETE set null, `raw_r2_key` text, `provider_message_id` text NOT NULL, `reply_message_id` text, `from_addr` text NOT NULL, `subject` text, `status` text DEFAULT 'queued' NOT NULL, `reason` text, `created_at` integer NOT NULL, `completed_at` integer);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_email_requests_message_idx` ON `assistant_email_requests` (`user_id`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `assistant_email_requests_user_idx` ON `assistant_email_requests` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `assistant_email_requests_reply_idx` ON `assistant_email_requests` (`reply_message_id`);--> statement-breakpoint
ALTER TABLE `user_ai_settings` ADD `assistant_email_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_ai_settings` ADD `assistant_email_mailbox_id` text REFERENCES `mailboxes`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `user_ai_settings` ADD `assistant_email_daily_limit` integer DEFAULT 20 NOT NULL;

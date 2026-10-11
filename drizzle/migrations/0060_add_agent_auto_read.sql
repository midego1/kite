ALTER TABLE `mailbox_agent_settings` ADD `autonomy` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `capabilities` text DEFAULT '{"calendar":true,"reply":true,"summary":true,"phishing":true}' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `triage_model_id` text;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `auto_read_daily_limit` integer DEFAULT 200 NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `daily_spend_cap_micros` integer;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `paused_until` integer;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `full_auto_hold_minutes` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `agent_auto_read_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `agent_full_auto_allowed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `agent_daily_spend_cap_micros` integer DEFAULT 2000000 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `agent_external_auto_read_allowed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_jobs` ADD `kind` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
DROP INDEX `agent_jobs_source_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_jobs_source_idx` ON `agent_jobs` (`mailbox_id`,`source_message_id`,`kind`);--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `mailbox_id` text REFERENCES `mailboxes`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `job_id` text;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `reserved` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `ai_usage_mailbox_created_idx` ON `ai_usage` (`mailbox_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `ical_uid` text;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `ical_sequence` integer;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `organizer` text;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `source_message_id` text REFERENCES `messages`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `status` text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
CREATE INDEX `calendar_events_ical_uid_idx` ON `calendar_events` (`user_id`,`ical_uid`);--> statement-breakpoint
CREATE TABLE `agent_suggestions` (`id` text PRIMARY KEY NOT NULL, `mailbox_id` text NOT NULL REFERENCES `mailboxes`(`id`) ON DELETE cascade, `message_id` text NOT NULL REFERENCES `messages`(`id`) ON DELETE cascade, `thread_id` text, `job_id` text REFERENCES `agent_jobs`(`id`) ON DELETE set null, `reviewer_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `kind` text NOT NULL, `status` text DEFAULT 'open' NOT NULL, `title` text NOT NULL, `payload` text DEFAULT '{}' NOT NULL, `draft_id` text REFERENCES `messages`(`id`) ON DELETE set null, `confidence` integer, `model` text, `created_at` integer NOT NULL, `decided_at` integer, `decided_by_user_id` text REFERENCES `users`(`id`) ON DELETE set null, `expires_at` integer);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_suggestions_message_kind_idx` ON `agent_suggestions` (`message_id`,`kind`);--> statement-breakpoint
CREATE INDEX `agent_suggestions_mailbox_status_idx` ON `agent_suggestions` (`mailbox_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_actions` (`id` text PRIMARY KEY NOT NULL, `mailbox_id` text NOT NULL REFERENCES `mailboxes`(`id`) ON DELETE cascade, `suggestion_id` text REFERENCES `agent_suggestions`(`id`) ON DELETE set null, `message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `job_id` text, `initiator` text NOT NULL, `acting_user_id` text REFERENCES `users`(`id`) ON DELETE set null, `autonomy` text, `action` text NOT NULL, `variant` text DEFAULT '' NOT NULL, `status` text DEFAULT 'pending' NOT NULL, `before` text, `after` text, `reason` text, `undo_until` integer, `undone_at` integer, `undone_by_user_id` text REFERENCES `users`(`id`) ON DELETE set null, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `agent_actions_mailbox_created_idx` ON `agent_actions` (`mailbox_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_actions_live_idx` ON `agent_actions` (`suggestion_id`,`action`,`variant`) WHERE `status` IN ('pending', 'applied');--> statement-breakpoint
CREATE TABLE `agent_sender_policies` (`id` text PRIMARY KEY NOT NULL, `mailbox_id` text NOT NULL REFERENCES `mailboxes`(`id`) ON DELETE cascade, `pattern` text NOT NULL, `require_auth` integer DEFAULT 1 NOT NULL, `allowed_actions` text DEFAULT '[]' NOT NULL, `template_rule` text, `created_by_user_id` text REFERENCES `users`(`id`) ON DELETE set null, `created_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sender_policies_pattern_idx` ON `agent_sender_policies` (`mailbox_id`,`pattern`);

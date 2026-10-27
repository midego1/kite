ALTER TABLE `mailbox_agent_settings` ADD `chat_instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `draft_instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `summary_instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE `user_ai_settings` (`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `writing_style_enabled` integer DEFAULT false NOT NULL, `instructions` text DEFAULT '' NOT NULL, `chat_instructions` text DEFAULT '' NOT NULL, `draft_instructions` text DEFAULT '' NOT NULL, `summary_instructions` text DEFAULT '' NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
ALTER TABLE `app_settings` ADD `agent_auto_read_token_cap` integer DEFAULT 2000000 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `agent_chat_token_cap` integer DEFAULT 2000000 NOT NULL;

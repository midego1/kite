ALTER TABLE `mailbox_agent_settings` ADD `chat_instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `draft_instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `summary_instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE `user_ai_settings` (`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE cascade, `writing_style_enabled` integer DEFAULT false NOT NULL, `instructions` text DEFAULT '' NOT NULL, `chat_instructions` text DEFAULT '' NOT NULL, `draft_instructions` text DEFAULT '' NOT NULL, `summary_instructions` text DEFAULT '' NOT NULL, `updated_at` integer NOT NULL);

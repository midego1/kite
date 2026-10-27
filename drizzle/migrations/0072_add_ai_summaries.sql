-- Thread summaries (docs/specs/thread-summaries.md): `ai_summaries` caches the Summarize button's conversation and
-- message summaries, their translations and one-line list summaries, keyed by mailbox and conversation.
-- A summary repeats what its messages said, so it goes with them: `message` and `line` rows cascade with their
-- message, and the triggers below remove the conversation's `thread` rows (and every row of the message itself)
-- when a message is deleted or leaves the summarised statuses, for example to Spam or Trash. Translations go with
-- their source row. The three mailbox settings are for one-line summaries in the message list.
CREATE TABLE `ai_summaries` (`id` text PRIMARY KEY NOT NULL, `mailbox_id` text NOT NULL REFERENCES `mailboxes`(`id`) ON DELETE cascade, `kind` text NOT NULL, `thread_key` text NOT NULL, `message_id` text REFERENCES `messages`(`id`) ON DELETE cascade, `text` text NOT NULL, `coverage_digest` text NOT NULL, `covered_count` integer DEFAULT 0 NOT NULL, `source` text NOT NULL, `model` text, `language` text DEFAULT 'und' NOT NULL, `translation_of` text REFERENCES `ai_summaries`(`id`) ON DELETE cascade, `instructions_digest` text DEFAULT '' NOT NULL, `created_by_user_id` text REFERENCES `users`(`id`) ON DELETE set null, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_summaries_key_idx` ON `ai_summaries` (`mailbox_id`, `kind`, `thread_key`, coalesce(`message_id`, ''), `instructions_digest`, `language`);--> statement-breakpoint
CREATE INDEX `ai_summaries_message_idx` ON `ai_summaries` (`message_id`);--> statement-breakpoint
CREATE INDEX `ai_summaries_translation_of_idx` ON `ai_summaries` (`translation_of`);--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `list_summaries` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `list_summaries_bulk` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD `list_summary_daily_limit` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
CREATE TRIGGER `ai_summaries_messages_ad` AFTER DELETE ON `messages` BEGIN
	DELETE FROM `ai_summaries` WHERE `translation_of` IN (SELECT `id` FROM `ai_summaries` WHERE (`kind` = 'thread' AND `mailbox_id` = old.`mailbox_id` AND `thread_key` = coalesce(old.`thread_id`, old.`id`)) OR `message_id` = old.`id`);
	DELETE FROM `ai_summaries` WHERE (`kind` = 'thread' AND `mailbox_id` = old.`mailbox_id` AND `thread_key` = coalesce(old.`thread_id`, old.`id`)) OR `message_id` = old.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `ai_summaries_messages_au` AFTER UPDATE OF `status` ON `messages` WHEN old.`status` IN ('received', 'sent', 'archived') AND new.`status` NOT IN ('received', 'sent', 'archived') BEGIN
	DELETE FROM `ai_summaries` WHERE `translation_of` IN (SELECT `id` FROM `ai_summaries` WHERE (`kind` = 'thread' AND `mailbox_id` = old.`mailbox_id` AND `thread_key` = coalesce(old.`thread_id`, old.`id`)) OR `message_id` = old.`id`);
	DELETE FROM `ai_summaries` WHERE (`kind` = 'thread' AND `mailbox_id` = old.`mailbox_id` AND `thread_key` = coalesce(old.`thread_id`, old.`id`)) OR `message_id` = old.`id`;
END;

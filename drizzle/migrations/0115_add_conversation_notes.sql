-- Internal notes on a conversation (ported from upstream Mailflare #237): written by people who can read the mailbox,
-- shown above the thread to everyone with access to it, never sent. `thread_key` is the conversation key the reader
-- uses (the thread id, or the message's own id when it was never threaded); `message_id` is set when the note is
-- about one email of the conversation. Backed up with the mail. When the last email of a conversation is deleted for
-- good, its notes go too (the trigger below): a note nobody can reach any more is not kept.
CREATE TABLE `conversation_notes` (`id` text PRIMARY KEY NOT NULL, `mailbox_id` text NOT NULL REFERENCES `mailboxes`(`id`) ON DELETE cascade, `thread_key` text NOT NULL, `message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `body` text NOT NULL, `author_user_id` text REFERENCES `users`(`id`) ON DELETE set null, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `conversation_notes_mailbox_thread_idx` ON `conversation_notes` (`mailbox_id`,`thread_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `conversation_notes_message_idx` ON `conversation_notes` (`message_id`);--> statement-breakpoint
CREATE INDEX `conversation_notes_author_idx` ON `conversation_notes` (`author_user_id`);--> statement-breakpoint
CREATE TRIGGER `conversation_notes_messages_ad` AFTER DELETE ON `messages` BEGIN
	DELETE FROM `conversation_notes` WHERE `mailbox_id` = old.`mailbox_id` AND `thread_key` IN (coalesce(old.`thread_id`, old.`id`), old.`id`) AND NOT EXISTS (SELECT 1 FROM `messages` WHERE `messages`.`mailbox_id` = old.`mailbox_id` AND (`messages`.`thread_id` = `conversation_notes`.`thread_key` OR `messages`.`id` = `conversation_notes`.`thread_key`));
END;

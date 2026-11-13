-- Internal notes on a conversation (ported from upstream Mailflare #237): written by people who can read the mailbox,
-- shown above the thread to everyone with access to it, never sent. `thread_key` is the conversation key the reader
-- uses (the thread id, or the message's own id when it was never threaded); `message_id` is set when the note is
-- about one email of the conversation. Backed up with the mail.
CREATE TABLE `conversation_notes` (`id` text PRIMARY KEY NOT NULL, `mailbox_id` text NOT NULL REFERENCES `mailboxes`(`id`) ON DELETE cascade, `thread_key` text NOT NULL, `message_id` text REFERENCES `messages`(`id`) ON DELETE set null, `body` text NOT NULL, `author_user_id` text REFERENCES `users`(`id`) ON DELETE set null, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);--> statement-breakpoint
CREATE INDEX `conversation_notes_mailbox_thread_idx` ON `conversation_notes` (`mailbox_id`,`thread_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `conversation_notes_message_idx` ON `conversation_notes` (`message_id`);--> statement-breakpoint
CREATE INDEX `conversation_notes_author_idx` ON `conversation_notes` (`author_user_id`);

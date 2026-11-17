import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mailboxes, messages, users } from "./index";

/**
 * Internal notes on a conversation (migration 0115, ported from upstream Mailflare #237), shown to everyone who can
 * read the mailbox and never sent. `threadKey` is the reader's conversation key: the thread id, or the message's own
 * id when it was never threaded. `messageId` is set when the note is about one email of the conversation; deleting
 * that email keeps the note, about the whole conversation. Plain text only: notes are never rendered as HTML.
 */
export const conversationNotes = sqliteTable(
	"conversation_notes",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		threadKey: text("thread_key").notNull(),
		messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
		body: text("body").notNull(),
		/** Null once the author's account is deleted; the note stays, by a former member. */
		authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("conversation_notes_mailbox_thread_idx").on(t.mailboxId, t.threadKey, t.createdAt),
		index("conversation_notes_message_idx").on(t.messageId),
		index("conversation_notes_author_idx").on(t.authorUserId),
	],
);

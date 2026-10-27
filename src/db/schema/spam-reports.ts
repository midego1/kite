import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mailboxes, messages, users } from "./index";

/**
 * What one spam, phishing or "Not spam" report changed, so Undo can take back exactly that. The classifier
 * counts follow from the message's `spam_feedback` row; the receipt adds what that row cannot say: the
 * classification before, the token and reputation rows the report created, where the message was and the
 * phishing extras (a block it placed, warnings it closed).
 */
export const spamReportReceipts = sqliteTable(
	"spam_report_receipts",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
		classification: text("classification", { enum: ["spam", "ham", "phishing"] }).notNull(),
		previousClassification: text("previous_classification", { enum: ["spam", "ham", "phishing"] }),
		/** False when the message already carried this classification, so only its place changed. */
		trained: integer("trained", { mode: "boolean" }).notNull(),
		createdTokens: text("created_tokens").notNull().default("[]"),
		createdKeys: text("created_keys").notNull().default("[]"),
		previousStatus: text("previous_status").notNull(),
		previousFolderId: text("previous_folder_id"),
		extras: text("extras").notNull().default("{}"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		undoneAt: integer("undone_at", { mode: "timestamp" }),
	},
	(t) => [
		index("spam_report_receipts_message_idx").on(t.messageId),
		index("spam_report_receipts_created_idx").on(t.createdAt),
		index("spam_report_receipts_mailbox_idx").on(t.mailboxId, t.createdAt),
	],
);

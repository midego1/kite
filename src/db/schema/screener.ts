import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { mailboxes, users } from "./index";

/**
 * Per-mailbox Screener switch (src/lib/screener/). A mailbox without a row has the Screener off, which is how
 * every mailbox created before migration 0067 stays; new mailboxes get an enabled row when they are created.
 */
export const screenerSettings = sqliteTable("screener_settings", {
	mailboxId: text("mailbox_id")
		.primaryKey()
		.references(() => mailboxes.id, { onDelete: "cascade" }),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
	/** `screener` holds first-time senders out of the Inbox; `inbox` delivers them with a "New sender" mark. */
	mode: text("mode", { enum: ["screener", "inbox"] })
		.notNull()
		.default("screener"),
	updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/** Screener decisions, one per lowercased sender address and mailbox. */
export const screenerSenders = sqliteTable(
	"screener_senders",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		address: text("address").notNull(),
		decision: text("decision", { enum: ["approved", "denied"] }).notNull(),
		/** How the decision was made: a person in the Screener or settings, or a message the mailbox sent. */
		source: text("source", { enum: ["manual", "sent"] })
			.notNull()
			.default("manual"),
		decidedByUserId: text("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("screener_senders_mailbox_address_idx").on(t.mailboxId, t.address),
		index("screener_senders_mailbox_decision_idx").on(t.mailboxId, t.decision),
	],
);

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mailboxes, messages, users } from "./index";
import { instructionColumns } from "./agent-columns";

/**
 * A user's own AI preferences (migration 0069), private to them: personal instructions that apply in every
 * mailbox they work in, and the writing style opt-in. A separate table rather than `users` columns, so whole-row
 * reads of `users` keep working on a database whose migrations are behind. No row means everything empty and off.
 */
export const userAiSettings = sqliteTable("user_ai_settings", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	writingStyleEnabled: integer("writing_style_enabled", { mode: "boolean" }).notNull().default(false),
	...instructionColumns(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/**
 * A user's writing style in one mailbox (migration 0070): running statistics and anonymised greeting and sign-off
 * forms, never text. Built only while the user's opt-in is on, from their own composer sends.
 */
export const writingStyleProfiles = sqliteTable(
	"writing_style_profiles",
	{
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		metricsVersion: integer("metrics_version").notNull().default(1),
		sampleCount: integer("sample_count").notNull().default(0),
		/** JSON `{ "<metric>": { n, mean, m2 } }`. */
		stats: text("stats").notNull().default("{}"),
		/** JSON `{ "<form>": count }`, at most eight entries each. */
		greetings: text("greetings").notNull().default("{}"),
		signOffs: text("sign_offs").notNull().default("{}"),
		languages: text("languages").notNull().default("{}"),
		/** Compare-and-set counter: an update applies only to the version it read. */
		version: integer("version").notNull().default(0),
		/** Set while a backfill from earlier sends is queued or running. */
		backfillRequestedAt: integer("backfill_requested_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [primaryKey({ columns: [table.userId, table.mailboxId] })],
);

/**
 * One row per message sent from the composer with a session (migration 0070), whether or not its author opted in,
 * so a backfill applies the same rule to stored mail: only these sends, and not those AI text was inserted into.
 */
export const composerSends = sqliteTable(
	"composer_sends",
	{
		messageId: text("message_id")
			.primaryKey()
			.references(() => messages.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		aiAssisted: integer("ai_assisted", { mode: "boolean" }).notNull().default(false),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [index("composer_sends_user_mailbox_created_idx").on(table.userId, table.mailboxId, table.createdAt)],
);

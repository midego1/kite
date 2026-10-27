import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { mailboxes, messages, users } from "./index";

/**
 * AI summaries (migration 0072, `docs/specs/thread-summaries.md`): the Summarize button's conversation (`thread`) and
 * message (`message`) summaries, their translations and one-line list summaries (`line`). Derived data, shared by
 * everyone who can read the mailbox and skipped in backups. Database triggers delete the rows of a conversation
 * when one of its messages is deleted or leaves the summarised statuses, and translations go with their source.
 */
export const aiSummaries = sqliteTable(
	"ai_summaries",
	{
		id: text("id").primaryKey(),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: ["thread", "message", "line"] }).notNull(),
		/** `coalesce(thread_id, id)` of the summarised message. */
		threadKey: text("thread_key").notNull(),
		/** Set for `message` and `line` rows; null for `thread`. */
		messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
		/** `thread`/`message`: JSON `{ overview, points: [{ label, text }] }`; `line`: the line itself. */
		text: text("text").notNull(),
		/** First 16 hex characters of SHA-256 over the sorted ids of the messages it covered. */
		coverageDigest: text("coverage_digest").notNull(),
		coveredCount: integer("covered_count").notNull().default(0),
		source: text("source", { enum: ["button", "triage", "line_job"] }).notNull(),
		model: text("model"),
		/** ISO 639-1 code of `text`, or `und`. */
		language: text("language").notNull().default("und"),
		translationOf: text("translation_of").references((): AnySQLiteColumn => aiSummaries.id, { onDelete: "cascade" }),
		/** Digest of the requesting user's personal instructions, or '' without any. */
		instructionsDigest: text("instructions_digest").notNull().default(""),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("ai_summaries_key_idx").on(
			t.mailboxId,
			t.kind,
			t.threadKey,
			sql`coalesce(${t.messageId}, '')`,
			t.instructionsDigest,
			t.language,
		),
		index("ai_summaries_message_idx").on(t.messageId),
		index("ai_summaries_translation_of_idx").on(t.translationOf),
	],
);

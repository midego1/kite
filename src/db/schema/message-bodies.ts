import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The column of `messages` that migration 0074 adds, as a narrow view of the same table. It is kept off
 * `messages` on purpose: Drizzle names every column of a table in whole-row selects and inserts, so a deploy
 * that runs before the migration would fail every read and every delivery. Only `src/lib/email/bodies.ts`
 * reads and writes it, and treats the column being missing as "nothing offloaded".
 */
export const messageBodyKeys = sqliteTable("messages", {
	id: text("id").primaryKey(),
	/** `bodies/<id>.html` in the Mail store when the HTML body was offloaded; `html_body` is null then. */
	htmlBodyKey: text("html_body_key"),
});

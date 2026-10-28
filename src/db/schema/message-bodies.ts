import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The columns of `messages` that migration 0074 adds, as a narrow view of the same table. It is kept off
 * `messages` on purpose: Drizzle names every column of a table in whole-row selects and inserts, so a deploy
 * that runs before the migration would fail every read and every delivery. Only `src/lib/email/bodies.ts`
 * reads and writes it, and treats the column being missing as "nothing offloaded".
 */
export const messageBodyKeys = sqliteTable("messages", {
	id: text("id").primaryKey(),
	/** `bodies/<id>.html` in the Mail store when the HTML body was offloaded; `html_body` is null then. */
	htmlBodyKey: text("html_body_key"),
	/** UTF-8 bytes of the text part and the HTML as imported, for JMAP's size; set only with `htmlBodyKey`. */
	bodySize: integer("body_size"),
});

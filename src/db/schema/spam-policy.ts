import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The column migration 0084 adds to `app_settings`, as a narrow view of that table. It is kept off `appSettings` on
 * purpose: Drizzle names every column of a table in whole-row selects and inserts, so a deploy that runs before the
 * migration would fail every read of the settings row. Only `src/lib/spam/dmarc-policy.ts` reads it, and treats a
 * missing column as off.
 */
export const spamPolicySettings = sqliteTable("app_settings", {
	id: text("id").primaryKey(),
	/** Admin → General: every DMARC failure files mail as spam, whatever policy the sender's domain publishes. */
	strictDmarc: integer("spam_strict_dmarc", { mode: "boolean" }).notNull().default(false),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

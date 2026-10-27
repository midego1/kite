import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Opt-in pseudonymous usage statistics (src/lib/telemetry/). One row, id "default". Not in backups: the install id
 * belongs to this deployment, so a restore elsewhere must not copy it, and the choice starts off there.
 */
export const telemetryState = sqliteTable("telemetry_state", {
	id: text("id").primaryKey(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
	/** Random UUID created when the owner turns statistics on, deleted when they turn them off. */
	installId: text("install_id"),
	/** UTC day (YYYY-MM-DD) of the last heartbeat attempt, so at most one is sent per day. */
	lastSentDay: text("last_sent_day"),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

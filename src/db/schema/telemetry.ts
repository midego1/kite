import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Pseudonymous usage statistics (src/lib/telemetry/). One row, id "default"; no row means the owner never chose.
 * Not in backups: the install id belongs to this deployment, so a restore elsewhere must not copy it.
 */
export const telemetryState = sqliteTable("telemetry_state", {
	id: text("id").primaryKey(),
	/** Whether heartbeats are sent: the decision is `on` (by the owner, or when the notice's start day came). */
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
	/** Random UUID created when statistics are turned on, deleted when they are turned off. */
	installId: text("install_id"),
	/** UTC day (YYYY-MM-DD) of the last heartbeat attempt, so at most one is sent per day. */
	lastSentDay: text("last_sent_day"),
	/** `on` or `off` once decided (at setup, in Admin or by the start day passing); null while undecided. Migration 0074. */
	decision: text("decision").$type<"on" | "off">(),
	/** Undecided installs: the UTC day sending starts unless turned off, set when the owner first saw the notice. */
	startDay: text("start_day"),
	/** The owner closed the one-time notice without choosing. */
	noticeDismissed: integer("notice_dismissed", { mode: "boolean" }).notNull().default(false),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./index";

/**
 * Database backups (migration 0009) and their settings. Full backups (migration 0081) also copy the mail objects
 * next to the database export; see src/lib/backups/objects.ts.
 */
export const backupSettings = sqliteTable("backup_settings", {
	id: text("id").primaryKey(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	scheduleType: text("schedule_type", { enum: ["daily", "weekly", "monthly"] })
		.notNull()
		.default("daily"),
	scheduleValue: integer("schedule_value"),
	retentionEnabled: integer("retention_enabled", { mode: "boolean" }).notNull().default(false),
	retentionDays: integer("retention_days").notNull().default(30),
	excludedTableGroups: text("excluded_table_groups").notNull().default("[]"),
	/** Copy the mail objects (raw MIME, attachments, offloaded bodies) with every backup (migration 0081). */
	includeObjects: integer("include_objects", { mode: "boolean" }).notNull().default(false),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const backups = sqliteTable(
	"backups",
	{
		id: text("id").primaryKey(),
		status: text("status", { enum: ["queued", "running", "completed", "failed"] })
			.notNull()
			.default("queued"),
		trigger: text("trigger", { enum: ["manual", "scheduled", "pre-restore", "pre-migration"] }).notNull(),
		r2Key: text("r2_key"),
		filename: text("filename"),
		size: integer("size"),
		error: text("error"),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		startedAt: integer("started_at", { mode: "timestamp" }),
		completedAt: integer("completed_at", { mode: "timestamp" }),
		/** Migration 0081: the copy of the mail objects; null for a database-only backup. */
		objectsStatus: text("objects_status", { enum: ["copying", "completed", "failed", "restoring"] }),
		objectsPrefix: text("objects_prefix"),
		objectsCount: integer("objects_count"),
		objectsSize: integer("objects_size"),
		/** Objects the database names that were in no store when they were copied. */
		objectsMissing: integer("objects_missing"),
		/** The copy's heartbeat: an object copy that stops updating it is marked failed. */
		objectsUpdatedAt: integer("objects_updated_at", { mode: "timestamp" }),
		/** Objects that could not be copied because reading or writing them failed. */
		objectsFailed: integer("objects_failed"),
		/** JSON state of the running copy or restore (`BackupObjectsRun`), with its step and lease. */
		objectsCursor: text("objects_cursor"),
		/** JSON result of the last restore of the mail files (`BackupObjectsRestoreResult`). */
		objectsRestore: text("objects_restore"),
	},
	(t) => [index("backups_created_idx").on(t.createdAt), index("backups_status_idx").on(t.status)],
);

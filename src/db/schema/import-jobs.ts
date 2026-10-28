import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { mailboxes, users } from "./index";

/**
 * Background IMAP imports. A `folder` job walks one source folder newest first; an `account` job (migration 0075)
 * walks the `import_job_folders` rows in order. The queue consumer advances them; `cursorUid` is the lowest UID
 * already handled. The source password is kept only while the job is active or paused and cleared when it ends.
 */
export const importJobs = sqliteTable(
	"import_jobs",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		destination: text("destination").notNull(),
		host: text("host").notNull(),
		port: integer("port").notNull(),
		secure: integer("secure", { mode: "boolean" }).notNull().default(true),
		username: text("username").notNull(),
		password: text("password").notNull().default(""),
		folder: text("folder").notNull(),
		maxMessages: integer("max_messages"),
		status: text("status", { enum: ["pending", "running", "paused", "completed", "failed", "cancelled"] })
			.notNull()
			.default("pending"),
		total: integer("total"),
		processed: integer("processed").notNull().default(0),
		imported: integer("imported").notNull().default(0),
		skipped: integer("skipped").notNull().default(0),
		cursorUid: integer("cursor_uid"),
		attempts: integer("attempts").notNull().default(0),
		leaseUntil: integer("lease_until", { mode: "timestamp" }),
		lastError: text("last_error"),
		errors: text("errors").notNull().default("[]"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		startedAt: integer("started_at", { mode: "timestamp" }),
		finishedAt: integer("finished_at", { mode: "timestamp" }),
		/** `folder` (one source folder, `folder`) or `account` (the rows of `import_job_folders`). */
		scope: text("scope", { enum: ["folder", "account"] })
			.notNull()
			.default("folder"),
		/** JSON: `{ gmail?: boolean }` for account jobs. */
		options: text("options").notNull().default("{}"),
		/** What the user was told the import would add (sum of the source sizes), for the jobs list. */
		estimateBytes: integer("estimate_bytes"),
		/** Why a paused job waits: `user` (Pause) or `database` (the size guard). */
		pauseReason: text("pause_reason"),
		pausedAt: integer("paused_at", { mode: "timestamp" }),
	},
	(t) => [
		index("import_jobs_user_idx").on(t.userId, t.createdAt),
		index("import_jobs_status_idx").on(t.status, t.updatedAt),
	],
);

/**
 * The source folders of an `account` job, copied one after another in `position` order on the job's lease. Each has
 * its own cursor (`cursorUid`, the lowest UID done) and the `uidvalidity` it was read under; a changed UIDVALIDITY
 * starts the folder over, and Message-ID dedupe skips what is already there.
 */
export const importJobFolders = sqliteTable(
	"import_job_folders",
	{
		id: text("id").primaryKey(),
		jobId: text("job_id")
			.notNull()
			.references(() => importJobs.id, { onDelete: "cascade" }),
		position: integer("position").notNull(),
		/** The name as the server spells it (modified UTF-7), for EXAMINE. */
		sourceName: text("source_name").notNull(),
		role: text("role", { enum: ["inbox", "sent", "archive", "junk", "trash", "all", "user"] }).notNull(),
		/** `system:<status>`, `folder:<id>` or, for Gmail's All Mail, `gmail:labels` (a destination per message). */
		destination: text("destination").notNull(),
		uidvalidity: integer("uidvalidity"),
		total: integer("total"),
		totalBytes: integer("total_bytes"),
		cursorUid: integer("cursor_uid"),
		processed: integer("processed").notNull().default(0),
		imported: integer("imported").notNull().default(0),
		skipped: integer("skipped").notNull().default(0),
		/** Gmail: messages with several user labels, filed under the first one. */
		multiLabel: integer("multi_label").notNull().default(0),
		status: text("status", { enum: ["pending", "running", "completed", "skipped", "failed"] })
			.notNull()
			.default("pending"),
		lastError: text("last_error"),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [index("import_job_folders_job_idx").on(t.jobId, t.position)],
);

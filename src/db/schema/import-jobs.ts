import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { mailboxes, users } from "./index";

/**
 * Background IMAP imports. A job walks one source folder newest first and is
 * advanced by the queue consumer; `cursorUid` is the lowest UID already handled.
 * The source password is kept only while the job is active and cleared when it ends.
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
		status: text("status", { enum: ["pending", "running", "completed", "failed", "cancelled"] })
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
	},
	(t) => [
		index("import_jobs_user_idx").on(t.userId, t.createdAt),
		index("import_jobs_status_idx").on(t.status, t.updatedAt),
	],
);

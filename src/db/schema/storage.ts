import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { users } from "./index";

/** S3-compatible object stores an admin added (src/lib/storage/config.ts); the `BUCKET` binding is `default` and has no row. */
export const storageStores = sqliteTable("storage_stores", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	provider: text("provider", { enum: ["aws", "r2", "b2", "wasabi", "hetzner", "minio", "other"] }).notNull(),
	/** Host with an optional port; `http://` is kept as a prefix only for stores a dev flag allowed. */
	endpoint: text("endpoint").notNull(),
	region: text("region").notNull(),
	bucket: text("bucket").notNull(),
	addressing: text("addressing", { enum: ["virtual", "path"] })
		.notNull()
		.default("virtual"),
	/** Sealed JSON `{ accessKeyId, secretAccessKey }`; saving requires APP_ENCRYPTION_KEY. */
	credentials: text("credentials").notNull(),
	/** R2 S3 API keys for the `BUCKET` binding itself, used only to presign browser URLs. */
	sameAsBinding: integer("same_as_binding", { mode: "boolean" }).notNull().default(false),
	status: text("status", { enum: ["ok", "error", "unchecked"] })
		.notNull()
		.default("unchecked"),
	lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
	lastError: text("last_error"),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/** Which store holds each routable object class; a class without a row stays on the default store. */
export const storageRoutes = sqliteTable("storage_routes", {
	objectClass: text("object_class", { enum: ["mail", "drive", "backups"] }).primaryKey(),
	/** `default` or a storage_stores id; no foreign key, since `default` has no row. */
	storeId: text("store_id").notNull(),
	/** The store reads fall back to while a migration copies its objects. */
	previousStoreId: text("previous_store_id"),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/** Copy jobs that move a class's existing objects to its new store (src/lib/storage/migration.ts). */
export const storageMigrations = sqliteTable(
	"storage_migrations",
	{
		id: text("id").primaryKey(),
		objectClass: text("object_class", { enum: ["mail", "drive", "backups"] }).notNull(),
		fromStoreId: text("from_store_id").notNull(),
		toStoreId: text("to_store_id").notNull(),
		status: text("status", { enum: ["queued", "copying", "verifying", "completed", "failed", "cancelled"] })
			.notNull()
			.default("queued"),
		/** JSON: the planner's position per source table, and options such as `copyBackups`. */
		cursor: text("cursor"),
		objectsTotal: integer("objects_total").notNull().default(0),
		objectsDone: integer("objects_done").notNull().default(0),
		bytesDone: integer("bytes_done").notNull().default(0),
		errors: integer("errors").notNull().default(0),
		lastError: text("last_error"),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		startedAt: integer("started_at", { mode: "timestamp" }),
		finishedAt: integer("finished_at", { mode: "timestamp" }),
	},
	(t) => [index("storage_migrations_status_idx").on(t.status)],
);

import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
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

/**
 * One age-and-size rule per routable class, admin-managed under Admin → Storage → Cold storage
 * (src/lib/storage/cold.ts, migration 0097). `target` is `"r2-ia"` (the default store's Infrequent Access class) or
 * a `storage_stores` id.
 */
export const storageColdRules = sqliteTable("storage_cold_rules", {
	objectClass: text("object_class", { enum: ["mail", "drive", "backups"] }).primaryKey(),
	afterDays: integer("after_days").notNull(),
	minBytes: integer("min_bytes").notNull().default(0),
	target: text("target").notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
});

/**
 * Where a mail or backups object now lives after a cold move; the router's read chain falls back to this on a
 * miss (src/lib/storage/router.ts). Drive files record their own `store_id` and `storage_class` on `drive_items`
 * instead, since that row is already the source of truth for where a file lives.
 */
export const objectLocations = sqliteTable(
	"object_locations",
	{
		key: text("key").primaryKey(),
		objectClass: text("object_class", { enum: ["mail", "drive", "backups"] }).notNull(),
		storeId: text("store_id").notNull(),
		/** Set only for a same-store rewrite (R2 Infrequent Access); null for a move to another store. */
		storageClass: text("storage_class"),
		size: integer("size").notNull(),
		movedAt: integer("moved_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("object_locations_class_idx").on(t.objectClass),
		// Keyset pagination for the orphan sweep (src/lib/storage/cold.ts): a stored (movedAt, key) cursor lets
		// it page through the whole table a bounded batch at a time instead of rescanning the same prefix.
		index("object_locations_moved_at_key_idx").on(t.movedAt, t.key),
	],
);

/**
 * A cold-moved copy nothing in `object_locations` points at any more: the losing side of two deliveries that
 * raced to different targets for the same key (`object-locations.ts`), or a migration's old copy left behind
 * once the object became reachable through the normal chain again (`migration.ts`). Deleted by the orphan sweep
 * (src/lib/storage/cold.ts) only after `orphanedAt` is older than its grace period and no retained backup could
 * still restore a reference to it (`movedAt`, below), re-checking live references at delete time too, so a copy
 * a restore might still need is never removed out from under it. `(storeId, key)` is unique so the same copy is
 * never queued twice; a candidate the delete pass could not resolve (an unreachable store, a backup that might
 * still need it) has `orphanedAt` bumped to the back of the queue instead of blocking the ones behind it.
 */
export const storageColdOrphans = sqliteTable(
	"storage_cold_orphans",
	{
		id: text("id").primaryKey(),
		storeId: text("store_id").notNull(),
		key: text("key").notNull(),
		objectClass: text("object_class", { enum: ["mail", "drive", "backups"] }).notNull(),
		/** When this exact copy became the recorded location (`object_locations.movedAt` at mark time): a
		 * retained backup completed no earlier than this could have its own copy of that location row, and
		 * restoring it (`object_locations` merges, never replaces) would expect the bytes still to be there. */
		movedAt: integer("moved_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		orphanedAt: integer("orphaned_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("storage_cold_orphans_store_key_idx").on(t.storeId, t.key),
		index("storage_cold_orphans_orphaned_at_idx").on(t.orphanedAt),
	],
);

/**
 * One continuously-resumed sweep per class: the nightly cron (re)starts it when idle, batches ride
 * `OUTBOUND_QUEUE` and the five-minute cron restarts a stalled one, on the same pattern as `storage_migrations`
 * (src/lib/storage/cold.ts).
 */
export const storageColdJobs = sqliteTable("storage_cold_jobs", {
	objectClass: text("object_class", { enum: ["mail", "drive", "backups"] }).primaryKey(),
	status: text("status", { enum: ["queued", "running", "completed", "failed"] })
		.notNull()
		.default("queued"),
	/** JSON `ColdCursor` (src/lib/storage/cold-utils.ts): the rule this pass started with, and its position per source. */
	cursor: text("cursor"),
	objectsDone: integer("objects_done").notNull().default(0),
	bytesDone: integer("bytes_done").notNull().default(0),
	errors: integer("errors").notNull().default(0),
	lastError: text("last_error"),
	createdAt: integer("created_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	startedAt: integer("started_at", { mode: "timestamp" }),
	finishedAt: integer("finished_at", { mode: "timestamp" }),
});

/** One row (`default`): the last automatic R2 direct-uploads setup and the dismissed reminder (migration 0085). */
export const storageState = sqliteTable("storage_state", {
	id: text("id").primaryKey(),
	/** JSON `DirectUploadsState` (src/lib/storage/direct-uploads-state.ts); never a key. */
	directUploads: text("direct_uploads"),
	/** JSON `{ movedAt, key } | null`: where the orphan sweep's `object_locations` scan left off (`cold.ts`). */
	coldOrphanCursor: text("cold_orphan_cursor"),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

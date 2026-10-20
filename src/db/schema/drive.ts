import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./index";

/** A Drive file or folder. Files keep their bytes at `object_key` on the store named by `store_id`. */
export const driveItems = sqliteTable(
	"drive_items",
	{
		id: text("id").primaryKey(),
		ownerId: text("owner_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** No foreign key: a restore inserts rows in table order, not tree order. */
		parentId: text("parent_id"),
		kind: text("kind", { enum: ["file", "folder"] }).notNull(),
		name: text("name").notNull(),
		size: integer("size").notNull().default(0),
		contentType: text("content_type").notNull().default("application/octet-stream"),
		/** `default` (the BUCKET binding) for every file until configured stores exist; null for folders. */
		storeId: text("store_id"),
		objectKey: text("object_key"),
		status: text("status", { enum: ["uploading", "ready"] })
			.notNull()
			.default("ready"),
		uploadId: text("upload_id"),
		uploadPartSize: integer("upload_part_size"),
		uploadFingerprint: text("upload_fingerprint"),
		uploadExpiresAt: integer("upload_expires_at", { mode: "timestamp" }),
		/** Informational only; the copy is independent of the attachment. */
		sourceAttachmentId: text("source_attachment_id"),
		trashedAt: integer("trashed_at", { mode: "timestamp" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		index("drive_items_owner_parent_idx").on(t.ownerId, t.parentId, t.status),
		index("drive_items_parent_idx").on(t.parentId),
		index("drive_items_trashed_idx").on(t.trashedAt),
		index("drive_items_upload_expiry_idx").on(t.uploadExpiresAt),
	],
);

/** A Drive item shared with another account; the role applies to the whole subtree. */
export const driveShares = sqliteTable(
	"drive_shares",
	{
		id: text("id").primaryKey(),
		itemId: text("item_id")
			.notNull()
			.references(() => driveItems.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role", { enum: ["view", "edit"] })
			.notNull()
			.default("view"),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [
		uniqueIndex("drive_shares_item_user_idx").on(t.itemId, t.userId),
		index("drive_shares_user_idx").on(t.userId),
	],
);

/** A public link. Only the SHA-256 of its token is stored; every link expires. */
export const driveLinks = sqliteTable(
	"drive_links",
	{
		id: text("id").primaryKey(),
		itemId: text("item_id")
			.notNull()
			.references(() => driveItems.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		/** The token sealed with APP_ENCRYPTION_KEY so the owner can copy it again; null without a key. */
		tokenSealed: text("token_sealed"),
		passwordHash: text("password_hash"),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		downloadCount: integer("download_count").notNull().default(0),
		lastAccessedAt: integer("last_accessed_at", { mode: "timestamp" }),
		revokedAt: integer("revoked_at", { mode: "timestamp" }),
		createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(t) => [uniqueIndex("drive_links_token_idx").on(t.tokenHash), index("drive_links_item_idx").on(t.itemId)],
);

/** The parts of an upload in progress; meaningless after a restore, so never backed up. */
export const driveUploadParts = sqliteTable(
	"drive_upload_parts",
	{
		itemId: text("item_id")
			.notNull()
			.references(() => driveItems.id, { onDelete: "cascade" }),
		partNumber: integer("part_number").notNull(),
		etag: text("etag").notNull(),
		size: integer("size").notNull(),
	},
	(t) => [uniqueIndex("drive_upload_parts_idx").on(t.itemId, t.partNumber)],
);

/** One row with id `default`; no row means the defaults. */
export const driveSettings = sqliteTable("drive_settings", {
	id: text("id").primaryKey(),
	/** Null is unlimited. */
	defaultQuotaBytes: integer("default_quota_bytes"),
	/** 0 turns public links off; otherwise 1-365. Links never go without an expiry. */
	linkMaxDays: integer("link_max_days").notNull().default(30),
	trashRetentionDays: integer("trash_retention_days").notNull().default(30),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
});

/** A per-user override of the default quota; a null `quota_bytes` is unlimited for that user. */
export const driveUserQuotas = sqliteTable("drive_user_quotas", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	quotaBytes: integer("quota_bytes"),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.$defaultFn(() => new Date()),
});

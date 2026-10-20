import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems, driveSettings, driveUserQuotas } from "@/db/schema/drive";
import { effectiveQuota } from "./quota-utils";
import { DEFAULT_DRIVE_SETTINGS } from "./settings-utils";
import type { DriveSettingsValues, DriveUsage } from "./types";

export async function getDriveSettings(env: CloudflareEnv): Promise<DriveSettingsValues> {
	const [row] = await getDb(env).select().from(driveSettings).where(eq(driveSettings.id, "default")).limit(1);
	if (!row) return { ...DEFAULT_DRIVE_SETTINGS };
	return {
		defaultQuotaBytes: row.defaultQuotaBytes,
		linkMaxDays: row.linkMaxDays,
		trashRetentionDays: row.trashRetentionDays,
	};
}

export async function saveDriveSettings(
	env: CloudflareEnv,
	values: DriveSettingsValues,
	userId: string,
): Promise<void> {
	const now = new Date();
	await getDb(env)
		.insert(driveSettings)
		.values({ id: "default", ...values, updatedAt: now, updatedBy: userId })
		.onConflictDoUpdate({ target: driveSettings.id, set: { ...values, updatedAt: now, updatedBy: userId } });
}

/** The limit that applies to an owner, in bytes; null is unlimited. */
export async function getQuotaLimit(env: CloudflareEnv, ownerId: string): Promise<number | null> {
	const [[override], settings] = await Promise.all([
		getDb(env)
			.select({ quotaBytes: driveUserQuotas.quotaBytes })
			.from(driveUserQuotas)
			.where(eq(driveUserQuotas.userId, ownerId))
			.limit(1),
		getDriveSettings(env),
	]);
	return effectiveQuota(override, settings.defaultQuotaBytes);
}

/** Everything the owner holds, including trashed items and uploads in progress. */
async function getUsedBytes(env: CloudflareEnv, ownerId: string): Promise<number> {
	const [row] = await getDb(env)
		.select({ total: sql<number>`coalesce(sum(${driveItems.size}), 0)` })
		.from(driveItems)
		.where(eq(driveItems.ownerId, ownerId));
	return Number(row?.total ?? 0);
}

export async function getDriveUsage(env: CloudflareEnv, ownerId: string): Promise<DriveUsage> {
	const [used, limit] = await Promise.all([getUsedBytes(env, ownerId), getQuotaLimit(env, ownerId)]);
	return { used, limit };
}

export async function countUploadsInProgress(env: CloudflareEnv, ownerId: string): Promise<number> {
	const [row] = await getDb(env)
		.select({ count: sql<number>`count(*)` })
		.from(driveItems)
		.where(and(eq(driveItems.ownerId, ownerId), eq(driveItems.status, "uploading")));
	return Number(row?.count ?? 0);
}

export type ReservedFile = {
	id: string;
	ownerId: string;
	parentId: string | null;
	name: string;
	size: number;
	contentType: string;
	storeId: string;
	objectKey: string;
	uploadPartSize: number | null;
	uploadFingerprint: string | null;
	uploadExpiresAt: Date | null;
	sourceAttachmentId: string | null;
	now: Date;
};

const seconds = (date: Date | null) => (date ? Math.floor(date.getTime() / 1000) : null);

/**
 * Inserts an `uploading` file row only if its size still fits the owner's quota, in one statement, so
 * concurrent uploads cannot overshoot. `limit` is resolved by the caller; the explicit `IS NULL` branch
 * is what lets an unlimited owner through, since `sum + size <= NULL` is NULL. Returns false when it did not fit.
 */
export async function reserveDriveFile(env: CloudflareEnv, file: ReservedFile, limit: number | null): Promise<boolean> {
	const now = seconds(file.now);
	const result = await env.DB.prepare(
		`INSERT INTO drive_items (id, owner_id, parent_id, kind, name, size, content_type, store_id, object_key, status,
			upload_part_size, upload_fingerprint, upload_expires_at, source_attachment_id, created_at, updated_at)
		SELECT ?, ?, ?, 'file', ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?
		WHERE ? IS NULL OR (SELECT coalesce(sum(size), 0) FROM drive_items WHERE owner_id = ?) + ? <= ?`,
	)
		.bind(
			file.id,
			file.ownerId,
			file.parentId,
			file.name,
			file.size,
			file.contentType,
			file.storeId,
			file.objectKey,
			file.uploadPartSize,
			file.uploadFingerprint,
			seconds(file.uploadExpiresAt),
			file.sourceAttachmentId,
			now,
			now,
			limit,
			file.ownerId,
			file.size,
			limit,
		)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

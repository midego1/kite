import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { inJsonArray, runInChunks } from "@/db/chunk-utils";
import { driveItems, driveShares } from "@/db/schema/drive";
import type { KiteBucket } from "@/lib/storage/types";
import { DRIVE_MAX_DEPTH } from "./name-utils";
import { bucketOfItem } from "./objects";
import type { DriveRole, DriveRow } from "./types";

type Db = ReturnType<typeof getDb>;

export async function getDriveItem(db: Db, id: string): Promise<DriveRow | null> {
	const [item] = await db.select().from(driveItems).where(eq(driveItems.id, id)).limit(1);
	return item ?? null;
}

/**
 * The ids of an item and its ancestors, found by one recursive query instead of a parent walk. Depth is
 * capped, so a parent cycle in restored data ends instead of looping.
 */
const chainIds = (id: string) => sql`(WITH RECURSIVE chain(id, parent_id, depth) AS (
	SELECT id, parent_id, 0 FROM drive_items WHERE id = ${id}
	UNION ALL
	SELECT d.id, d.parent_id, chain.depth + 1 FROM drive_items d JOIN chain ON d.id = chain.parent_id WHERE chain.depth < ${DRIVE_MAX_DEPTH - 1}
) SELECT id FROM chain)`;

/** Ancestors from the root down to (and including) the item. Stops at a missing parent. */
export async function getDriveChain(db: Db, item: DriveRow): Promise<DriveRow[]> {
	const rows = await db
		.select()
		.from(driveItems)
		.where(sql`${driveItems.id} IN ${chainIds(item.id)}`);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const chain: DriveRow[] = [];
	const seen = new Set<string>();
	for (let current: DriveRow | undefined = byId.get(item.id) ?? item; current && !seen.has(current.id);) {
		chain.unshift(current);
		seen.add(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return chain;
}

/** The highest role among shares with the user on the given items, or null. */
async function sharedRole(db: Db, userId: string, itemIds: string[]): Promise<DriveRole | null> {
	if (!itemIds.length) return null;
	const shares = await db
		.select({ role: driveShares.role })
		.from(driveShares)
		.where(and(eq(driveShares.userId, userId), inArray(driveShares.itemId, itemIds)));
	if (shares.some((share) => share.role === "edit")) return "edit";
	return shares.length ? "view" : null;
}

/**
 * The user's role on an item. A share on any ancestor applies to everything beneath it. A trashed item
 * or trashed ancestor is invisible unless `allowTrashed` (the owner's Trash view and restore), and an
 * upload in progress is visible to nobody but the upload routes.
 */
export async function getDriveRole(
	db: Db,
	userId: string,
	item: DriveRow,
	options: { allowTrashed?: boolean; allowUploading?: boolean } = {},
): Promise<{ role: DriveRole | null; chain: DriveRow[] }> {
	if (item.status !== "ready" && !options.allowUploading) return { role: null, chain: [] };
	const chain = await getDriveChain(db, item);
	if (!options.allowTrashed && chain.some((entry) => entry.trashedAt)) return { role: null, chain };
	if (item.ownerId === userId) return { role: "owner", chain };
	const role = await sharedRole(
		db,
		userId,
		chain.filter((entry) => entry.ownerId === item.ownerId).map((entry) => entry.id),
	);
	return { role, chain };
}

/** The ids of every descendant of the given folders, without the folders themselves. */
const descendantIds = (rootIds: string[]) => sql`(WITH RECURSIVE tree(id, depth) AS (
	SELECT id, 1 FROM drive_items WHERE ${inJsonArray(sql`parent_id`, rootIds)}
	UNION ALL
	SELECT d.id, tree.depth + 1 FROM drive_items d JOIN tree ON d.parent_id = tree.id WHERE tree.depth < ${DRIVE_MAX_DEPTH}
) SELECT id FROM tree)`;

export async function collectDriveDescendants(db: Db, rootIds: string[]): Promise<DriveRow[]> {
	if (!rootIds.length) return [];
	const rows = await db
		.select()
		.from(driveItems)
		.where(sql`${driveItems.id} IN ${descendantIds(rootIds)}`);
	const roots = new Set(rootIds);
	return rows.filter((row) => !roots.has(row.id));
}

/** How many levels lie below an item (0 for a file or an empty folder). */
export async function subtreeHeight(env: CloudflareEnv, itemId: string): Promise<number> {
	const row = await env.DB.prepare(
		`WITH RECURSIVE tree(id, depth) AS (
			SELECT id, 1 FROM drive_items WHERE parent_id = ?
			UNION ALL
			SELECT d.id, tree.depth + 1 FROM drive_items d JOIN tree ON d.parent_id = tree.id WHERE tree.depth < ?
		) SELECT coalesce(max(depth), 0) AS height FROM tree`,
	)
		.bind(itemId, DRIVE_MAX_DEPTH)
		.first<{ height: number }>();
	return Number(row?.height ?? 0);
}

/**
 * Of the given folder ids, those that are trashed or sit under a trashed folder: one recursive query for
 * the whole page instead of a walk per row.
 */
export async function hiddenFolderIds(env: CloudflareEnv, folderIds: string[]): Promise<Set<string>> {
	const ids = [...new Set(folderIds)];
	if (!ids.length) return new Set();
	const result = await env.DB.prepare(
		`WITH RECURSIVE up(start, id, parent_id, trashed_at, depth) AS (
			SELECT id, id, parent_id, trashed_at, 0 FROM drive_items WHERE id IN (SELECT value FROM json_each(?))
			UNION ALL
			SELECT up.start, d.id, d.parent_id, d.trashed_at, up.depth + 1 FROM drive_items d JOIN up ON d.id = up.parent_id WHERE up.depth < ?
		) SELECT DISTINCT start FROM up WHERE trashed_at IS NOT NULL`,
	)
		.bind(JSON.stringify(ids), DRIVE_MAX_DEPTH - 1)
		.all<{ start: string }>();
	return new Set(result.results.map((row) => row.start));
}

/** Drops rows that sit under a trashed folder; only the folder itself carries `trashedAt`. */
export async function withoutTrashedAncestors(env: CloudflareEnv, rows: DriveRow[]): Promise<DriveRow[]> {
	const hidden = await hiddenFolderIds(
		env,
		rows.flatMap((row) => (row.parentId ? [row.parentId] : [])),
	);
	return rows.filter((row) => !row.parentId || !hidden.has(row.parentId));
}

/**
 * Permanently removes items, their descendants and the stored objects. Each file is deleted from the
 * store its row names; rows go after their objects, so a failure leaves rows to retry rather than orphans.
 */
export async function deleteDriveItems(env: CloudflareEnv, roots: DriveRow[]): Promise<number> {
	const db = getDb(env);
	const descendants = await collectDriveDescendants(
		db,
		roots.filter((row) => row.kind === "folder").map((row) => row.id),
	);
	const all = [...new Map([...roots, ...descendants].map((row) => [row.id, row])).values()];
	await deleteDriveObjects(env, all);
	await runInChunks(
		all.map((row) => row.id),
		(chunk) => db.delete(driveItems).where(inArray(driveItems.id, chunk)),
	);
	return all.length;
}

/** Aborts unfinished uploads and deletes stored files, each on the store its row names. */
async function deleteDriveObjects(env: CloudflareEnv, rows: DriveRow[]): Promise<void> {
	const byStore = new Map<KiteBucket, string[]>();
	for (const row of rows) {
		const bucket = row.kind === "file" && row.objectKey ? bucketOfItem(env, row) : null;
		if (!bucket) continue;
		if (row.status === "uploading" && row.uploadId && bucket.resumeMultipartUpload)
			await bucket
				.resumeMultipartUpload(row.objectKey!, row.uploadId)
				.abort()
				.catch(() => undefined);
		byStore.set(bucket, [...(byStore.get(bucket) ?? []), row.objectKey!]);
	}
	for (const [bucket, keys] of byStore) await runInChunks(keys, (chunk) => bucket.delete(chunk), 500);
}

import { and, asc, count, eq, gt, inArray, isNotNull, sum } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems } from "@/db/schema/drive";
import { driveTablesReady } from "./errors";

const MAX_PAGE = 200;

/**
 * The Drive side of a store migration: the stored files on one store, by id order. Uploads in progress are
 * left out (their parts live on the store they started on); once complete they are picked up by the verify
 * pass, which lists the source store again.
 */
export async function listDriveObjectKeys(
	env: CloudflareEnv,
	input: { storeId: string; cursor?: string | null; limit?: number },
): Promise<{ objects: { id: string; key: string; size: number }[]; cursor: string | null }> {
	if (!(await driveTablesReady(env))) return { objects: [], cursor: null };
	const limit = Math.min(Math.max(input.limit ?? MAX_PAGE, 1), MAX_PAGE);
	const rows = await getDb(env)
		.select({ id: driveItems.id, key: driveItems.objectKey, size: driveItems.size })
		.from(driveItems)
		.where(
			and(
				eq(driveItems.kind, "file"),
				eq(driveItems.status, "ready"),
				eq(driveItems.storeId, input.storeId),
				isNotNull(driveItems.objectKey),
				input.cursor ? gt(driveItems.id, input.cursor) : undefined,
			),
		)
		.orderBy(asc(driveItems.id))
		.limit(limit);
	const objects = rows.map((row) => ({ id: row.id, key: row.key!, size: row.size }));
	return { objects, cursor: rows.length === limit ? rows[rows.length - 1].id : null };
}

/** Records that these files now live on `toStoreId`; a row that moved or changed store meanwhile is left alone. */
export async function markDriveObjectsMoved(
	env: CloudflareEnv,
	input: { ids: string[]; fromStoreId: string; toStoreId: string },
): Promise<{ updated: number }> {
	if (!input.ids.length || !(await driveTablesReady(env))) return { updated: 0 };
	let updated = 0;
	for (let index = 0; index < input.ids.length; index += 90) {
		const result = await getDb(env)
			.update(driveItems)
			.set({ storeId: input.toStoreId })
			.where(
				and(inArray(driveItems.id, input.ids.slice(index, index + 90)), eq(driveItems.storeId, input.fromStoreId)),
			);
		updated += result.meta.changes ?? 0;
	}
	return { updated };
}

/** How many Drive rows, uploads in progress included, name a store; deleting it is refused while any do. */
export async function countDriveObjectsOnStore(env: CloudflareEnv, input: { storeId: string }) {
	if (!(await driveTablesReady(env))) return { count: 0 };
	const [row] = await getDb(env)
		.select({ count: count() })
		.from(driveItems)
		.where(eq(driveItems.storeId, input.storeId));
	return { count: Number(row?.count ?? 0) };
}

/** Files and bytes Drive holds, for the storage usage per class. */
export async function driveStorageUsage(env: CloudflareEnv) {
	if (!(await driveTablesReady(env))) return { objects: 0, bytes: 0 };
	const [row] = await getDb(env)
		.select({ objects: count(), bytes: sum(driveItems.size) })
		.from(driveItems)
		.where(eq(driveItems.kind, "file"));
	return { objects: Number(row?.objects ?? 0), bytes: Number(row?.bytes ?? 0) };
}

import { and, asc, count, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sum } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItemColdView, driveItems } from "@/db/schema/drive";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { COLD_STORAGE_CLASS, R2_IA_TARGET } from "@/lib/storage/cold-utils";
import { driveTablesReady } from "./errors";

const MAX_PAGE = 200;

/** `storage_class` (migration 0097) on a database the migration has not reached yet reads as "nothing is cold". */
async function beforeColdColumn<T>(query: () => Promise<T>, whenPending: T): Promise<T> {
	try {
		return await query();
	} catch (error) {
		if (missingColumnFromError(error) === "storage_class") return whenPending;
		throw error;
	}
}

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

/**
 * Files due for a cold move (`src/lib/storage/cold.ts`): old and big enough, not trashed or still uploading, and
 * not already at `target`. Excludes nothing by store, since a file's own `store_id` may be any configured store.
 */
export async function listColdDriveCandidates(
	env: CloudflareEnv,
	input: { cutoff: string; minBytes: number; target: string; cursor?: string | null; limit?: number },
): Promise<{
	objects: { id: string; key: string; size: number; storeId: string; createdAt: string }[];
	cursor: string | null;
}> {
	return beforeColdColumn(
		async () => {
			if (!(await driveTablesReady(env))) return { objects: [], cursor: null };
			const limit = Math.min(Math.max(input.limit ?? MAX_PAGE, 1), MAX_PAGE);
			const cutoff = new Date(input.cutoff);
			const notYetAtTarget =
				input.target === R2_IA_TARGET
					? or(isNull(driveItemColdView.storageClass), ne(driveItemColdView.storageClass, COLD_STORAGE_CLASS))
					: ne(driveItemColdView.storeId, input.target);
			const rows = await getDb(env)
				.select({
					id: driveItemColdView.id,
					key: driveItemColdView.objectKey,
					size: driveItemColdView.size,
					storeId: driveItemColdView.storeId,
					createdAt: driveItemColdView.createdAt,
				})
				.from(driveItemColdView)
				.where(
					and(
						eq(driveItemColdView.kind, "file"),
						eq(driveItemColdView.status, "ready"),
						isNull(driveItemColdView.trashedAt),
						isNotNull(driveItemColdView.objectKey),
						isNotNull(driveItemColdView.storeId),
						lte(driveItemColdView.createdAt, cutoff),
						gte(driveItemColdView.size, input.minBytes),
						notYetAtTarget,
						input.cursor ? gt(driveItemColdView.id, input.cursor) : undefined,
					),
				)
				.orderBy(asc(driveItemColdView.id))
				.limit(limit);
			const objects = rows.map((row) => ({
				id: row.id,
				key: row.key!,
				size: row.size,
				storeId: row.storeId!,
				createdAt: row.createdAt.toISOString(),
			}));
			return { objects, cursor: rows.length === limit ? rows[rows.length - 1].id : null };
		},
		{ objects: [], cursor: null },
	);
}

/** Records a cold move: a same-store rewrite sets `storageClass`; a move to another store also updates `storeId`. */
export async function markDriveObjectsCold(
	env: CloudflareEnv,
	input: { ids: string[]; storageClass: string | null; storeId?: string },
): Promise<{ updated: number }> {
	if (!input.ids.length) return { updated: 0 };
	return beforeColdColumn(
		async () => {
			if (!(await driveTablesReady(env))) return { updated: 0 };
			let updated = 0;
			for (let index = 0; index < input.ids.length; index += 90) {
				const result = await getDb(env)
					.update(driveItemColdView)
					.set({ storageClass: input.storageClass, ...(input.storeId ? { storeId: input.storeId } : {}) })
					.where(inArray(driveItemColdView.id, input.ids.slice(index, index + 90)));
				updated += result.meta.changes ?? 0;
			}
			return { updated };
		},
		{ updated: 0 },
	);
}

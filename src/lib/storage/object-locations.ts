import { getDb } from "@/db";
import { storageColdOrphans } from "@/db/schema/storage";
import { newId } from "@/lib/ids";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { RoutableClass } from "./types";

type LocationEnv = { DB: D1Database };

/**
 * Records a cold-moved copy nothing in `object_locations` points at any more as a candidate for the orphan
 * sweep (`cold.ts`), which deletes it only after a grace period (and no retained backup could still need it,
 * `movedAt`), re-checking its reference at that point. A second mark of the same copy is a no-op (`storeId, key`
 * is unique).
 */
export async function markOrphanCandidate(
	env: LocationEnv,
	input: { storeId: string; key: string; objectClass: RoutableClass; movedAt: Date },
	now = new Date(),
): Promise<void> {
	try {
		await getDb(env)
			.insert(storageColdOrphans)
			.values({
				id: newId("sco"),
				storeId: input.storeId,
				key: input.key,
				objectClass: input.objectClass,
				movedAt: input.movedAt,
				orphanedAt: now,
			})
			.onConflictDoNothing();
	} catch (error) {
		if (isNoSuchTableError(error)) return;
		throw error;
	}
}

/**
 * Records where an object now lives after a cold move (`cold.ts`). Mail and backups are read through this on
 * a chain miss (`router.ts`); Drive files are normally read by their row's own `store_id`/`storage_class`
 * (`drive_items`), but are recorded here too (key `drive/<id>`), since a restore can roll that row back to a
 * store a sweep already moved the file off of, which this is how `streamDriveFile` recovers from.
 *
 * Two deliveries of the same cold-move work (a retried queue message, a genuinely concurrent worker) can each
 * copy the same key to a different target and both reach here: whichever lands second is what this row ends up
 * naming, and the first target's copy has nothing pointing at it any more. The mark-then-overwrite below runs as
 * one D1 batch (one transaction) instead of a separate read then a separate write, so two truly concurrent
 * callers cannot both read "nothing previous" and both skip marking a copy the other is about to orphan.
 */
export async function recordObjectLocation(
	env: LocationEnv,
	input: { key: string; objectClass: RoutableClass; storeId: string; storageClass: string | null; size: number },
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	const markPrevious = env.DB.prepare(
		`INSERT INTO storage_cold_orphans (id, store_id, key, object_class, moved_at, orphaned_at)
		 SELECT ?, store_id, key, object_class, moved_at, ?
		 FROM object_locations WHERE key = ? AND store_id <> ?
		 ON CONFLICT (store_id, key) DO NOTHING`,
	).bind(newId("sco"), now, input.key, input.storeId);
	const upsert = env.DB.prepare(
		`INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET store_id = excluded.store_id, storage_class = excluded.storage_class,
		 size = excluded.size, moved_at = excluded.moved_at`,
	).bind(input.key, input.objectClass, input.storeId, input.storageClass, input.size, now);
	try {
		await env.DB.batch([markPrevious, upsert]);
		return;
	} catch (error) {
		// `object_locations` exists (migration 0097) but `storage_cold_orphans` may not yet (migration 0103):
		// the location still needs recording on its own, just without the orphan candidate mark, rather than
		// the whole batch (and so the location write) failing over a table nothing here strictly needs yet.
		if (!isNoSuchTableError(error)) throw error;
	}
	try {
		await upsert.run();
	} catch (error) {
		if (isNoSuchTableError(error)) return;
		throw error;
	}
}

/** The store a key moved to, for the router's fallback; null before migration 0097 or when the key is not cold. */
export async function lookupObjectLocation(
	env: LocationEnv,
	key: string,
): Promise<{ storeId: string; movedAt: Date } | null> {
	try {
		const row = await env.DB.prepare("SELECT store_id, moved_at FROM object_locations WHERE key = ?")
			.bind(key)
			.first<{ store_id: string; moved_at: number }>();
		return row ? { storeId: row.store_id, movedAt: new Date(row.moved_at * 1000) } : null;
	} catch (error) {
		if (isNoSuchTableError(error)) return null;
		throw error;
	}
}

/** Every recorded location among `keys`, for a delete that must reach a store outside the normal chain. */
export async function lookupObjectLocations(env: LocationEnv, keys: readonly string[]): Promise<Map<string, string>> {
	if (!keys.length) return new Map();
	try {
		const { results } = await env.DB.prepare(
			"SELECT key, store_id FROM object_locations WHERE key IN (SELECT value FROM json_each(?))",
		)
			.bind(JSON.stringify(keys))
			.all<{ key: string; store_id: string }>();
		return new Map((results ?? []).map((row) => [row.key, row.store_id]));
	} catch (error) {
		if (isNoSuchTableError(error)) return new Map();
		throw error;
	}
}

/** Drops the recorded location for `keys` once the object itself is gone, so it never blocks deleting the store. */
export async function deleteObjectLocations(env: LocationEnv, keys: readonly string[]): Promise<void> {
	if (!keys.length) return;
	try {
		await env.DB.prepare("DELETE FROM object_locations WHERE key IN (SELECT value FROM json_each(?))")
			.bind(JSON.stringify(keys))
			.run();
	} catch (error) {
		if (isNoSuchTableError(error)) return;
		throw error;
	}
}

import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { RoutableClass } from "./types";

type LocationEnv = { DB: D1Database };

/**
 * Records where a mail or backups object now lives after a cold move (`cold.ts`); the router's read chain
 * (`router.ts`) consults this on a miss. Drive files record their own `store_id`/`storage_class` on
 * `drive_items` instead, so this table never names a `drive` object.
 */
export async function recordObjectLocation(
	env: LocationEnv,
	input: { key: string; objectClass: RoutableClass; storeId: string; storageClass: string | null; size: number },
): Promise<void> {
	try {
		await env.DB.prepare(
			`INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (key) DO UPDATE SET store_id = excluded.store_id, storage_class = excluded.storage_class,
			 size = excluded.size, moved_at = excluded.moved_at`,
		)
			.bind(input.key, input.objectClass, input.storeId, input.storageClass, input.size, Math.floor(Date.now() / 1000))
			.run();
	} catch (error) {
		if (isNoSuchTableError(error)) return;
		throw error;
	}
}

/** The store a key moved to, for the router's fallback; null before migration 0097 or when the key is not cold. */
export async function lookupObjectLocation(env: LocationEnv, key: string): Promise<{ storeId: string } | null> {
	try {
		const row = await env.DB.prepare("SELECT store_id FROM object_locations WHERE key = ?")
			.bind(key)
			.first<{ store_id: string }>();
		return row ? { storeId: row.store_id } : null;
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

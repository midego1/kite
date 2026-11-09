import { getDb } from "@/db";
import { storageColdOrphans } from "@/db/schema/storage";
import { newId } from "@/lib/ids";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { RoutableClass } from "./types";

type LocationEnv = { DB: D1Database };

/**
 * Records a cold-moved copy nothing in `object_locations` points at any more as a candidate for the orphan
 * sweep (`cold.ts`), which deletes it only after a grace period (and no retained backup could still need it,
 * `movedAt`), re-checking its reference at that point. A second mark of the same copy is a no-op (`storeId, key`
 * is unique). `firstOrphanedAt` starts equal to `orphanedAt` but, unlike it, is never bumped by a later deferral
 * (`B1`): it is the fixed upper bound of the only window a completed backup could still hold a reference to
 * this exact copy in.
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
				firstOrphanedAt: now,
			})
			.onConflictDoNothing();
	} catch (error) {
		if (isNoSuchTableError(error)) return;
		throw error;
	}
}

/** Drops a specific copy's orphan-candidate row once its own mover has deleted the bytes itself (`B1`): marking
 * it was only ever a precaution for the case that delete failed, and it did not, so there is nothing left to
 * track. Harmless if nothing was ever marked. */
export async function clearOrphanCandidate(env: LocationEnv, storeId: string, key: string): Promise<void> {
	try {
		await env.DB.prepare("DELETE FROM storage_cold_orphans WHERE store_id = ? AND key = ?").bind(storeId, key).run();
	} catch (error) {
		if (isNoSuchTableError(error)) return;
		throw error;
	}
}

/** How long a claim (below) is honoured before it is treated as abandoned and reclaimed by whoever asks next:
 * generous for a single cold move or delete, including a large multipart copy, without leaving a crashed
 * caller's claim stuck for long. A move that runs longer renews it (`renewLocationLease`) rather than relying
 * on this alone, since nothing else re-checks a lease once it is handed out (`B3`). */
const LEASE_SECONDS = 5 * 60;

function isMissingLeaseColumn(error: unknown): boolean {
	const column = missingColumnFromError(error);
	return column === "lease_token" || column === "claimed_until";
}

export type LocationLease = { token: string };

/** The claim attempt both variants below try first: steal an existing row's claim once it has expired, or take
 * an unclaimed one. `null` means an existing row is validly claimed by someone else right now; what "no row at
 * all" means is each caller's own to decide. */
async function tryClaimExistingRow(
	env: LocationEnv,
	key: string,
	token: string,
	until: number,
	nowSeconds: number,
): Promise<LocationLease | null> {
	const result = await env.DB.prepare(
		`UPDATE object_locations SET lease_token = ?, claimed_until = ?
		 WHERE key = ? AND (claimed_until IS NULL OR claimed_until < ?)`,
	)
		.bind(token, until, key, nowSeconds)
		.run();
	return (result.meta?.changes ?? 0) > 0 ? { token } : null;
}

/**
 * Claims the exclusive right to change `key`'s `object_locations` row or delete one of its copies: a fencing
 * token written to that row, checked and cleared in the very statement that later commits a move's new
 * location (`recordObjectLocation`) rather than a time limit alone, which round 5's design relied on and round
 * 6 found could still let a lease-holder's write land after the lease had already been handed to someone else
 * (`B3`). Returns the claim on success, `"none"` when the key has no row yet (nothing exists for anything else
 * to race over, so there is nothing to protect — `deferUnrecordedCopy`, the only caller left using this instead
 * of `claimOrCreateLocationLease`, never writes a new location anyway), or `null` when someone else already
 * holds a still-valid claim on an existing row. Before migration 0104 there is no column to claim through;
 * acquiring then answers `"none"` rather than refusing every check over columns that cannot exist yet.
 */
export async function claimLocationLease(
	env: LocationEnv,
	key: string,
	now = new Date(),
): Promise<LocationLease | "none" | null> {
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const token = newId("lease");
	const until = nowSeconds + LEASE_SECONDS;
	try {
		const claimed = await tryClaimExistingRow(env, key, token, until, nowSeconds);
		if (claimed) return claimed;
		const existing = await env.DB.prepare("SELECT 1 AS found FROM object_locations WHERE key = ?")
			.bind(key)
			.first<{ found: number }>();
		return existing ? null : "none";
	} catch (error) {
		if (isNoSuchTableError(error) || isMissingLeaseColumn(error)) return "none";
		throw error;
	}
}

/**
 * Claims the lease the same way as `claimLocationLease`, but when `key` has no row yet, creates one under the
 * claim instead of answering `"none"` (round-7 review): a never-before-cold key is exactly the state a store
 * migration leaves behind after dropping a stale location (`migration.ts`), and without a row to claim through,
 * nothing stops a concurrent claimant from acting on the same key at the same time. `initial` must name where
 * the bytes actually are *right now*, before any copy has happened — the caller's source, never its intended
 * target (round-8 review, `B5`): a successful `recordObjectLocation` call overwrites it with the real,
 * confirmed destination, but a move that aborts after creating this row leaves it as the only account of this
 * key's location, and a target that nothing was ever copied to yet is simply false. Before migration 0104, or
 * on a database still missing the lease columns from an earlier version of it (both degrade the same way
 * `claimLocationLease` does), answers `"none"` rather than refusing every move over columns that cannot exist
 * yet; otherwise either a row ends up claimed, or `null` because someone else already holds one.
 */
async function claimOrCreateLocationLease(
	env: LocationEnv,
	key: string,
	initial: { objectClass: RoutableClass; storeId: string; storageClass: string | null; size: number },
	now = new Date(),
): Promise<LocationLease | "none" | null> {
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const token = newId("lease");
	const until = nowSeconds + LEASE_SECONDS;
	try {
		const claimed = await tryClaimExistingRow(env, key, token, until, nowSeconds);
		if (claimed) return claimed;
		const created = await env.DB.prepare(
			`INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at, lease_token, claimed_until)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (key) DO NOTHING`,
		)
			.bind(key, initial.objectClass, initial.storeId, initial.storageClass, initial.size, nowSeconds, token, until)
			.run();
		return (created.meta?.changes ?? 0) > 0 ? { token } : null;
	} catch (error) {
		if (isNoSuchTableError(error) || isMissingLeaseColumn(error)) return "none";
		throw error;
	}
}

/**
 * Extends a claim this caller still holds (its token still matches `key`'s row), for a long-running move
 * between steps (between multipart parts, before the final verify, `B3`); `false` once that token no longer
 * matches, meaning it already expired and someone else's claim is there now. Deliberately does not also
 * require the old `claimedUntil` to still be in the future: renewing is exactly how a holder that is cutting it
 * close keeps going, and the token match alone already proves nobody else has claimed the row since.
 */
export async function renewLocationLease(
	env: LocationEnv,
	key: string,
	token: string,
	now = new Date(),
): Promise<boolean> {
	const until = Math.floor(now.getTime() / 1000) + LEASE_SECONDS;
	try {
		const result = await env.DB.prepare(
			"UPDATE object_locations SET claimed_until = ? WHERE key = ? AND lease_token = ?",
		)
			.bind(until, key, token)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	} catch (error) {
		if (isNoSuchTableError(error) || isMissingLeaseColumn(error)) return true;
		throw error;
	}
}

/**
 * Releases a claim this caller holds, matched by its exact token: a no-op once that token no longer matches,
 * which means either it was already released (`recordObjectLocation` clears it itself on a successful,
 * fenced commit) or it expired and someone else's claim is there now, never a claim that is currently someone
 * else's to hold.
 */
export async function releaseLocationLease(env: LocationEnv, key: string, token: string): Promise<void> {
	try {
		await env.DB.prepare(
			"UPDATE object_locations SET lease_token = NULL, claimed_until = NULL WHERE key = ? AND lease_token = ?",
		)
			.bind(key, token)
			.run();
	} catch (error) {
		if (isNoSuchTableError(error) || isMissingLeaseColumn(error)) return;
		throw error;
	}
}

/** Thrown by `withLocationLease` when another cold move already holds `key`'s claim; caught the same way any
 * other per-item failure is, so the item is simply retried on a later batch or sweep. */
class LocationLeaseError extends Error {}

/**
 * Runs `fn` only while holding the claim on `key`, creating its `object_locations` row under that claim when
 * it does not exist yet (`claimOrCreateLocationLease`; round-7 review), or while there is nothing to claim
 * through at all before migration 0104 (`"none"`), releasing however `fn` ends. A cold move wraps its own
 * verify-copy-record-delete sequence in this (`B2`, `B3`), fencing it against a second concurrent mover of the
 * exact same key for as long as it keeps its claim renewed; `initial` is the row the move is working towards,
 * passed straight to `claimOrCreateLocationLease`.
 */
export async function withLocationLease<T>(
	env: LocationEnv,
	key: string,
	initial: { objectClass: RoutableClass; storeId: string; storageClass: string | null; size: number },
	fn: (lease: LocationLease | undefined) => Promise<T>,
): Promise<T> {
	const claimed = await claimOrCreateLocationLease(env, key, initial);
	if (claimed === null) throw new LocationLeaseError(`Another operation currently holds the lease for "${key}"`);
	const lease = claimed === "none" ? undefined : claimed;
	try {
		return await fn(lease);
	} finally {
		if (lease) await releaseLocationLease(env, key, lease.token);
	}
}

/** What a storage-migration purge holds while deciding about one key (`withPurgeLease`): its claim, if the
 * schema has the lease columns, and the store `object_locations` named when the claim was taken (null when the
 * key had no row). */
export type PurgeClaim = { lease: LocationLease | undefined; storeId: string | null };

/**
 * Runs a storage-migration purge's check-and-delete for `key` under the same location lease a cold move holds
 * from its copy through its own source delete (round-10 review, `B7`), so the purge can never delete a copy a
 * mover is in the middle of recording: an existing row's claim is taken the usual way, and a key with no row
 * yet gets one created under the claim, naming `initial.storeId` (the migration's new store, where the bytes
 * the purge keeps are), then removed again afterwards, so a purge leaves no rows behind for keys that were
 * never cold. Answers `"busy"` without running `fn` while someone else holds a live claim. Before migration
 * 0104 there is nothing to claim through; `fn` then runs with no lease and the recorded store read directly.
 */
export async function withPurgeLease<T>(
	env: LocationEnv,
	key: string,
	initial: { objectClass: RoutableClass; storeId: string; size: number },
	fn: (claim: PurgeClaim) => Promise<T>,
	now = new Date(),
): Promise<T | "busy"> {
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const token = newId("lease");
	const until = nowSeconds + LEASE_SECONDS;
	let claim: PurgeClaim;
	let created = false;
	try {
		const claimed = await tryClaimExistingRow(env, key, token, until, nowSeconds);
		if (claimed) {
			const row = await env.DB.prepare("SELECT store_id FROM object_locations WHERE key = ? AND lease_token = ?")
				.bind(key, token)
				.first<{ store_id: string }>();
			claim = { lease: claimed, storeId: row?.store_id ?? null };
		} else {
			const inserted = await env.DB.prepare(
				`INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at, lease_token, claimed_until)
				 VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
				 ON CONFLICT (key) DO NOTHING`,
			)
				.bind(key, initial.objectClass, initial.storeId, initial.size, nowSeconds, token, until)
				.run();
			if (!(inserted.meta?.changes ?? 0)) return "busy";
			created = true;
			claim = { lease: { token }, storeId: null };
		}
	} catch (error) {
		if (!isNoSuchTableError(error) && !isMissingLeaseColumn(error)) throw error;
		claim = { lease: undefined, storeId: (await lookupObjectLocation(env, key))?.storeId ?? null };
	}
	try {
		return await fn(claim);
	} finally {
		if (created) {
			// Only the row this purge itself created, and only while its token is still on it.
			await env.DB.prepare("DELETE FROM object_locations WHERE key = ? AND lease_token = ?").bind(key, token).run();
		} else if (claim.lease) await releaseLocationLease(env, key, claim.lease.token);
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
 * callers cannot both read "nothing previous" and both skip marking a copy the other is about to orphan. The
 * same batch also drops any stale candidate already recorded for this exact new `(storeId, key)` (`M1`): a copy
 * that is the recorded location is by definition not a leftover, so a later reference loss is found fresh by
 * the scan instead of being judged against a stale candidate's old window and old grace clock.
 *
 * `lease`, when given, fences the location write itself: it only lands while that lease's token still matches
 * `key`'s row, cleared in the same statement that commits (`B3`). Returns whether the write actually landed;
 * a cold move that gets `false` back must not trust its new copy is recorded and must not delete its old one.
 * Omit `lease` for a caller that never deletes a second copy of the same key (nothing here for it to race).
 */
export async function recordObjectLocation(
	env: LocationEnv,
	input: { key: string; objectClass: RoutableClass; storeId: string; storageClass: string | null; size: number },
	lease?: LocationLease,
): Promise<boolean> {
	const now = Math.floor(Date.now() / 1000);
	const markPrevious = env.DB.prepare(
		`INSERT INTO storage_cold_orphans (id, store_id, key, object_class, moved_at, orphaned_at, first_orphaned_at)
		 SELECT ?, store_id, key, object_class, moved_at, ?, ?
		 FROM object_locations WHERE key = ? AND store_id <> ?
		 ON CONFLICT (store_id, key) DO NOTHING`,
	).bind(newId("sco"), now, now, input.key, input.storeId);
	const upsert = lease
		? env.DB.prepare(
				`INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at, lease_token, claimed_until)
				 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
				 ON CONFLICT (key) DO UPDATE SET store_id = excluded.store_id, storage_class = excluded.storage_class,
				 size = excluded.size, moved_at = excluded.moved_at, lease_token = NULL, claimed_until = NULL
				 WHERE lease_token = ? AND claimed_until > ?`,
			).bind(input.key, input.objectClass, input.storeId, input.storageClass, input.size, now, lease.token, now)
		: env.DB.prepare(
				`INSERT INTO object_locations (key, object_class, store_id, storage_class, size, moved_at) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (key) DO UPDATE SET store_id = excluded.store_id, storage_class = excluded.storage_class,
				 size = excluded.size, moved_at = excluded.moved_at`,
			).bind(input.key, input.objectClass, input.storeId, input.storageClass, input.size, now);
	const clearTargetCandidate = env.DB.prepare("DELETE FROM storage_cold_orphans WHERE store_id = ? AND key = ?").bind(
		input.storeId,
		input.key,
	);
	try {
		const results = await env.DB.batch([markPrevious, upsert, clearTargetCandidate]);
		return lease ? (results[1].meta?.changes ?? 0) > 0 : true;
	} catch (error) {
		// `object_locations` exists (migration 0097) but `storage_cold_orphans` may not yet (migration 0104):
		// the location still needs recording on its own, just without the orphan candidate mark or clear, rather
		// than the whole batch (and so the location write) failing over a table nothing here strictly needs yet.
		if (!isNoSuchTableError(error)) throw error;
	}
	try {
		const result = await upsert.run();
		return lease ? (result.meta?.changes ?? 0) > 0 : true;
	} catch (error) {
		if (isNoSuchTableError(error) || isMissingLeaseColumn(error)) return true;
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

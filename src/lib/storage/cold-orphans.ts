import { and, eq, gt, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { objectLocations, storageColdOrphans, storageState } from "@/db/schema/storage";
import { ATTACHMENT_OBJECT_ROWS_SQL } from "@/lib/email/attachment-storage-utils";
import { messageIdFromHtmlBodyObjectKey } from "@/lib/email/bodies-utils";
import { backupIdFromR2Key } from "@/lib/backups/utils";
import { readRestoreJob } from "@/lib/backups/restore-job-store";
import { isActiveRestore } from "@/lib/backups/restore-job-utils";
import { createLogger } from "@/lib/logger.mjs";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { beforeBodyColumn } from "./migration";
import { isRoutableClass } from "./config-utils";
import { getStorage, type StoragePlatformEnv } from "./index";
import { lookupObjectLocation, markOrphanCandidate } from "./object-locations";
import { driveItemIdFromObjectKey } from "./object-classes-utils";
import type { RoutableClass } from "./types";

const log = createLogger("storage");

type ColdEnv = StoragePlatformEnv & Pick<CloudflareEnv, "OUTBOUND_QUEUE">;

/**
 * Whether a live row still names `key` for `objectClass`, the way a sweep's own candidate queries would find
 * it. False means nothing will ever read this key again: a message deleted between a mover copying its raw
 * mail (or an attachment, or an offloaded body) and recording the new location, a concurrent mover's own copy
 * to a different target left behind with its location overwritten, or a backup or Drive row gone the same way.
 * A body, Drive or backup key embeds the owning row's id, so those look it up by its indexed primary key
 * instead of scanning an unindexed column (`N3`); a key that does not parse as its class's shape can never be
 * live, so it is treated as unreferenced without a query.
 */
async function stillReferenced(env: ColdEnv, objectClass: RoutableClass, key: string): Promise<boolean> {
	if (objectClass === "backups") {
		const id = backupIdFromR2Key(key);
		if (!id) return false;
		const row = await env.DB.prepare(
			"SELECT 1 AS found FROM backups WHERE id = ? AND r2_key = ? AND status = 'completed'",
		)
			.bind(id, key)
			.first<{ found: number }>();
		return !!row;
	}
	if (objectClass === "drive") {
		const id = driveItemIdFromObjectKey(key);
		if (!id) return false;
		const row = await env.DB.prepare("SELECT 1 AS found FROM drive_items WHERE id = ? AND object_key = ?")
			.bind(id, key)
			.first<{ found: number }>();
		return !!row;
	}
	const raw = await env.DB.prepare("SELECT 1 AS found FROM messages WHERE raw_r2_key = ?")
		.bind(key)
		.first<{ found: number }>();
	if (raw) return true;
	const attachment = await env.DB.prepare(
		`SELECT 1 AS found FROM message_attachments WHERE r2_key = ? AND ${ATTACHMENT_OBJECT_ROWS_SQL}`,
	)
		.bind(key)
		.first<{ found: number }>();
	if (attachment) return true;
	const messageId = messageIdFromHtmlBodyObjectKey(key);
	if (!messageId) return false;
	const body = await beforeBodyColumn(
		() =>
			env.DB.prepare("SELECT 1 AS found FROM messages WHERE id = ? AND html_body_key = ?")
				.bind(messageId, key)
				.first<{ found: number }>(),
		null,
	);
	return !!body;
}

const PRUNE_BATCH = 200;
/** A candidate waits this long as a recorded orphan before it is actually deleted, re-checking its reference
 * at that point: long enough that a backup restore in progress always finishes well within it. A restore's
 * "deletes" segment empties `messages`, `message_attachments`, `drive_items` and `backups` before writing them
 * back, possibly over several queue invocations, and the rollback path does the same; `object_locations` is a
 * merge table, so a sweep mid-restore would otherwise see every cold key as unreferenced. */
const ORPHAN_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
/** How long after a restore finishes (or while one is active) the sweep skips a run entirely, on top of the
 * grace period above: belt and suspenders, so a run landing in the middle of that window records no new
 * candidates from state the restore has not finished settling. */
const RESTORE_COOLDOWN_MS = 60 * 60 * 1000;

/** Whether a restore is running, or finished recently enough that the sweep should stay out of its way. */
async function restoreRanRecently(env: ColdEnv, now: number): Promise<boolean> {
	const stored = await readRestoreJob(env.BUCKET);
	if (!stored) return false;
	if (isActiveRestore(stored.job)) return true;
	if (!stored.job.finishedAt) return false;
	return now - Date.parse(stored.job.finishedAt) < RESTORE_COOLDOWN_MS;
}

type ScanCursor = { movedAt: number; key: string };

function parseScanCursor(value: string | null | undefined): ScanCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Partial<ScanCursor>;
		return typeof parsed.movedAt === "number" && typeof parsed.key === "string"
			? { movedAt: parsed.movedAt, key: parsed.key }
			: null;
	} catch {
		return null;
	}
}

async function readScanCursor(env: ColdEnv): Promise<ScanCursor | null> {
	try {
		const [row] = await getDb(env)
			.select({ cursor: storageState.coldOrphanCursor })
			.from(storageState)
			.where(eq(storageState.id, "default"))
			.limit(1);
		return parseScanCursor(row?.cursor);
	} catch (error) {
		if (isNoSuchTableError(error)) return null;
		throw error;
	}
}

async function writeScanCursor(env: ColdEnv, cursor: ScanCursor | null): Promise<void> {
	const value = cursor ? JSON.stringify(cursor) : null;
	try {
		await getDb(env)
			.insert(storageState)
			.values({ id: "default", coldOrphanCursor: value, updatedAt: new Date() })
			.onConflictDoUpdate({ target: storageState.id, set: { coldOrphanCursor: value, updatedAt: new Date() } });
	} catch (error) {
		if (isNoSuchTableError(error)) return;
		throw error;
	}
}

/**
 * One bounded, round-robin pass over `object_locations`, keyset-paginated from a cursor saved in `storage_state`
 * rather than always rechecking the same oldest rows: a backlog larger than one batch is still fully covered,
 * a batch at a time, over many five-minute runs, instead of the same `PRUNE_BATCH` rows absorbing every run
 * forever while anything behind them in the order is never reached (`N3`). A row found unreferenced becomes a
 * candidate (`markOrphanCandidate`) rather than being deleted here; actually deleting it is `deleteGracePeriodOrphans`.
 */
async function scanForOrphanCandidates(env: ColdEnv, now: Date): Promise<{ checked: number }> {
	const cursor = await readScanCursor(env);
	let rows: { key: string; objectClass: string; storeId: string; movedAt: Date }[];
	try {
		rows = await getDb(env)
			.select({
				key: objectLocations.key,
				objectClass: objectLocations.objectClass,
				storeId: objectLocations.storeId,
				movedAt: objectLocations.movedAt,
			})
			.from(objectLocations)
			.where(
				cursor
					? or(
							gt(objectLocations.movedAt, new Date(cursor.movedAt * 1000)),
							and(eq(objectLocations.movedAt, new Date(cursor.movedAt * 1000)), gt(objectLocations.key, cursor.key)),
						)
					: undefined,
			)
			.orderBy(objectLocations.movedAt, objectLocations.key)
			.limit(PRUNE_BATCH);
	} catch (error) {
		if (isNoSuchTableError(error)) return { checked: 0 };
		throw error;
	}
	for (const row of rows) {
		if (!isRoutableClass(row.objectClass)) continue;
		try {
			if (await stillReferenced(env, row.objectClass, row.key)) continue;
			await markOrphanCandidate(env, { storeId: row.storeId, key: row.key, objectClass: row.objectClass }, now);
		} catch {
			continue;
		}
	}
	// Fewer rows than the limit means this batch ran off the end of the table; start over from the top next
	// time rather than saving a cursor nothing is ever after.
	const last = rows.length === PRUNE_BATCH ? rows.at(-1) : undefined;
	await writeScanCursor(env, last ? { movedAt: Math.floor(last.movedAt.getTime() / 1000), key: last.key } : null);
	return { checked: rows.length };
}

/**
 * Deletes recorded orphan candidates whose grace period has passed, from the store that holds each, re-checking
 * its reference first: a restore that lands during the grace period and brings a key's row back (or a message,
 * Drive or backup row that references it again) takes it off the list instead of the delete happening anyway.
 * Nothing is ever deleted here that was not already a recorded candidate.
 */
async function deleteGracePeriodOrphans(env: ColdEnv, now: number): Promise<{ pruned: number }> {
	let candidates: { id: string; key: string; objectClass: string; storeId: string }[];
	try {
		candidates = await getDb(env)
			.select({
				id: storageColdOrphans.id,
				key: storageColdOrphans.key,
				objectClass: storageColdOrphans.objectClass,
				storeId: storageColdOrphans.storeId,
			})
			.from(storageColdOrphans)
			.where(lte(storageColdOrphans.orphanedAt, new Date(now - ORPHAN_GRACE_PERIOD_MS)))
			.orderBy(storageColdOrphans.orphanedAt)
			.limit(PRUNE_BATCH);
	} catch (error) {
		if (isNoSuchTableError(error)) return { pruned: 0 };
		throw error;
	}
	if (!candidates.length) return { pruned: 0 };
	const storage = await getStorage(env);
	let pruned = 0;
	for (const candidate of candidates) {
		if (!isRoutableClass(candidate.objectClass)) continue;
		try {
			// A key names the same bytes on whichever store holds it, so a live row's reference to the key
			// cannot by itself tell this candidate's copy apart from the one `object_locations` currently
			// points at for the same key (a losing mover's or a migration's leftover copy, `recordObjectLocation`
			// and `runItems` in migration.ts, is exactly a second copy of a key something else still needs).
			// Only a candidate that is still the recorded location is kept on that question; any other
			// candidate's copy is never the one anything reads through the normal chain, whatever the key's
			// liveness says, so it is always safe to delete.
			const current = await lookupObjectLocation(env, candidate.key);
			if (
				current &&
				current.storeId === candidate.storeId &&
				(await stillReferenced(env, candidate.objectClass, candidate.key))
			) {
				await getDb(env).delete(storageColdOrphans).where(eq(storageColdOrphans.id, candidate.id));
				continue;
			}
			const store = storage.store(candidate.storeId);
			if (!store) continue;
			// A store that cannot be reached right now (a bad endpoint, a revoked credential) throws here;
			// the candidate is left for the next run to try again, the same as router.ts's own delete.
			await store.bucket.delete(candidate.key);
			await getDb(env).delete(storageColdOrphans).where(eq(storageColdOrphans.id, candidate.id));
			// Only this exact copy's own row, never a different store's current one sharing the same key.
			await getDb(env)
				.delete(objectLocations)
				.where(and(eq(objectLocations.key, candidate.key), eq(objectLocations.storeId, candidate.storeId)));
			pruned += 1;
		} catch {
			continue;
		}
	}
	if (pruned) log.warn("storage.cold_orphans_pruned", { checked: candidates.length, pruned });
	return { pruned };
}

/**
 * Cleans up cold-moved copies nothing live references any more, in two phases that never delete anything on
 * first sighting (`N1`): `scanForOrphanCandidates` marks what looks unreferenced right now, and
 * `deleteGracePeriodOrphans` only deletes a mark old enough to have survived a grace period, re-checking then.
 * Skips the run entirely around a restore, active or recently finished, which could otherwise make every cold
 * key look briefly unreferenced. Called from the five-minute cron.
 */
export async function pruneOrphanedColdLocations(
	env: ColdEnv,
	now = new Date(),
): Promise<{ checked: number; pruned: number }> {
	if (await restoreRanRecently(env, now.getTime())) return { checked: 0, pruned: 0 };
	const { checked } = await scanForOrphanCandidates(env, now);
	const { pruned } = await deleteGracePeriodOrphans(env, now.getTime());
	return { checked, pruned };
}

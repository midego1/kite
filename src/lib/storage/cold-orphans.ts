import { and, eq, gt, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { objectLocations, storageColdOrphans, storageState } from "@/db/schema/storage";
import { ATTACHMENT_OBJECT_ROWS_SQL } from "@/lib/email/attachment-storage-utils";
import { messageIdFromHtmlBodyObjectKey } from "@/lib/email/bodies-utils";
import { backupIdFromR2Key } from "@/lib/backups/utils";
import { readRestoreJob } from "@/lib/backups/restore-job-store";
import { isActiveRestore } from "@/lib/backups/restore-job-utils";
import { createLogger } from "@/lib/logger.mjs";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { beforeBodyColumn } from "./migration";
import { isRoutableClass } from "./config-utils";
import { getStorage, type StoragePlatformEnv } from "./index";
import { claimKeyLease, lookupObjectLocation, markOrphanCandidate, releaseKeyLease } from "./object-locations";
import { driveItemIdFromObjectKey } from "./object-classes-utils";
import type { RoutableClass, Storage } from "./types";

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

/**
 * Whether a restore is running, needs recovery, or finished recently enough that the sweep should stay out of
 * its way. `needsRecovery` means the database is known to still be partially restored (an abandoned restore
 * whose rollback never ran, or one whose rollback itself failed): the admin is meant to run the safety recovery,
 * and until that completes (clearing the flag) a row this sweep would see as unreferenced may simply not be
 * written back yet, the same risk the active-restore and cooldown checks below exist for.
 */
async function restoreRanRecently(env: ColdEnv, now: number): Promise<boolean> {
	const stored = await readRestoreJob(env.BUCKET);
	if (!stored) return false;
	if (isActiveRestore(stored.job) || stored.job.needsRecovery) return true;
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

const COLD_ORPHAN_CURSOR_COLUMN = "cold_orphan_cursor";

/** `storage_state` (migration 0085) can exist without its `cold_orphan_cursor` column (migration 0103) applied
 * yet, between an install's 0097 and 0103: reads then stand in as "no cursor", the same as the column's own
 * default, rather than failing the whole sweep every five minutes over a column nothing here strictly needs yet. */
async function readScanCursor(env: ColdEnv): Promise<ScanCursor | null> {
	try {
		const [row] = await getDb(env)
			.select({ cursor: storageState.coldOrphanCursor })
			.from(storageState)
			.where(eq(storageState.id, "default"))
			.limit(1);
		return parseScanCursor(row?.cursor);
	} catch (error) {
		if (isNoSuchTableError(error) || missingColumnFromError(error) === COLD_ORPHAN_CURSOR_COLUMN) return null;
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
		if (isNoSuchTableError(error) || missingColumnFromError(error) === COLD_ORPHAN_CURSOR_COLUMN) return;
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
			await markOrphanCandidate(
				env,
				{ storeId: row.storeId, key: row.key, objectClass: row.objectClass, movedAt: row.movedAt },
				now,
			);
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
 * Whether a retained backup could still bring back a reference to this exact copy: a restore merges
 * `object_locations` rather than replacing it, so a `completed` backup finished while this copy was still the
 * recorded location may hold that exact row and expect the bytes still to be there (`N2`). Narrowed to backups
 * completed in `[movedAt, firstOrphanedAt)` (`B1`): once this copy was superseded, a later backup has the newer
 * location instead, so it can never be a reason to keep this one. Once every backup in that window is pruned by
 * retention, this stops finding one and the candidate becomes deletable, instead of every future nightly backup
 * (`completed_at` only ever grows) pinning it forever. Deliberately not narrowed further to backups that still
 * have this specific key (reading each one's export would cost far more than the sweep is worth); keeping a
 * candidate a little longer than strictly necessary is cheap, losing it permanently is not.
 */
async function retainedBackupMightNeedIt(env: ColdEnv, movedAt: Date, firstOrphanedAt: Date): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 AS found FROM backups WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?",
	)
		.bind(Math.floor(movedAt.getTime() / 1000), Math.floor(firstOrphanedAt.getTime() / 1000))
		.first<{ found: number }>();
	return !!row;
}

/** Pushes a candidate this run could not resolve to the back of the delete queue (a fresh `orphanedAt`), so it
 * stops absorbing every run ahead of candidates that might actually be deletable (`L3`): an unreachable store,
 * a retained backup that might still need it, or another caller holding the key's lease right now, is not
 * reason enough to hold up anything else. */
async function deferOrphanCandidate(env: ColdEnv, id: string, now: number): Promise<void> {
	await getDb(env)
		.update(storageColdOrphans)
		.set({ orphanedAt: new Date(now) })
		.where(eq(storageColdOrphans.id, id));
}

type OrphanCandidate = { id: string; key: string; objectClass: RoutableClass; storeId: string };

/**
 * Decides and, if safe, carries out the actual delete of one candidate's copy, holding the key's lease for the
 * whole decision: nothing else that deletes a copy of this key (a cold move putting it back onto this very
 * store) can run while this is held, which is what makes the re-read below authoritative instead of a snapshot
 * a concurrent mover can invalidate a moment later (`B2`). Deferred when the lease is already held, an
 * unreachable store answers, or the only other claimed copy does not actually exist yet (or any more).
 */
async function finalizeOrphanCandidate(
	env: ColdEnv,
	storage: Storage,
	candidate: OrphanCandidate,
): Promise<"deleted" | "kept" | "deferred"> {
	const lease = await claimKeyLease(env, candidate.key);
	if (lease === null) return "deferred";
	try {
		// A key names the same bytes on whichever store holds it, so a live row's reference to the key cannot
		// by itself tell this candidate's copy apart from the one `object_locations` currently points at for
		// the same key (a losing mover's or a migration's leftover copy is exactly a second copy of a key
		// something else still needs). Only a candidate that is still the recorded location is kept on that
		// question; any other candidate's copy is never the one anything reads through the normal chain,
		// whatever the key's liveness says, so it is always safe to delete (subject to the checks below).
		const current = await lookupObjectLocation(env, candidate.key);
		const isCurrent = !!current && current.storeId === candidate.storeId;
		const referenced = isCurrent && (await stillReferenced(env, candidate.objectClass, candidate.key));
		if (referenced) return "kept"; // the lease's fresh read found this copy is the live one again
		if (!isCurrent && current && (await stillReferenced(env, candidate.objectClass, candidate.key))) {
			// A new mover already confirmed this exact key belongs on `current`'s store, between its own HEAD
			// and its `recordObjectLocation`, before this call ever took the lease it would also need to do
			// that. Confirm that other store actually still has a readable copy before deleting this one; if
			// it does not (yet, or any more), this may be the only copy left and the delete waits instead.
			const other = storage.store(current.storeId);
			const readable = other && (await other.bucket.head(candidate.key).catch(() => null));
			if (!readable) return "deferred";
		}
		const store = storage.store(candidate.storeId);
		if (!store) return "deferred"; // blocked or missing right now (a bad endpoint, a revoked credential)
		try {
			await store.bucket.delete(candidate.key);
		} catch {
			return "deferred"; // unreachable right now rather than durably missing
		}
		return "deleted";
	} finally {
		await releaseKeyLease(env, candidate.key, lease);
	}
}

/**
 * Deletes recorded orphan candidates whose grace period has passed, from the store that holds each, re-checking
 * its reference first: a restore that lands during the grace period and brings a key's row back (or a message,
 * Drive or backup row that references it again) takes it off the list instead of the delete happening anyway.
 * Nothing is ever deleted here that was not already a recorded candidate.
 */
async function deleteGracePeriodOrphans(env: ColdEnv, now: number): Promise<{ pruned: number }> {
	let candidates: {
		id: string;
		key: string;
		objectClass: string;
		storeId: string;
		movedAt: Date;
		firstOrphanedAt: Date;
	}[];
	try {
		candidates = await getDb(env)
			.select({
				id: storageColdOrphans.id,
				key: storageColdOrphans.key,
				objectClass: storageColdOrphans.objectClass,
				storeId: storageColdOrphans.storeId,
				movedAt: storageColdOrphans.movedAt,
				firstOrphanedAt: storageColdOrphans.firstOrphanedAt,
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
			// Cheap pre-filters that need no lease, since neither can ever cause an incorrect delete: at worst
			// they defer a candidate that was actually fine, never the other way around.
			const current = await lookupObjectLocation(env, candidate.key);
			const isCurrent = !!current && current.storeId === candidate.storeId;
			if (isCurrent && (await stillReferenced(env, candidate.objectClass, candidate.key))) {
				await getDb(env).delete(storageColdOrphans).where(eq(storageColdOrphans.id, candidate.id));
				continue;
			}
			if (await retainedBackupMightNeedIt(env, candidate.movedAt, candidate.firstOrphanedAt)) {
				await deferOrphanCandidate(env, candidate.id, now);
				continue;
			}
			const result = await finalizeOrphanCandidate(env, storage, {
				id: candidate.id,
				key: candidate.key,
				objectClass: candidate.objectClass,
				storeId: candidate.storeId,
			});
			if (result === "deferred") {
				await deferOrphanCandidate(env, candidate.id, now);
				continue;
			}
			await getDb(env).delete(storageColdOrphans).where(eq(storageColdOrphans.id, candidate.id));
			if (result === "kept") continue; // the live location again; only the stale tracking row needed to go
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

import { and, eq, gt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { objectLocations, storageColdOrphans, storageState } from "@/db/schema/storage";
import { ATTACHMENT_OBJECT_ROWS_SQL } from "@/lib/email/attachment-storage-utils";
import { messageIdFromHtmlBodyObjectKey } from "@/lib/email/bodies-utils";
import { backupIdFromR2Key } from "@/lib/backups/utils";
import { readRestoreJob } from "@/lib/backups/restore-job-store";
import { isActiveRestore } from "@/lib/backups/restore-job-utils";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { beforeBodyColumn } from "./migration";
import { isRoutableClass } from "./config-utils";
import type { StoragePlatformEnv } from "./index";
import { markOrphanCandidate } from "./object-locations";
import { driveItemIdFromObjectKey } from "./object-classes-utils";
import type { RoutableClass } from "./types";

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
/** How long after a restore finishes (or while one is active) the sweep skips a run entirely: a restore's
 * "deletes" segment empties `messages`, `message_attachments`, `drive_items` and `backups` before writing them
 * back, possibly over several queue invocations, and the rollback path does the same; `object_locations` is a
 * merge table, so a sweep mid-restore would otherwise see every cold key as briefly unreferenced. */
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

/** `storage_state` (migration 0085) can exist without its `cold_orphan_cursor` column (migration 0104) applied
 * yet, between an install's 0097 and 0104: reads then stand in as "no cursor", the same as the column's own
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
 * candidate (`markOrphanCandidate`) rather than being deleted here, or anywhere in this PR (round-9 review, `B6`).
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
 * Marks cold-moved copies nothing live references any more as orphan candidates (`N1`: never deletes anything
 * on first sighting). Skips the run entirely around a restore, active or recently finished, which could
 * otherwise make every cold key look briefly unreferenced. Called from the five-minute cron.
 *
 * This PR deletes no leftover copy at all, automatically or manually (round-9 review, foreman decision): an
 * earlier round added a manual, per-store "Delete leftovers" admin action running the grace-period, backup-
 * window and lease-fenced deletion the automatic cron used to run on its own, but the round-9 review found it
 * unfenced for a key with no `object_locations` row yet and reproduced the loss of every copy of a live
 * message through it (`B6`). Rather than extend the fencing further, that whole deletion path — the action,
 * its route and its button — was removed; only marking remains, and `countOrphanCandidates` below is read-only.
 * Cleanup of a tracked candidate is a follow-up for a later release. See the PR body.
 */
export async function pruneOrphanedColdLocations(env: ColdEnv, now = new Date()): Promise<{ checked: number }> {
	if (await restoreRanRecently(env, now.getTime())) return { checked: 0 };
	return await scanForOrphanCandidates(env, now);
}

/** The read-only leftover count Admin → Storage shows next to a store: every orphan candidate currently
 * tracked for it, so an admin can see the backlog without anything in this PR offering to delete it. */
export async function countOrphanCandidates(env: ColdEnv, storeId: string): Promise<number> {
	try {
		const [row] = await getDb(env)
			.select({ count: sql<number>`count(*)` })
			.from(storageColdOrphans)
			.where(eq(storageColdOrphans.storeId, storeId));
		return row?.count ?? 0;
	} catch (error) {
		if (isNoSuchTableError(error)) return 0;
		throw error;
	}
}

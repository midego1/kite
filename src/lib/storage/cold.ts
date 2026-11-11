import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { storageColdJobs, storageColdRules } from "@/db/schema/storage";
import { createLogger } from "@/lib/logger.mjs";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { countOrphanCandidates, pruneOrphanedColdLocations } from "./cold-orphans";
import { runAutomaticLeftoverCleanup } from "./cold-leftovers";
import { dropStrandedPurgeRows, storeHoldsLocatedObjects } from "./object-locations";
import {
	COLD_STORAGE_CLASS,
	initialColdCursor,
	nextColdSource,
	advanceColdCursor,
	parseColdCursor,
	R2_IA_TARGET,
	selectColdCandidates,
	STORAGE_COLD_KIND,
	isStorageColdMessage,
	type ColdCursor,
	type ColdRule,
	type StorageColdMessage,
} from "./cold-utils";
import { coldPage, driveColdPage, type Item } from "./cold-sources";
import { moveColdObject, moveColdDriveObject } from "./cold-move";
import { DEFAULT_STORE_ID, isRoutableClass, ROUTABLE_CLASSES } from "./config-utils";
import { processStorageMigration } from "./migration";
import {
	isLeased,
	isStalled,
	isStorageMigrateMessage,
	LEASE_MS,
	MAX_BATCH_BYTES,
	MAX_BATCH_OBJECTS,
	takeBatch,
	type MigrationSource,
} from "./migration-utils";
import { classLabel } from "./cold-rules";
import { getStorage, type StoragePlatformEnv } from "./index";
import type { RoutableClass, Storage } from "./types";

const log = createLogger("storage");

/** Consecutive failed batches before a sweep is marked failed; the nightly cron starts a fresh one the next day. */
const MAX_FAILURES = 5;

export type ColdEnv = StoragePlatformEnv & Pick<CloudflareEnv, "OUTBOUND_QUEUE">;
type Job = typeof storageColdJobs.$inferSelect;

function describeError(error: unknown): string {
	return (error instanceof Error ? error.message : "Unknown error").slice(0, 300);
}

async function enqueue(env: ColdEnv, objectClass: RoutableClass, delaySeconds?: number): Promise<void> {
	const message: StorageColdMessage = { kind: STORAGE_COLD_KIND, objectClass };
	await env.OUTBOUND_QUEUE.send(message, delaySeconds ? { delaySeconds } : undefined);
}

async function loadColdRule(env: ColdEnv, objectClass: RoutableClass): Promise<ColdRule | null> {
	const [row] = await getDb(env)
		.select()
		.from(storageColdRules)
		.where(eq(storageColdRules.objectClass, objectClass))
		.limit(1);
	if (!row || !row.enabled) return null;
	return { objectClass, afterDays: row.afterDays, minBytes: row.minBytes, target: row.target };
}

async function listColdRules(env: ColdEnv): Promise<(typeof storageColdRules.$inferSelect)[]> {
	try {
		return await getDb(env).select().from(storageColdRules);
	} catch (error) {
		if (isNoSuchTableError(error)) return [];
		throw error;
	}
}

export type ColdRuleView = {
	objectClass: RoutableClass;
	afterDays: number;
	minBytes: number;
	target: string;
	enabled: boolean;
	updatedAt: string | null;
};

/** One view per routable class, defaulted for a class with no saved rule yet (shown off, never saved as such). */
export async function coldRulesView(env: ColdEnv): Promise<ColdRuleView[]> {
	const rows = await listColdRules(env);
	return ROUTABLE_CLASSES.map((objectClass) => {
		const row = rows.find((candidate) => candidate.objectClass === objectClass);
		return row
			? {
					objectClass,
					afterDays: row.afterDays,
					minBytes: row.minBytes,
					target: row.target,
					enabled: row.enabled,
					updatedAt: row.updatedAt?.toISOString() ?? null,
				}
			: { objectClass, afterDays: 30, minBytes: 0, target: R2_IA_TARGET, enabled: false, updatedAt: null };
	});
}

export { updateColdRule } from "./cold-rules";

export async function listColdJobs(env: ColdEnv): Promise<Job[]> {
	try {
		return await getDb(env).select().from(storageColdJobs).orderBy(desc(storageColdJobs.createdAt));
	} catch (error) {
		if (isNoSuchTableError(error)) return [];
		throw error;
	}
}

async function loadJob(env: ColdEnv, objectClass: RoutableClass): Promise<Job | null> {
	const [job] = await getDb(env)
		.select()
		.from(storageColdJobs)
		.where(eq(storageColdJobs.objectClass, objectClass))
		.limit(1);
	return job ?? null;
}

/**
 * Starts a fresh sweep for every class with an enabled rule whose previous sweep (if any) is not still running;
 * called from the 02:00 cron, and from the admin "Run now" action for one class.
 */
export async function runColdStorageSweep(
	env: ColdEnv,
	now = new Date(),
	options: { classes?: readonly RoutableClass[] } = {},
): Promise<void> {
	for (const objectClass of options.classes ?? ROUTABLE_CLASSES) {
		const rule = await loadRuleSafely(env, objectClass);
		if (!rule) continue;
		const existing = await loadJob(env, objectClass);
		if (existing && (existing.status === "queued" || existing.status === "running")) continue;
		const cursor = initialColdCursor(rule, now);
		await getDb(env)
			.insert(storageColdJobs)
			.values({ objectClass, status: "queued", cursor: JSON.stringify(cursor), createdAt: now })
			.onConflictDoUpdate({
				target: storageColdJobs.objectClass,
				set: {
					status: "queued",
					cursor: JSON.stringify(cursor),
					objectsDone: 0,
					bytesDone: 0,
					errors: 0,
					lastError: null,
					startedAt: null,
					finishedAt: null,
				},
			});
		await enqueue(env, objectClass);
	}
}

async function loadRuleSafely(env: ColdEnv, objectClass: RoutableClass): Promise<ColdRule | null> {
	try {
		return await loadColdRule(env, objectClass);
	} catch (error) {
		if (isNoSuchTableError(error)) return null;
		throw error;
	}
}

/** Takes the job for one batch by swapping its cursor; false when another delivery already holds it. */
async function claim(
	env: ColdEnv,
	objectClass: RoutableClass,
	state: ColdCursor,
	cursorJson: string | null,
	now: number,
): Promise<ColdCursor | null> {
	if (isLeased(state, now)) return null;
	const claimed: ColdCursor = { ...state, leaseUntil: now + LEASE_MS };
	const result = await env.DB.prepare(
		`UPDATE storage_cold_jobs SET cursor = ?, status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
		 started_at = coalesce(started_at, ?) WHERE object_class = ? AND coalesce(cursor, '') = ?`,
	)
		.bind(JSON.stringify(claimed), Math.floor(now / 1000), objectClass, cursorJson ?? "")
		.run();
	return (result.meta?.changes ?? 0) > 0 ? claimed : null;
}

type BatchResult = { processed: number; bytes: number; errors: number; lastError: string | null };

async function runColdItems(
	env: ColdEnv,
	storage: Storage,
	objectClass: RoutableClass,
	rule: ColdRule,
	items: Item[],
): Promise<BatchResult> {
	const result: BatchResult = { processed: 0, bytes: 0, errors: 0, lastError: null };
	for (const item of items) {
		try {
			result.bytes += await moveColdObject(env, storage, objectClass, rule, item);
			result.processed += 1;
		} catch (error) {
			result.errors += 1;
			result.lastError = describeError(error);
		}
	}
	return result;
}

/** Each file marks its own row cold as it moves (`moveColdDriveObject`), not batched after the whole page: a
 * crash partway through a page must not leave an earlier file's row stuck pointing at an already-deleted copy. */
async function runDriveSource(
	env: ColdEnv,
	storage: Storage,
	state: ColdCursor,
): Promise<{ next: ColdCursor; result: BatchResult }> {
	const after = state.sources.drive ?? null;
	const page = await driveColdPage(state.rule, state.cutoffAt, after);
	const batch = takeBatch(page.items, { objects: MAX_BATCH_OBJECTS, bytes: MAX_BATCH_BYTES });
	const result: BatchResult = { processed: 0, bytes: 0, errors: 0, lastError: null };
	for (const item of batch) {
		try {
			result.bytes += (await moveColdDriveObject(env, storage, state.rule, item)).bytes;
			result.processed += 1;
		} catch (error) {
			result.errors += 1;
			result.lastError = describeError(error);
		}
	}
	const exhausted = page.exhausted && batch.length === page.items.length;
	const next = advanceColdCursor(state, "drive", batch.at(-1)?.id ?? after, exhausted);
	return { next, result };
}

async function runD1Source(
	env: ColdEnv,
	objectClass: RoutableClass,
	source: MigrationSource,
	state: ColdCursor,
): Promise<{ next: ColdCursor; result: BatchResult }> {
	const after = state.sources[source] ?? null;
	const page = await coldPage(env, source, state.rule, state.cutoffAt, after);
	const batch = takeBatch(selectColdCandidates(state.rule, new Date(state.cutoffAt * 1000), page.items), {
		objects: MAX_BATCH_OBJECTS,
		bytes: MAX_BATCH_BYTES,
	});
	const storage = await getStorage(env);
	const result = await runColdItems(env, storage, objectClass, state.rule, batch);
	const exhausted = page.exhausted && batch.length === page.items.length;
	const next = advanceColdCursor(state, source, batch.at(-1)?.id ?? after, exhausted);
	return { next, result };
}

async function finishJob(env: ColdEnv, objectClass: RoutableClass): Promise<void> {
	await env.DB.prepare(
		`UPDATE storage_cold_jobs SET status = 'completed', finished_at = ? WHERE object_class = ? AND status NOT IN ('failed')`,
	)
		.bind(Math.floor(Date.now() / 1000), objectClass)
		.run();
}

async function processColdBatch(
	env: ColdEnv,
	objectClass: RoutableClass,
	state: ColdCursor,
): Promise<{ again: boolean }> {
	const source = nextColdSource(state);
	if (!source) {
		await finishJob(env, objectClass);
		return { again: false };
	}
	const { next, result } =
		source === "drive"
			? await runDriveSource(env, await getStorage(env), state)
			: await runD1Source(env, objectClass, source, state);
	const now = Date.now();
	// The write only lands while this worker's claim is still the row's current cursor: a batch slow enough to
	// outlive its lease (LEASE_MS) can otherwise overlap with whoever reclaimed it next and overwrite that
	// worker's own progress, or re-enqueue a batch nobody needs, on top of whatever moved objects already did.
	const written = await env.DB.prepare(
		`UPDATE storage_cold_jobs SET cursor = ?, objects_done = objects_done + ?, bytes_done = bytes_done + ?,
		 errors = errors + ?, last_error = coalesce(?, last_error)
		 WHERE object_class = ? AND status NOT IN ('failed') AND cursor = ?`,
	)
		.bind(
			JSON.stringify({ ...next, leaseUntil: undefined, lastBatchAt: now, failures: 0 }),
			result.processed,
			result.bytes,
			result.errors,
			result.lastError,
			objectClass,
			JSON.stringify(state),
		)
		.run();
	if (result.lastError) log.warn("storage.cold_errors", { objectClass, errors: result.errors });
	if (!(written.meta?.changes ?? 0)) {
		log.warn("storage.cold_lease_lost", { objectClass });
		return { again: false };
	}
	return { again: true };
}

/** The `storage.cold` queue message: one batch, then the next message. Never throws, so the queue never retries it. */
async function processStorageCold(env: ColdEnv, message: StorageColdMessage): Promise<void> {
	const { objectClass } = message;
	if (!isRoutableClass(objectClass)) return;
	const job = await loadJob(env, objectClass);
	if (!job || job.status === "completed" || job.status === "failed") return;
	let state: ColdCursor;
	try {
		state = parseColdCursor(job.cursor);
	} catch {
		await getDb(env)
			.update(storageColdJobs)
			.set({ status: "failed", lastError: "Damaged cursor", finishedAt: new Date() })
			.where(eq(storageColdJobs.objectClass, objectClass));
		return;
	}
	const claimed = await claim(env, objectClass, state, job.cursor, Date.now());
	if (!claimed) return;
	try {
		const { again } = await processColdBatch(env, objectClass, claimed);
		if (again) await enqueue(env, objectClass);
	} catch (error) {
		const failures = (claimed.failures ?? 0) + 1;
		const failed = failures >= MAX_FAILURES;
		log.error("storage.cold_batch_failed", { objectClass, failures, error });
		await env.DB.prepare(
			`UPDATE storage_cold_jobs SET cursor = ?, last_error = ?, status = CASE WHEN ? THEN 'failed' ELSE status END WHERE object_class = ?`,
		)
			.bind(
				JSON.stringify({ ...claimed, leaseUntil: undefined, lastBatchAt: Date.now(), failures }),
				describeError(error),
				failed ? 1 : 0,
				objectClass,
			)
			.run();
		if (!failed) await enqueue(env, objectClass, 60);
	}
}

/** The 5-minute cron: re-sends a sweep whose batches stopped arriving (a lost message, a deploy). */
export async function runStorageColdMaintenance(env: ColdEnv, now = new Date()): Promise<void> {
	let jobs: Job[];
	try {
		jobs = await getDb(env)
			.select()
			.from(storageColdJobs)
			.where(inArray(storageColdJobs.status, ["queued", "running"]));
	} catch (error) {
		if (isNoSuchTableError(error)) return;
		throw error;
	}
	for (const job of jobs) {
		if (!isRoutableClass(job.objectClass)) continue;
		let state: ColdCursor;
		try {
			state = parseColdCursor(job.cursor);
		} catch {
			continue;
		}
		if (isStalled(state, now.getTime(), job.startedAt?.getTime() ?? job.createdAt.getTime()))
			await enqueue(env, job.objectClass);
	}
	// Before the scan, so a purge's stranded claim row (`m2`) is never mistaken for a cold location.
	await dropStrandedPurgeRows(env, now);
	await pruneOrphanedColdLocations(env, now);
	// Off unless the admin turned the automatic cleanup on (Admin → Storage).
	await runAutomaticLeftoverCleanup(env, now);
}

/** The default store's current capability to hold a storage class, for the admin UI's target options. */
export async function coldIaAvailable(env: ColdEnv): Promise<boolean> {
	const storage = await getStorage(env);
	return !!storage.store(DEFAULT_STORE_ID)?.capabilities.storageClasses.includes(COLD_STORAGE_CLASS);
}

/** Rows of a query on a cold storage table, or none before the migration that creates it. */
async function rowsOrNone<T>(query: () => Promise<T[]>): Promise<T[]> {
	try {
		return await query();
	} catch (error) {
		if (isNoSuchTableError(error)) return [];
		throw error;
	}
}

/** The class of an in-flight (queued or running) sweep whose cursor targets `id`: the cursor keeps the rule as
 * it was when the sweep began, so a rule changed or disabled since would not show up any other way. */
async function activeSweepTargeting(env: ColdEnv, id: string): Promise<string | null> {
	const activeJobs = await rowsOrNone(() =>
		getDb(env)
			.select({ objectClass: storageColdJobs.objectClass, cursor: storageColdJobs.cursor })
			.from(storageColdJobs)
			.where(inArray(storageColdJobs.status, ["queued", "running"])),
	);
	for (const job of activeJobs) {
		try {
			if (parseColdCursor(job.cursor).rule.target === id) return job.objectClass;
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * Why a storage migration's old copies on `storeId` may not be deleted yet: an enabled cold rule archives into
 * that store, or a sweep still in flight does, and the purge would delete what it puts there (round-10 review,
 * `B7`); null otherwise. The purge also takes each key's location lease, so this is the first of two fences.
 */
export async function coldUseBlockingPurge(env: ColdEnv, storeId: string): Promise<string | null> {
	const [rule] = await rowsOrNone(() =>
		getDb(env)
			.select({ objectClass: storageColdRules.objectClass })
			.from(storageColdRules)
			.where(and(eq(storageColdRules.target, storeId), eq(storageColdRules.enabled, true)))
			.limit(1),
	);
	if (rule)
		return `The cold storage rule for ${classLabel(rule.objectClass)} archives into this store; point it elsewhere or turn it off before deleting the old copies`;
	const sweeping = await activeSweepTargeting(env, storeId);
	if (sweeping)
		return `A cold storage sweep for ${classLabel(sweeping)} is still moving objects into this store; wait for it to finish before deleting the old copies`;
	return null;
}

/** Why `id` cannot be deleted for cold storage's sake, besides leftovers (`coldOrphanCount`): a rule still
 * targets it, an earlier sweep moved objects there, or a sweep still in flight was started while it did (its
 * cursor keeps the rule as it was when the sweep began, so a rule changed or disabled after that would not
 * otherwise show up here); null otherwise. */
export async function coldReferenceBlocking(env: ColdEnv, id: string): Promise<string | null> {
	// Each query answers "nothing" on its own before its table exists, rather than one shared catch skipping
	// every later check (round-10 review, `n3`): between 0097 and 0104 the orphans table is missing while an
	// in-flight sweep can already be moving objects here.
	const [rule] = await rowsOrNone(() =>
		getDb(env)
			.select({ objectClass: storageColdRules.objectClass })
			.from(storageColdRules)
			.where(eq(storageColdRules.target, id))
			.limit(1),
	);
	if (rule) return `A cold storage rule for ${rule.objectClass} still targets this store; change it first`;
	if (await storeHoldsLocatedObjects(env, id))
		return "Objects a cold storage sweep moved here are still on this store; move them back first";
	const sweeping = await activeSweepTargeting(env, id);
	if (sweeping) return `A cold storage sweep for ${sweeping} is still moving objects here; wait for it to finish first`;
	return null;
}

/** How many leftover candidates are currently tracked for `id`, shown next to the store in Admin → Storage; deleting
 * the store waits for them, since forgetting it would leave them behind for good. Zero before the orphans table. */
export async function coldOrphanCount(env: ColdEnv, id: string): Promise<number> {
	return await countOrphanCandidates(env, id);
}

/**
 * Both storage batch kinds a queue consumer may see, so `worker.ts` and `server/index.ts` need only one branch
 * for them instead of two.
 */
export async function processStorageQueueMessage(env: ColdEnv, body: unknown): Promise<boolean> {
	if (isStorageMigrateMessage(body)) {
		await processStorageMigration(env, body);
		return true;
	}
	if (isStorageColdMessage(body)) {
		await processStorageCold(env, body);
		return true;
	}
	return false;
}

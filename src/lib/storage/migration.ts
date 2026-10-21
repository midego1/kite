import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { storageMigrations, storageRoutes } from "@/db/schema/storage";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logger.mjs";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { clearStorageConfigCache } from "./config";
import { DEFAULT_STORE_ID, isRoutableClass } from "./config-utils";
import { getStorage, type StoragePlatformEnv } from "./index";
import {
	ACTIVE_MIGRATION_STATUSES,
	advance,
	AUTO_FINISH_MS,
	COPY_PART_BYTES,
	copyParts,
	initialCursor,
	isLeased,
	isStalled,
	LEASE_MS,
	MAX_BATCH_OBJECTS,
	MULTIPART_COPY_THRESHOLD,
	nextPhase,
	nextSource,
	parseCursor,
	STORAGE_MIGRATE_KIND,
	takeBatch,
	type MigrationCursor,
	type MigrationSource,
	type StorageMigrateMessage,
} from "./migration-utils";
import { callStorageHook } from "./module-hooks";
import { objectClassOf } from "./object-classes-utils";
import type { KiteBucket, ObjectStore, RoutableClass, Storage } from "./types";

const log = createLogger("storage");

/** Consecutive failed batches before a job is marked failed; the cron would otherwise retry it forever. */
const MAX_FAILURES = 5;

export type MigrationEnv = StoragePlatformEnv & Pick<CloudflareEnv, "OUTBOUND_QUEUE">;
type Job = typeof storageMigrations.$inferSelect;
type Item = { id: string; key: string; size: number | null };
type Page = { items: Item[]; exhausted: boolean };
type MigrationState = MigrationCursor & { failures?: number };

async function enqueue(env: MigrationEnv, jobId: string, delaySeconds?: number): Promise<void> {
	const message: StorageMigrateMessage = { kind: STORAGE_MIGRATE_KIND, jobId };
	await env.OUTBOUND_QUEUE.send(message, delaySeconds ? { delaySeconds } : undefined);
}

async function countKeys(env: MigrationEnv, objectClass: RoutableClass, fromStoreId: string): Promise<number> {
	const first = async (sql: string) => Number((await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0);
	if (objectClass === "mail")
		return (
			(await first("SELECT count(*) AS n FROM messages WHERE raw_r2_key IS NOT NULL")) +
			(await first("SELECT count(*) AS n FROM message_attachments"))
		);
	if (objectClass === "backups")
		return first("SELECT count(*) AS n FROM backups WHERE r2_key IS NOT NULL AND status = 'completed'");
	return (await callStorageHook<{ count: number }>("drive", "countOnStore", { storeId: fromStoreId }))?.count ?? 0;
}

/** Inserts a queued job and sends its first message. */
export async function queueStorageMigration(
	env: MigrationEnv,
	input: { objectClass: RoutableClass; fromStoreId: string; toStoreId: string; createdByUserId: string | null },
): Promise<string> {
	const id = newId("smg");
	await getDb(env)
		.insert(storageMigrations)
		.values({
			id,
			objectClass: input.objectClass,
			fromStoreId: input.fromStoreId,
			toStoreId: input.toStoreId,
			status: "queued",
			cursor: JSON.stringify(initialCursor(input.objectClass)),
			objectsTotal: await countKeys(env, input.objectClass, input.fromStoreId),
			createdByUserId: input.createdByUserId,
		});
	await enqueue(env, id);
	return id;
}

async function d1Page(env: MigrationEnv, source: MigrationSource, after: string | null): Promise<Page> {
	const queries: Record<Exclude<MigrationSource, "drive">, string> = {
		messages: "SELECT id, raw_r2_key AS key, NULL AS size FROM messages WHERE raw_r2_key IS NOT NULL AND id > ?",
		attachments: "SELECT id, r2_key AS key, size FROM message_attachments WHERE id > ?",
		backups: "SELECT id, r2_key AS key, size FROM backups WHERE r2_key IS NOT NULL AND status = 'completed' AND id > ?",
	};
	const sql = `${queries[source as Exclude<MigrationSource, "drive">]} ORDER BY id LIMIT ?`;
	const { results } = await env.DB.prepare(sql)
		.bind(after ?? "", MAX_BATCH_OBJECTS)
		.all<Item>();
	return { items: results ?? [], exhausted: (results ?? []).length < MAX_BATCH_OBJECTS };
}

/** Which store Drive lists in each pass: the source to copy, the target to verify or purge, then leftovers. */
function driveStoreFor(job: Job, cursor: MigrationCursor): string {
	if (cursor.phase === "copy") return job.fromStoreId;
	if (cursor.phase === "verify" && cursor.driveLeftovers) return job.fromStoreId;
	return job.toStoreId;
}

async function drivePage(job: Job, cursor: MigrationCursor, after: string | null): Promise<Page> {
	const page = await callStorageHook<{ objects: { id: string; key: string; size: number }[]; cursor: string | null }>(
		"drive",
		"listObjectKeys",
		{ storeId: driveStoreFor(job, cursor), cursor: after, limit: MAX_BATCH_OBJECTS },
	);
	return { items: page?.objects ?? [], exhausted: !page?.cursor };
}

function sized(body: ReadableStream, size: number): ReadableStream {
	const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream }).FixedLengthStream;
	return Fixed ? body.pipeThrough(new Fixed(size)) : body;
}

/**
 * S3 stores take a stream only with its length; the R2 binding learns it from the FixedLengthStream instead and
 * is not given an option it does not define.
 */
function lengthOption(target: ObjectStore, length: number) {
	return (target.id === DEFAULT_STORE_ID ? {} : { contentLength: length }) as R2UploadPartOptions & R2PutOptions;
}

/** Copies one object with its metadata; large objects go part by part with ranged reads. */
async function copyObject(
	source: KiteBucket,
	head: R2Object,
	target: ObjectStore,
	key: string,
): Promise<number | null> {
	const metadata = { httpMetadata: head.httpMetadata, customMetadata: head.customMetadata };
	if (head.size > MULTIPART_COPY_THRESHOLD && target.bucket.createMultipartUpload) {
		const upload = await target.bucket.createMultipartUpload(key, metadata);
		try {
			const parts = [];
			for (const part of copyParts(head.size, COPY_PART_BYTES)) {
				const range = await source.get(key, { range: { offset: part.offset, length: part.length } });
				if (!range?.body) throw new Error("The source object changed during the copy");
				parts.push(
					await upload.uploadPart(part.partNumber, sized(range.body, part.length), lengthOption(target, part.length)),
				);
			}
			await upload.complete(parts);
		} catch (error) {
			await upload.abort().catch(() => undefined);
			throw error;
		}
		return head.size;
	}
	const object = await source.get(key);
	if (!object) return null;
	const body = object.size === 0 ? new Uint8Array(0) : sized(object.body, object.size);
	await target.bucket.put(key, body, { ...metadata, ...lengthOption(target, object.size) });
	return object.size;
}

type BatchResult = { processed: number; bytes: number; errors: number; lastError: string | null; moved: string[] };

function describeError(error: unknown): string {
	return (error instanceof Error ? error.message : "Unknown error").slice(0, 300);
}

/** The first store that holds the key: the old store, then the default store for objects that never moved. */
async function findSource(sources: ObjectStore[], key: string): Promise<{ store: ObjectStore; head: R2Object } | null> {
	for (const store of sources) {
		const head = await store.bucket.head(key);
		if (head) return { store, head };
	}
	return null;
}

/**
 * Copy, verify or purge one batch. Sizes are compared between the two stores' HEADs rather than D1, which records
 * decoded sizes for some objects. An object already complete on the target is never copied again.
 */
async function runItems(storage: Storage, job: Job, cursor: MigrationCursor, items: Item[]): Promise<BatchResult> {
	const from = storage.store(job.fromStoreId);
	const to = storage.store(job.toStoreId);
	if (!from || !to) throw new Error("A store of this migration is missing or blocked");
	const sources = [...new Set([from, storage.store(DEFAULT_STORE_ID)!])];
	const result: BatchResult = { processed: 0, bytes: 0, errors: 0, lastError: null, moved: [] };
	for (const item of items) {
		result.processed += 1;
		if (objectClassOf(item.key) !== job.objectClass) continue;
		try {
			const present = await to.bucket.head(item.key);
			if (cursor.phase === "purge") {
				const old = await from.bucket.head(item.key);
				if (!old) continue;
				if (!present || present.size !== old.size)
					throw new Error("Not complete on the new store; kept on the old one");
				await from.bucket.delete(item.key);
				continue;
			}
			const source = await findSource(sources, item.key);
			if (!source && !present) throw new Error("An object named in the database is missing from both stores");
			if (source && (!present || present.size !== source.head.size)) {
				const copied = await copyObject(source.store.bucket, source.head, to, item.key);
				if (copied === null) throw new Error("The object disappeared from the old store during the copy");
				result.bytes += copied;
			}
			result.moved.push(item.id);
		} catch (error) {
			result.errors += 1;
			result.lastError = describeError(error);
		}
	}
	return result;
}

/** Takes the job for one batch by swapping its cursor; false when another delivery holds it. */
async function claim(env: MigrationEnv, job: Job, state: MigrationState, now: number): Promise<MigrationState | null> {
	if (isLeased(state, now)) return null;
	const claimed: MigrationState = { ...state, leaseUntil: now + LEASE_MS };
	const result = await env.DB.prepare(
		`UPDATE storage_migrations SET cursor = ?, status = CASE WHEN status = 'queued' THEN 'copying' ELSE status END,
		 started_at = coalesce(started_at, ?) WHERE id = ? AND coalesce(cursor, '') = ?`,
	)
		.bind(JSON.stringify(claimed), Math.floor(now / 1000), job.id, job.cursor ?? "")
		.run();
	return (result.meta?.changes ?? 0) > 0 ? claimed : null;
}

type BatchOutcome = {
	next: MigrationState;
	processed: number;
	bytes: number;
	errors: number;
	lastError: string | null;
};

/** One page of one source: run the items, record Drive moves, and move the cursor past them. */
async function runSource(
	env: MigrationEnv,
	job: Job,
	state: MigrationState,
	source: MigrationSource,
): Promise<BatchOutcome> {
	const after = state.sources[source] ?? null;
	const page = source === "drive" ? await drivePage(job, state, after) : await d1Page(env, source, after);
	const batch = takeBatch(page.items);
	const result = await runItems(await getStorage(env), job, state, batch);
	const fromSource = state.phase !== "purge" && driveStoreFor(job, state) === job.fromStoreId;
	if (source === "drive" && fromSource && result.moved.length)
		await callStorageHook("drive", "markMoved", {
			ids: result.moved,
			fromStoreId: job.fromStoreId,
			toStoreId: job.toStoreId,
		});
	const exhausted = page.exhausted && batch.length === page.items.length;
	let next: MigrationState = advance(state, source, batch.at(-1)?.id ?? after, exhausted);
	// Drive's verify pass lists the target first, then whatever still names the source.
	if (source === "drive" && state.phase === "verify" && exhausted && !state.driveLeftovers)
		next = { ...next, driveLeftovers: true, sources: { ...next.sources, drive: null } };
	return {
		next,
		processed: state.phase === "copy" ? result.processed : 0,
		bytes: result.bytes,
		errors: result.errors,
		lastError: result.lastError,
	};
}

const PHASE_STATUS: Partial<Record<MigrationCursor["phase"], Job["status"]>> = {
	copy: "copying",
	verify: "verifying",
	done: "completed",
};

async function processBatch(env: MigrationEnv, job: Job, state: MigrationState): Promise<{ again: boolean }> {
	const source = nextSource(state, job.objectClass);
	const { next, processed, bytes, errors, lastError }: BatchOutcome = source
		? await runSource(env, job, state, source)
		: { next: nextPhase(state, job.objectClass), processed: 0, bytes: 0, errors: 0, lastError: null };
	const status = PHASE_STATUS[next.phase] ?? job.status;
	const final = next.phase === "done" || next.phase === "purged";
	const now = Date.now();
	await env.DB.prepare(
		`UPDATE storage_migrations SET cursor = ?, status = ?, objects_done = objects_done + ?, bytes_done = bytes_done + ?,
		 errors = errors + ?, last_error = coalesce(?, last_error), finished_at = CASE WHEN ? THEN ? ELSE finished_at END
		 WHERE id = ? AND status NOT IN ('cancelled', 'failed')`,
	)
		.bind(
			JSON.stringify({ ...next, leaseUntil: undefined, lastBatchAt: now, failures: 0 }),
			status,
			processed,
			bytes,
			errors,
			lastError,
			next.phase === "done" ? 1 : 0,
			Math.floor(now / 1000),
			job.id,
		)
		.run();
	if (lastError) log.warn("storage.migration_errors", { jobId: job.id, errors, phase: state.phase });
	return { again: !final };
}

async function loadJob(env: MigrationEnv, jobId: string): Promise<Job | null> {
	const [job] = await getDb(env).select().from(storageMigrations).where(eq(storageMigrations.id, jobId)).limit(1);
	return job ?? null;
}

function isRunnable(job: Job, state: MigrationCursor): boolean {
	if (job.status === "cancelled" || job.status === "failed") return false;
	if (job.status === "completed") return state.phase === "purge";
	return true;
}

/** The `storage.migrate` queue message: one batch, then the next message. Never throws, so the queue never retries it. */
export async function processStorageMigration(env: MigrationEnv, message: StorageMigrateMessage): Promise<void> {
	const job = await loadJob(env, message.jobId);
	if (!job || !isRoutableClass(job.objectClass)) return;
	const state = parseCursor(job.cursor, job.objectClass) as MigrationState;
	if (!isRunnable(job, state)) return;
	const claimed = await claim(env, job, state, Date.now());
	if (!claimed) return;
	try {
		const { again } = await processBatch(env, { ...job, cursor: JSON.stringify(claimed) }, claimed);
		if (again) await enqueue(env, job.id);
	} catch (error) {
		const failures = (state.failures ?? 0) + 1;
		const failed = failures >= MAX_FAILURES;
		log.error("storage.migration_batch_failed", { jobId: job.id, failures, error });
		await env.DB.prepare(
			"UPDATE storage_migrations SET cursor = ?, last_error = ?, status = CASE WHEN ? THEN 'failed' ELSE status END WHERE id = ?",
		)
			.bind(
				JSON.stringify({ ...state, leaseUntil: undefined, lastBatchAt: Date.now(), failures }),
				describeError(error),
				failed ? 1 : 0,
				job.id,
			)
			.run();
		if (!failed) await enqueue(env, job.id, 60);
	}
}

/**
 * The 5-minute cron: re-sends running jobs that stopped (a lost message, a deploy), and finishes migrations
 * completed more than 7 days ago by dropping the old store from the read chain.
 */
export async function runStorageMigrationMaintenance(env: MigrationEnv, now = new Date()): Promise<void> {
	let jobs: Job[];
	try {
		jobs = await getDb(env)
			.select()
			.from(storageMigrations)
			.where(inArray(storageMigrations.status, [...ACTIVE_MIGRATION_STATUSES, "completed"]));
	} catch (error) {
		if (isNoSuchTableError(error)) return;
		throw error;
	}
	for (const job of jobs) {
		if (!isRoutableClass(job.objectClass)) continue;
		const state = parseCursor(job.cursor, job.objectClass);
		if (job.status === "completed") {
			if (state.phase === "purge" && isStalled(state, now.getTime(), job.finishedAt?.getTime() ?? null))
				await enqueue(env, job.id);
			else if (job.finishedAt && now.getTime() - job.finishedAt.getTime() >= AUTO_FINISH_MS)
				await clearPrevious(env, job);
			continue;
		}
		if (isStalled(state, now.getTime(), job.startedAt?.getTime() ?? job.createdAt.getTime()))
			await enqueue(env, job.id);
	}
}

/** Drops the old store from the read chain, if the route still names it. */
async function clearPrevious(env: MigrationEnv, job: Job): Promise<boolean> {
	const result = await getDb(env)
		.update(storageRoutes)
		.set({ previousStoreId: null, updatedAt: new Date() })
		.where(
			and(
				eq(storageRoutes.objectClass, job.objectClass),
				eq(storageRoutes.storeId, job.toStoreId),
				eq(storageRoutes.previousStoreId, job.fromStoreId),
			),
		);
	clearStorageConfigCache();
	return (result.meta.changes ?? 0) > 0;
}

/** @public Exercised by the unit tests. */
export async function getStorageMigration(env: MigrationEnv, id: string): Promise<Job | null> {
	return loadJob(env, id);
}

/** The newest jobs, one active or recent per class first. */
export async function listStorageMigrations(env: MigrationEnv, limit = 10): Promise<Job[]> {
	try {
		return await getDb(env).select().from(storageMigrations).orderBy(desc(storageMigrations.createdAt)).limit(limit);
	} catch (error) {
		if (isNoSuchTableError(error)) return [];
		throw error;
	}
}

export async function activeMigrationFor(env: MigrationEnv, objectClass: RoutableClass): Promise<Job | null> {
	const [job] = await getDb(env)
		.select()
		.from(storageMigrations)
		.where(
			and(
				eq(storageMigrations.objectClass, objectClass),
				inArray(storageMigrations.status, [...ACTIVE_MIGRATION_STATUSES]),
			),
		)
		.limit(1);
	return job ?? null;
}

export type MigrationAction = "cancel" | "finish" | "purge-source" | "retry";
export type MigrationActionResult = { ok: true; job: Job } | { ok: false; status: number; error: string };

/** Cancel stops after the current batch; finish drops the old store from the read chain; retry restarts a failed job. */
export async function actOnStorageMigration(
	env: MigrationEnv,
	job: Job,
	action: Exclude<MigrationAction, "purge-source">,
): Promise<MigrationActionResult> {
	const db = getDb(env);
	if (action === "cancel") {
		if (!ACTIVE_MIGRATION_STATUSES.includes(job.status as (typeof ACTIVE_MIGRATION_STATUSES)[number]))
			return { ok: false, status: 409, error: "Only a running migration can be cancelled" };
		await db
			.update(storageMigrations)
			.set({ status: "cancelled", finishedAt: new Date() })
			.where(eq(storageMigrations.id, job.id));
	} else if (action === "finish") {
		if (job.status !== "completed")
			return { ok: false, status: 409, error: "Finish is available once the migration has completed" };
		await clearPrevious(env, job);
	} else {
		if (job.status !== "failed") return { ok: false, status: 409, error: "Only a failed migration can be retried" };
		const state = parseCursor(job.cursor, job.objectClass as RoutableClass);
		const status = state.phase === "purge" ? "completed" : state.phase === "verify" ? "verifying" : "copying";
		await db
			.update(storageMigrations)
			.set({ status, cursor: JSON.stringify({ ...state, failures: 0, leaseUntil: undefined }) })
			.where(eq(storageMigrations.id, job.id));
		await enqueue(env, job.id);
	}
	return { ok: true, job: (await loadJob(env, job.id))! };
}

/**
 * Deletes the old copies, each only after its object is confirmed on the new store. The route stops reading
 * the old store first, so nothing reads an object while it is deleted.
 */
export async function startStorageMigrationPurge(env: MigrationEnv, job: Job): Promise<MigrationActionResult> {
	if (job.status !== "completed")
		return { ok: false, status: 409, error: "Delete from the old store once the migration has completed" };
	const state = parseCursor(job.cursor, job.objectClass as RoutableClass);
	if (state.phase === "purge") return { ok: false, status: 409, error: "The old copies are already being deleted" };
	await clearPrevious(env, job);
	await getDb(env)
		.update(storageMigrations)
		.set({ cursor: JSON.stringify(initialCursor(job.objectClass as RoutableClass, "purge")), lastError: null })
		.where(eq(storageMigrations.id, job.id));
	await enqueue(env, job.id);
	return { ok: true, job: (await loadJob(env, job.id))! };
}

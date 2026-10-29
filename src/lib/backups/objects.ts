import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { backups } from "@/db/schema/backups";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { selectRow } from "@/lib/db/pending-columns";
import { createLogger } from "@/lib/logger.mjs";
import { getStorage } from "@/lib/storage";
import { copyObject, findSource } from "@/lib/storage/migration";
import type { Storage } from "@/lib/storage/types";
import type {
	BackupObjectsCopyMessage,
	BackupObjectsCopyRun,
	BackupObjectsDeleteMessage,
	BackupObjectsEstimate,
	BackupObjectsManifest,
	BackupObjectsManifestPart,
	BackupObjectsMessage,
	BackupObjectsRestoreMessage,
	BackupObjectsRestoreResult,
	BackupObjectsRestoreRun,
	BackupObjectsRun,
} from "./objects-types";
import {
	advanceCopyRun,
	backupObjectCopyKey,
	backupObjectsManifestKey,
	backupObjectsManifestPartKey,
	backupObjectsPrefix,
	estimateBackupObjectBytes,
	initialCopyRun,
	OBJECTS_BATCH_BYTES,
	OBJECTS_BATCH_SIZE,
	OBJECTS_DELETE_BATCH,
	OBJECTS_LEASE_MS,
	objectsStepAction,
	parseBackupObjectsManifestPart,
	parseObjectsRun,
} from "./objects-utils";

const log = createLogger("backups");

/** Offloaded HTML bodies (`src/lib/email/bodies.ts`) exist from migration 0074. */
const BODY_KEY_COLUMN = "html_body_key";
/** Messages the size estimate reads to stand for all of them. */
const ESTIMATE_SAMPLE = 500;

async function beforeBodyColumn<T>(query: () => Promise<T>, whenPending: () => Promise<T>): Promise<T> {
	try {
		return await query();
	} catch (error) {
		if (missingColumnFromError(error) === BODY_KEY_COLUMN) return whenPending();
		throw error;
	}
}

const SOURCE_QUERIES = {
	messages: "SELECT id, raw_r2_key AS key FROM messages WHERE raw_r2_key IS NOT NULL AND id > ?",
	attachments: "SELECT id, r2_key AS key FROM message_attachments WHERE id > ?",
	// A body's key is always its own (`htmlBodyObjectKey`), whatever the column holds.
	bodies: `SELECT id, 'bodies/' || id || '.html' AS key FROM messages WHERE ${BODY_KEY_COLUMN} IS NOT NULL AND id > ?`,
};

type Sample = { size: number; bodyBytes: number; offloaded: number; offloadedBytes: number };
const SAMPLE_BODIES =
	"count(*) AS size, coalesce(sum(length(CAST(coalesce(text_body, '') AS BLOB)) + length(CAST(coalesce(html_body, '') AS BLOB))), 0) AS bodyBytes";

/**
 * About how much a full backup copies, for Admin → Backups. It reads only counts, the attachment sizes and the
 * latest messages as a sample, never every body, and the page asks for it only when it is shown.
 */
export async function estimateBackupObjects(env: CloudflareEnv): Promise<BackupObjectsEstimate> {
	const first = async <T>(sql: string) => (await env.DB.prepare(sql).first<T>()) ?? ({} as T);
	const latest = `FROM messages WHERE raw_r2_key IS NOT NULL ORDER BY rowid DESC LIMIT ${ESTIMATE_SAMPLE}`;
	const messages = await first<{ n: number }>("SELECT count(*) AS n FROM messages WHERE raw_r2_key IS NOT NULL");
	const attachments = await first<{ n: number; bytes: number }>(
		"SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM message_attachments",
	);
	const sample = await beforeBodyColumn(
		() =>
			first<Sample>(
				`SELECT ${SAMPLE_BODIES}, coalesce(sum(${BODY_KEY_COLUMN} IS NOT NULL), 0) AS offloaded, coalesce(sum(CASE WHEN ${BODY_KEY_COLUMN} IS NOT NULL THEN body_size ELSE 0 END), 0) AS offloadedBytes FROM (SELECT text_body, html_body, ${BODY_KEY_COLUMN}, body_size ${latest})`,
			),
		async () => ({
			...(await first<Sample>(`SELECT ${SAMPLE_BODIES} FROM (SELECT text_body, html_body ${latest})`)),
			offloaded: 0,
			offloadedBytes: 0,
		}),
	);
	return estimateBackupObjectBytes({
		messages: Number(messages.n ?? 0),
		sample: {
			size: Number(sample.size ?? 0),
			bodyBytes: Number(sample.bodyBytes ?? 0),
			offloaded: Number(sample.offloaded ?? 0),
			offloadedBytes: Number(sample.offloadedBytes ?? 0),
		},
		attachments: Number(attachments.n ?? 0),
		attachmentBytes: Number(attachments.bytes ?? 0),
	});
}

async function enqueue(env: CloudflareEnv, message: BackupObjectsMessage, delaySeconds?: number): Promise<void> {
	await env.OUTBOUND_QUEUE.send(message, delaySeconds ? { delaySeconds } : undefined);
}

/** Runs an UPDATE and answers how many rows it changed, for the compare-and-set steps below. */
async function changed(env: CloudflareEnv, sql: string, ...params: (string | number | null)[]): Promise<number> {
	const result = await env.DB.prepare(sql)
		.bind(...params)
		.run();
	return Number(result.meta?.changes ?? 0);
}

const seconds = (ms: number) => Math.floor(ms / 1000);

/** Starts copying the mail objects of a backup whose database export just finished. */
export async function startBackupObjectsCopy(env: CloudflareEnv, backupId: string, startedAt: Date): Promise<void> {
	const run = initialCopyRun(1);
	await getDb(env)
		.update(backups)
		.set({
			objectsStatus: "copying",
			objectsPrefix: backupObjectsPrefix(backupId, startedAt),
			objectsCount: 0,
			objectsSize: 0,
			objectsMissing: 0,
			objectsFailed: 0,
			objectsCursor: JSON.stringify(run),
			objectsUpdatedAt: new Date(),
		})
		.where(eq(backups.id, backupId));
	await enqueue(env, { kind: "backup.objects.copy", backupId, step: run.step });
}

/** After the export: a failure to start the copy fails only the copy, never the database backup. */
export async function markBackupObjectsCopyFailed(env: CloudflareEnv, backupId: string): Promise<void> {
	await changed(env, "UPDATE backups SET objects_status = 'failed' WHERE id = ?", backupId);
}

async function loadBackup(env: CloudflareEnv, backupId: string) {
	return selectRow(getDb(env), backups, eq(backups.id, backupId));
}

type Backup = NonNullable<Awaited<ReturnType<typeof loadBackup>>>;

/**
 * Takes the step for this delivery by writing its lease over the exact state it read, so two deliveries of one
 * step never run together. A delivery that finds the step held comes back once the lease runs out (the holder may
 * have died); one for a step already done is dropped.
 */
async function claimStep<T extends BackupObjectsRun>(
	env: CloudflareEnv,
	backup: Backup,
	message: BackupObjectsCopyMessage | BackupObjectsRestoreMessage,
	expected: { run: T["run"]; status: "copying" | "restoring" },
): Promise<T | null> {
	if (backup.objectsStatus !== expected.status) return null;
	const run = parseObjectsRun(backup.objectsCursor);
	const now = Date.now();
	const action = objectsStepAction(run, expected.run, message.step, now);
	if (action === "done") return null;
	if (action === "leased") {
		await enqueue(env, message, Math.max(30, seconds(run!.leaseUntil! - now) + 5));
		return null;
	}
	const claimed = { ...run!, leaseUntil: now + OBJECTS_LEASE_MS } as T;
	const taken = await changed(
		env,
		"UPDATE backups SET objects_cursor = ?, objects_updated_at = ? WHERE id = ? AND objects_status = ? AND objects_cursor = ?",
		JSON.stringify(claimed),
		seconds(now),
		backup.id,
		expected.status,
		backup.objectsCursor,
	);
	return taken ? claimed : null;
}

async function readPage(
	env: CloudflareEnv,
	run: BackupObjectsCopyRun,
): Promise<{ items: { id: string; key: string }[]; exhausted: boolean }> {
	const query = async () =>
		(
			await env.DB.prepare(`${SOURCE_QUERIES[run.source]} ORDER BY id LIMIT ?`)
				.bind(run.after ?? "", OBJECTS_BATCH_SIZE)
				.all<{ id: string; key: string }>()
		).results ?? [];
	const results = await beforeBodyColumn(query, async () => []);
	return { items: results, exhausted: results.length < OBJECTS_BATCH_SIZE };
}

async function putJson(env: CloudflareEnv, key: string, value: unknown): Promise<void> {
	await env.BUCKET.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

/**
 * Copies one batch. An object already copied with the same size (a resumed or repeated batch) is not copied again,
 * a key named twice is copied once, and an object that cannot be read or written is recorded as failed while the
 * rest of the batch goes on.
 */
async function copyBatch(storage: Storage, prefix: string, items: { id: string; key: string }[]) {
	const sources = storage.readChain("mail");
	const part: BackupObjectsManifestPart = { objects: [], missing: [], failed: [] };
	const seen = new Set<string>();
	let bytes = 0;
	let lastId: string | null = null;
	for (const item of items) {
		if (bytes >= OBJECTS_BATCH_BYTES) break;
		lastId = item.id;
		if (seen.has(item.key)) continue;
		seen.add(item.key);
		try {
			const source = await findSource(sources, item.key);
			const copyKey = backupObjectCopyKey(prefix, item.key);
			const target = storage.storeForKey(copyKey);
			const existing = source ? await target.bucket.head(copyKey) : null;
			const size = !source
				? null
				: existing && existing.size === source.head.size
					? existing.size
					: await copyObject(source.store.bucket, source.head, target, item.key, copyKey);
			if (size === null) part.missing.push(item.key);
			else {
				part.objects.push({ key: item.key, size });
				bytes += size;
			}
		} catch (error) {
			part.failed.push(item.key);
			log.warn("backup.object_copy_failed", { prefix, error });
		}
	}
	return { part, bytes, lastId };
}

/** One step of a copy: a batch of objects from the Mail store, then the next step or the manifest. */
async function processCopy(env: CloudflareEnv, message: BackupObjectsCopyMessage): Promise<void> {
	const backup = await loadBackup(env, message.backupId);
	if (!backup?.objectsPrefix) return;
	const run = await claimStep<BackupObjectsCopyRun>(env, backup, message, { run: "copy", status: "copying" });
	if (!run) return;
	const prefix = backup.objectsPrefix;
	const page = await readPage(env, run);
	const { part, bytes, lastId } = await copyBatch(await getStorage(env), prefix, page.items);
	const handled = part.objects.length + part.missing.length + part.failed.length;
	if (handled) await putJson(env, backupObjectsManifestPartKey(prefix, run.part), part);
	const { next, done } = advanceCopyRun(run, {
		lastId,
		exhausted: page.exhausted && lastId === (page.items.at(-1)?.id ?? null),
		copied: part.objects.length,
		bytes,
		missing: part.missing.length,
		failed: part.failed.length,
	});
	if (done) {
		const manifest: BackupObjectsManifest = {
			format: "kite-backup-objects",
			version: 1,
			backupId: backup.id,
			database: backup.r2Key,
			completedAt: new Date().toISOString(),
			parts: next.part - 1,
			objects: next.count,
			bytes: next.size,
			missing: next.missing,
			failed: next.failed,
		};
		await putJson(env, backupObjectsManifestKey(prefix), manifest);
	}
	const saved = await changed(
		env,
		`UPDATE backups SET objects_cursor = ?, objects_status = ?, objects_count = ?, objects_size = ?, objects_missing = ?,
		 objects_failed = ?, objects_updated_at = ? WHERE id = ? AND objects_cursor = ?`,
		JSON.stringify(next),
		done ? "completed" : "copying",
		next.count,
		next.size,
		next.missing,
		next.failed,
		seconds(Date.now()),
		backup.id,
		JSON.stringify(run),
	);
	if (saved && !done) await enqueue(env, { kind: "backup.objects.copy", backupId: backup.id, step: next.step });
	if (saved && done && (next.missing || next.failed))
		log.warn("backup.objects_incomplete", { backupId: backup.id, missing: next.missing, failed: next.failed });
}

async function readJson(env: CloudflareEnv, key: string): Promise<unknown> {
	const object = await env.BUCKET.get(key);
	if (!object) return null;
	return JSON.parse(await object.text());
}

/**
 * Copies a failed copy again: from where it stopped, or from the start when it finished with objects it could not
 * copy (those already copied are only checked). Returns false when there is nothing to retry or someone else just
 * changed the backup.
 */
export async function retryBackupObjectsCopy(env: CloudflareEnv, backupId: string): Promise<boolean> {
	const backup = await loadBackup(env, backupId);
	if (!backup?.objectsPrefix) return false;
	const run = parseObjectsRun(backup.objectsCursor);
	const step = (run?.step ?? 0) + 1;
	let next: BackupObjectsCopyRun;
	if (backup.objectsStatus === "failed")
		next = run?.run === "copy" ? { ...run, step, leaseUntil: undefined } : initialCopyRun(step);
	else if (backup.objectsStatus === "completed" && (backup.objectsFailed ?? 0) > 0) next = initialCopyRun(step);
	else return false;
	const taken = await changed(
		env,
		`UPDATE backups SET objects_status = 'copying', objects_cursor = ?, objects_count = ?, objects_size = ?,
		 objects_missing = ?, objects_failed = ?, objects_updated_at = ?, error = NULL
		 WHERE id = ? AND objects_status = ? AND coalesce(objects_cursor, '') = ?`,
		JSON.stringify(next),
		next.count,
		next.size,
		next.missing,
		next.failed,
		seconds(Date.now()),
		backupId,
		backup.objectsStatus,
		backup.objectsCursor ?? "",
	);
	if (taken) await enqueue(env, { kind: "backup.objects.copy", backupId, step });
	return taken > 0;
}

/**
 * Starts putting a full backup's mail objects back. Objects that exist are never overwritten, so this is safe to run
 * on a live install: after restoring the database it brings back the files the restored messages name. Answers
 * "busy" when the files are already being copied or restored (a second click, or another admin).
 */
export async function startBackupObjectsRestore(
	env: CloudflareEnv,
	backupId: string,
): Promise<"started" | "busy" | "none"> {
	const backup = await loadBackup(env, backupId);
	if (!backup?.objectsPrefix || !backup.objectsStatus || backup.objectsStatus === "failed") return "none";
	if (backup.objectsStatus !== "completed") return "busy";
	const manifest = (await readJson(
		env,
		backupObjectsManifestKey(backup.objectsPrefix),
	)) as BackupObjectsManifest | null;
	if (manifest?.format !== "kite-backup-objects") throw new Error("The mail files of this backup could not be found");
	const run: BackupObjectsRestoreRun = {
		run: "restore",
		step: (parseObjectsRun(backup.objectsCursor)?.step ?? 0) + 1,
		part: 1,
		restored: 0,
		present: 0,
		failed: 0,
	};
	const taken = await changed(
		env,
		`UPDATE backups SET objects_status = 'restoring', objects_cursor = ?, objects_updated_at = ?
		 WHERE id = ? AND objects_status = 'completed' AND coalesce(objects_cursor, '') = ?`,
		JSON.stringify(run),
		seconds(Date.now()),
		backupId,
		backup.objectsCursor ?? "",
	);
	if (!taken) return "busy";
	await enqueue(env, { kind: "backup.objects.restore", backupId, step: run.step });
	return "started";
}

async function restoreObject(
	env: CloudflareEnv,
	storage: Storage,
	prefix: string,
	key: string,
): Promise<"restored" | "present" | "failed"> {
	if (await env.BUCKET.head(key)) return "present";
	const copyKey = backupObjectCopyKey(prefix, key);
	const source = await findSource(storage.readChain("backups"), copyKey);
	if (!source) return "failed";
	const copied = await copyObject(source.store.bucket, source.head, storage.storeForKey(key), copyKey, key);
	return copied === null ? "failed" : "restored";
}

/** One step of a restore: one manifest part, then the next step or the result. */
async function processRestore(env: CloudflareEnv, message: BackupObjectsRestoreMessage): Promise<void> {
	const backup = await loadBackup(env, message.backupId);
	if (!backup?.objectsPrefix) return;
	const run = await claimStep<BackupObjectsRestoreRun>(env, backup, message, { run: "restore", status: "restoring" });
	if (!run) return;
	const prefix = backup.objectsPrefix;
	const manifest = (await readJson(env, backupObjectsManifestKey(prefix))) as BackupObjectsManifest | null;
	const parts = manifest?.parts ?? 0;
	const tally = { restored: run.restored, present: run.present, failed: run.failed };
	if (run.part <= parts) {
		const part = parseBackupObjectsManifestPart(await readJson(env, backupObjectsManifestPartKey(prefix, run.part)));
		tally.failed += part.skipped;
		const storage = await getStorage(env);
		for (const object of part.objects) {
			try {
				tally[await restoreObject(env, storage, prefix, object.key)] += 1;
			} catch (error) {
				tally.failed += 1;
				log.warn("backup.object_restore_failed", { backupId: backup.id, error });
			}
		}
	}
	const next: BackupObjectsRestoreRun = {
		...run,
		...tally,
		leaseUntil: undefined,
		step: run.step + 1,
		part: run.part + 1,
	};
	const done = next.part > parts;
	const result: BackupObjectsRestoreResult = { ...tally, finishedAt: new Date().toISOString() };
	const saved = await changed(
		env,
		`UPDATE backups SET objects_cursor = ?, objects_status = ?, objects_restore = coalesce(?, objects_restore),
		 objects_updated_at = ? WHERE id = ? AND objects_cursor = ?`,
		JSON.stringify(next),
		done ? "completed" : "restoring",
		done ? JSON.stringify(result) : null,
		seconds(Date.now()),
		backup.id,
		JSON.stringify(run),
	);
	if (saved && !done) await enqueue(env, { kind: "backup.objects.restore", backupId: backup.id, step: next.step });
	if (saved && done) log.info("backup.objects_restored", { backupId: backup.id, ...tally });
}

/**
 * Deletes a backup's object copies a thousand at a time from every store the Backups class may hold them in (the
 * active one, the previous one while a move is pending, and the default), re-queueing itself until none is left.
 */
async function processDelete(env: CloudflareEnv, message: BackupObjectsDeleteMessage): Promise<void> {
	let more = false;
	for (const store of (await getStorage(env)).deleteTargets("backups")) {
		if (!store.bucket.list) continue;
		const listed = await store.bucket.list({ prefix: message.prefix, limit: OBJECTS_DELETE_BATCH });
		const keys = listed.objects.map((object) => object.key);
		if (keys.length) await store.bucket.delete(keys);
		more ||= listed.truncated;
	}
	if (more) await enqueue(env, message);
}

/** Queues the removal of a deleted backup's object copies; the backup row itself is already gone. */
export async function queueBackupObjectsDelete(env: CloudflareEnv, prefix: string | null): Promise<void> {
	if (prefix) await enqueue(env, { kind: "backup.objects.delete", prefix });
}

export async function processBackupObjectsMessage(env: CloudflareEnv, message: BackupObjectsMessage): Promise<void> {
	if (message.kind === "backup.objects.copy") await processCopy(env, message);
	else if (message.kind === "backup.objects.restore") await processRestore(env, message);
	else await processDelete(env, message);
}

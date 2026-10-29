import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { backups } from "@/db/schema/backups";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { selectRow } from "@/lib/db/pending-columns";
import { createLogger } from "@/lib/logger.mjs";
import { getStorage } from "@/lib/storage";
import { copyObject, findSource } from "@/lib/storage/migration";
import type {
	BackupObjectSource,
	BackupObjectsCopyMessage,
	BackupObjectsCursor,
	BackupObjectsDeleteMessage,
	BackupObjectsEstimate,
	BackupObjectsManifest,
	BackupObjectsManifestPart,
	BackupObjectsMessage,
	BackupObjectsRestoreMessage,
} from "./objects-types";
import {
	advanceBackupObjectsCursor,
	backupObjectCopyKey,
	backupObjectsManifestKey,
	backupObjectsManifestPartKey,
	backupObjectsPrefix,
	estimateBackupObjectBytes,
	initialBackupObjectsCursor,
	OBJECTS_BATCH_BYTES,
	OBJECTS_BATCH_SIZE,
	OBJECTS_DELETE_BATCH,
	parseBackupObjectsManifestPart,
} from "./objects-utils";

const log = createLogger("backups");

/** Offloaded HTML bodies (`src/lib/email/bodies.ts`) exist from migration 0074. */
const BODY_KEY_COLUMN = "html_body_key";

async function beforeBodyColumn<T>(query: () => Promise<T>, whenPending: T): Promise<T> {
	try {
		return await query();
	} catch (error) {
		if (missingColumnFromError(error) === BODY_KEY_COLUMN) return whenPending;
		throw error;
	}
}

const SOURCE_QUERIES: Record<BackupObjectSource, string> = {
	messages: "SELECT id, raw_r2_key AS key FROM messages WHERE raw_r2_key IS NOT NULL AND id > ?",
	attachments: "SELECT id, r2_key AS key FROM message_attachments WHERE id > ?",
	// A body's key is always its own (`htmlBodyObjectKey`), whatever the column holds.
	bodies: `SELECT id, 'bodies/' || id || '.html' AS key FROM messages WHERE ${BODY_KEY_COLUMN} IS NOT NULL AND id > ?`,
};

/** A rough size of what a full backup copies, from the database alone; Admin → Backups shows it before it runs. */
export async function estimateBackupObjects(env: CloudflareEnv): Promise<BackupObjectsEstimate> {
	const first = async <T>(sql: string) => (await env.DB.prepare(sql).first<T>()) ?? ({} as T);
	const messages = await first<{ n: number; bytes: number }>(
		"SELECT count(*) AS n, coalesce(sum(length(CAST(coalesce(text_body, '') AS BLOB)) + length(CAST(coalesce(html_body, '') AS BLOB))), 0) AS bytes FROM messages WHERE raw_r2_key IS NOT NULL",
	);
	const attachments = await first<{ n: number; bytes: number }>(
		"SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM message_attachments",
	);
	const bodies = await beforeBodyColumn(
		() =>
			first<{ n: number; bytes: number }>(
				`SELECT count(*) AS n, coalesce(sum(body_size), 0) AS bytes FROM messages WHERE ${BODY_KEY_COLUMN} IS NOT NULL`,
			),
		{ n: 0, bytes: 0 },
	);
	return estimateBackupObjectBytes({
		messages: Number(messages.n ?? 0),
		bodyBytes: Number(messages.bytes ?? 0),
		attachments: Number(attachments.n ?? 0),
		attachmentBytes: Number(attachments.bytes ?? 0),
		offloadedBodies: Number(bodies.n ?? 0),
		offloadedBodyBytes: Number(bodies.bytes ?? 0),
	});
}

async function enqueue(env: CloudflareEnv, message: BackupObjectsMessage): Promise<void> {
	await env.OUTBOUND_QUEUE.send(message);
}

/** Starts copying the mail objects of a backup whose database export just finished. */
export async function startBackupObjectsCopy(env: CloudflareEnv, backupId: string, startedAt: Date): Promise<void> {
	const prefix = backupObjectsPrefix(backupId, startedAt);
	await getDb(env)
		.update(backups)
		.set({
			objectsStatus: "copying",
			objectsPrefix: prefix,
			objectsCount: 0,
			objectsSize: 0,
			objectsMissing: 0,
			objectsUpdatedAt: new Date(),
		})
		.where(eq(backups.id, backupId));
	await enqueue(env, { kind: "backup.objects.copy", backupId, cursor: initialBackupObjectsCursor() });
}

async function loadBackup(env: CloudflareEnv, backupId: string) {
	return selectRow(getDb(env), backups, eq(backups.id, backupId));
}

async function readPage(
	env: CloudflareEnv,
	cursor: BackupObjectsCursor,
): Promise<{ items: { id: string; key: string }[]; exhausted: boolean }> {
	const results = await beforeBodyColumn(
		async () =>
			(
				await env.DB.prepare(`${SOURCE_QUERIES[cursor.source]} ORDER BY id LIMIT ?`)
					.bind(cursor.after ?? "", OBJECTS_BATCH_SIZE)
					.all<{ id: string; key: string }>()
			).results ?? [],
		[] as { id: string; key: string }[],
	);
	return { items: results, exhausted: results.length < OBJECTS_BATCH_SIZE };
}

async function putJson(env: CloudflareEnv, key: string, value: unknown): Promise<void> {
	await env.BUCKET.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

/** One batch of a copy: up to OBJECTS_BATCH_SIZE objects from the Mail store, then the next message or the manifest. */
async function processCopy(env: CloudflareEnv, message: BackupObjectsCopyMessage): Promise<void> {
	const backup = await loadBackup(env, message.backupId);
	if (!backup?.objectsPrefix || backup.objectsStatus !== "copying") return;
	const prefix = backup.objectsPrefix;
	const { cursor } = message;
	const storage = await getStorage(env);
	const sources = storage.readChain("mail");
	const page = await readPage(env, cursor);
	const part: BackupObjectsManifestPart = { objects: [], missing: [] };
	let bytes = 0;
	let lastId: string | null = null;
	for (const item of page.items) {
		if (bytes >= OBJECTS_BATCH_BYTES) break;
		lastId = item.id;
		const source = await findSource(sources, item.key);
		const copyKey = backupObjectCopyKey(prefix, item.key);
		const copied = source
			? await copyObject(source.store.bucket, source.head, storage.storeForKey(copyKey), item.key, copyKey)
			: null;
		if (copied === null) part.missing.push(item.key);
		else {
			part.objects.push({ key: item.key, size: copied });
			bytes += copied;
		}
	}
	if (part.objects.length || part.missing.length)
		await putJson(env, backupObjectsManifestPartKey(prefix, cursor.part), part);
	const exhausted = page.exhausted && lastId === (page.items.at(-1)?.id ?? null);
	const next = advanceBackupObjectsCursor(cursor, {
		lastId,
		exhausted,
		copied: part.objects.length,
		bytes,
		missing: part.missing.length,
	});
	const totals = next ?? {
		count: cursor.count + part.objects.length,
		size: cursor.size + bytes,
		missing: cursor.missing + part.missing.length,
		part: cursor.part + (part.objects.length || part.missing.length ? 1 : 0),
	};
	if (!next) {
		const manifest: BackupObjectsManifest = {
			format: "kite-backup-objects",
			version: 1,
			backupId: backup.id,
			database: backup.r2Key,
			completedAt: new Date().toISOString(),
			parts: totals.part - 1,
			objects: totals.count,
			bytes: totals.size,
			missing: totals.missing,
		};
		await putJson(env, backupObjectsManifestKey(prefix), manifest);
	}
	await getDb(env)
		.update(backups)
		.set({
			objectsStatus: next ? "copying" : "completed",
			objectsCount: totals.count,
			objectsSize: totals.size,
			objectsMissing: totals.missing,
			objectsUpdatedAt: new Date(),
		})
		.where(and(eq(backups.id, backup.id), eq(backups.objectsStatus, "copying")));
	if (next) await enqueue(env, { ...message, cursor: next });
	else if (totals.missing) log.warn("backup.objects_missing", { backupId: backup.id, missing: totals.missing });
}

async function readJson(env: CloudflareEnv, key: string): Promise<unknown> {
	const object = await env.BUCKET.get(key);
	if (!object) return null;
	return JSON.parse(await object.text());
}

/**
 * Starts putting a full backup's mail objects back. Objects that exist are never overwritten, so this is safe to run
 * on a live install: after restoring the database it brings back the files the restored messages name.
 */
export async function startBackupObjectsRestore(env: CloudflareEnv, backupId: string): Promise<boolean> {
	const backup = await loadBackup(env, backupId);
	if (!backup?.objectsPrefix || backup.objectsStatus !== "completed") return false;
	const manifest = (await readJson(
		env,
		backupObjectsManifestKey(backup.objectsPrefix),
	)) as BackupObjectsManifest | null;
	if (manifest?.format !== "kite-backup-objects") throw new Error("The mail files of this backup could not be found");
	await getDb(env)
		.update(backups)
		.set({ objectsStatus: "restoring", objectsUpdatedAt: new Date() })
		.where(and(eq(backups.id, backupId), eq(backups.objectsStatus, "completed")));
	await enqueue(env, { kind: "backup.objects.restore", backupId, part: 1, restored: 0, present: 0, failed: 0 });
	return true;
}

async function restoreObject(
	env: CloudflareEnv,
	storage: Awaited<ReturnType<typeof getStorage>>,
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

async function processRestore(env: CloudflareEnv, message: BackupObjectsRestoreMessage): Promise<void> {
	const backup = await loadBackup(env, message.backupId);
	if (!backup?.objectsPrefix || backup.objectsStatus !== "restoring") return;
	const prefix = backup.objectsPrefix;
	const manifest = (await readJson(env, backupObjectsManifestKey(prefix))) as BackupObjectsManifest | null;
	const parts = manifest?.parts ?? 0;
	const tally = { restored: message.restored, present: message.present, failed: message.failed };
	if (message.part <= parts) {
		const part = parseBackupObjectsManifestPart(
			await readJson(env, backupObjectsManifestPartKey(prefix, message.part)),
		);
		const storage = await getStorage(env);
		for (const object of part.objects) tally[await restoreObject(env, storage, prefix, object.key)] += 1;
	}
	const done = message.part >= parts;
	await getDb(env)
		.update(backups)
		.set({ objectsStatus: done ? "completed" : "restoring", objectsUpdatedAt: new Date() })
		.where(and(eq(backups.id, backup.id), eq(backups.objectsStatus, "restoring")));
	if (!done) await enqueue(env, { ...message, ...tally, part: message.part + 1 });
	else log.info("backup.objects_restored", { backupId: backup.id, ...tally });
}

/** Deletes a backup's object copies a thousand at a time, re-queueing itself until the prefix is empty. */
async function processDelete(env: CloudflareEnv, message: BackupObjectsDeleteMessage): Promise<void> {
	const listed = await env.BUCKET.list({ prefix: message.prefix, limit: OBJECTS_DELETE_BATCH });
	const keys = listed.objects.map((object) => object.key);
	if (keys.length) await env.BUCKET.delete(keys);
	if (listed.truncated) await enqueue(env, message);
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

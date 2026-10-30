import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { inJsonArray, queryInChunks } from "@/db/chunk-utils";
import { messages } from "@/db/schema";
import { storageMigrations } from "@/db/schema/storage";
import { restoreBlocksMigrations } from "@/lib/backups/restore-job-store";
import { createLogger } from "@/lib/logger.mjs";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { ACTIVE_MIGRATION_STATUSES } from "@/lib/storage/migration-utils";
import {
	dueRawObjects,
	parseRawSweepState,
	queuedRawKeys,
	RAW_SWEEP_LOOKUP_CHUNK,
	RAW_SWEEP_MAX_PAGES,
	RAW_SWEEP_PAGE_SIZE,
	RAW_SWEEP_PREFIX,
	RAW_SWEEP_STATE_KEY,
	type RawSweepObject,
} from "./raw-sweeper-utils";

const logger = createLogger("raw-sweeper");

export type RawSweepResult =
	| { skipped: "storage_migration" | "restore" }
	| { skipped: null; scanned: number; removed: number; after: string | null };

/**
 * A Mail-class storage migration copies objects between stores and lists only one of them; a restore replaces the
 * `messages` rows the reference check reads. Both make an object look unreferenced that is not, so the sweep waits.
 */
async function sweepBlockedBy(env: CloudflareEnv): Promise<"storage_migration" | "restore" | null> {
	try {
		const [running] = await getDb(env)
			.select({ id: storageMigrations.id })
			.from(storageMigrations)
			.where(
				and(
					eq(storageMigrations.objectClass, "mail"),
					inArray(storageMigrations.status, [...ACTIVE_MIGRATION_STATUSES]),
				),
			)
			.limit(1);
		if (running) return "storage_migration";
	} catch (error) {
		// Before migration 0065 there are no storage migrations to wait for.
		if (!isNoSuchTableError(error)) throw error;
	}
	return (await restoreBlocksMigrations(env.BUCKET)) ? "restore" : null;
}

/** The intake objects pending self-hosted queue messages still name (`node_queue_messages`, Node only). */
async function pendingQueueKeys(env: CloudflareEnv): Promise<Set<string>> {
	const table = await env.DB.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_queue_messages'",
	).first();
	if (!table) return new Set();
	const { results } = await env.DB.prepare(
		`SELECT body FROM node_queue_messages WHERE body LIKE '%"rawR2Key"%${RAW_SWEEP_PREFIX}%'`,
	).all<{ body: string }>();
	return new Set(results.flatMap((row) => queuedRawKeys(row.body)));
}

/** The keys among `keys` a stored message still names in `raw_r2_key` (copies in other mailboxes share one). */
async function referencedKeys(env: CloudflareEnv, keys: string[]): Promise<Set<string>> {
	const db = getDb(env);
	const rows = await queryInChunks(
		keys,
		(chunk) =>
			db.selectDistinct({ key: messages.rawR2Key }).from(messages).where(inJsonArray(messages.rawR2Key, chunk)),
		RAW_SWEEP_LOOKUP_CHUNK,
	);
	return new Set(rows.flatMap((row) => (row.key ? [row.key] : [])));
}

async function readPosition(env: CloudflareEnv): Promise<string | null> {
	const object = await env.BUCKET.get(RAW_SWEEP_STATE_KEY);
	return parseRawSweepState(object ? await object.text() : null)?.after ?? null;
}

async function writePosition(env: CloudflareEnv, after: string): Promise<void> {
	await env.BUCKET.put(RAW_SWEEP_STATE_KEY, JSON.stringify({ version: 1, after }), {
		httpMetadata: { contentType: "application/json" },
	});
}

/**
 * The daily safety net behind the early-return cleanup in `processInboundMessage` (Mailflare #219): deletes raw MIME
 * under `inbound/` that no message references and no pending queue message names, once it is a day old (a message the
 * queue dropped after its last retry, a crash between storing and enqueueing). Walks the prefix in key order from where
 * the last run stopped, a capped number of pages per run, and never deletes anything else.
 */
export async function sweepOrphanedRawMail(
	env: CloudflareEnv,
	now = new Date(),
	options: { pageSize?: number; maxPages?: number } = {},
): Promise<RawSweepResult> {
	const blocked = await sweepBlockedBy(env);
	if (blocked) {
		logger.info("email.raw_sweep_skipped", { reason: blocked });
		return { skipped: blocked };
	}
	const queued = await pendingQueueKeys(env);
	let after = await readPosition(env);
	let scanned = 0;
	let removed = 0;
	for (let page = 0; page < (options.maxPages ?? RAW_SWEEP_MAX_PAGES); page++) {
		const listing = await env.BUCKET.list({
			prefix: RAW_SWEEP_PREFIX,
			limit: options.pageSize ?? RAW_SWEEP_PAGE_SIZE,
			...(after ? { startAfter: after } : {}),
		});
		const { due, reachedYoung } = dueRawObjects(listing.objects as RawSweepObject[], now);
		if (!due.length) break;
		const referenced = await referencedKeys(env, due);
		const orphans = due.filter((key) => !referenced.has(key) && !queued.has(key));
		if (orphans.length) await env.BUCKET.delete(orphans);
		scanned += due.length;
		removed += orphans.length;
		after = due[due.length - 1];
		await writePosition(env, after);
		if (reachedYoung || !listing.truncated) break;
	}
	logger.info("email.raw_sweep", { scanned, removed });
	return { skipped: null, scanned, removed, after };
}

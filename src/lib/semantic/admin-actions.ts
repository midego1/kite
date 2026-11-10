import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messageEmbeddings } from "@/db/schema/semantic";
import { AGENT_SETTINGS_ID } from "@/lib/agent/provider-constants";
import { chunkVectorId } from "./filter-utils";
import { getSemanticInstallSettings } from "./install-settings";
import { insertPendingEmbeddingRows, withOriginColumn } from "./queue-pending";
import { getVectorStore, VectorStoreUnavailableError } from "./vector-store";

/** Rows are read and deleted in pages this large, so a large install never loads its whole index at once. */
const PAGE_SIZE = 1_000;

type IndexedRow = { vectorKey: string; chunkCount: number };

async function* pagesOfIndexedVectors(
	env: CloudflareEnv,
	where: string,
	params: unknown[],
): AsyncGenerator<IndexedRow[]> {
	let cursor = 0;
	for (;;) {
		const { results } = await env.DB.prepare(
			`SELECT rowid AS cursor, vector_key AS vectorKey, chunk_count AS chunkCount FROM message_embeddings
			WHERE ${where} AND chunk_count > 0 AND vector_key IS NOT NULL AND rowid > ?
			ORDER BY rowid LIMIT ?`,
		)
			.bind(...params, cursor, PAGE_SIZE)
			.all<IndexedRow & { cursor: number }>();
		if (results.length === 0) return;
		yield results;
		cursor = results[results.length - 1].cursor;
		if (results.length < PAGE_SIZE) return;
	}
}

function vectorIdsOf(rows: readonly IndexedRow[]): string[] {
	return rows.flatMap((row) =>
		Array.from({ length: row.chunkCount }, (_, chunk) => chunkVectorId(row.vectorKey, chunk)),
	);
}

/**
 * Deletes every known vector of the rows matching `where` (used both for one mailbox and for the whole install),
 * leaving the rows themselves for the caller to update or delete. A no-op, not an error, when nothing is indexed
 * yet (no vector store needs to be configured for a switch nothing has ever used).
 */
async function deleteKnownVectors(env: CloudflareEnv, where: string, params: unknown[]): Promise<void> {
	let store: ReturnType<typeof getVectorStore> | null = null;
	for await (const page of pagesOfIndexedVectors(env, where, params)) {
		const ids = vectorIdsOf(page);
		if (ids.length === 0) continue;
		try {
			store ??= getVectorStore(env);
		} catch (error) {
			if (error instanceof VectorStoreUnavailableError) return;
			throw error;
		}
		await store.deleteByIds(ids);
	}
}

/**
 * "Rebuild index" (Admin): every row of a mailbox that is still allowed to be indexed (AI not off, `semantic_index`
 * on) goes back to `pending`; upserts overwrite the same ids, so this costs an embedding call only for content whose
 * hash has changed since it was last indexed (`indexer.ts`'s `alreadyCurrent` check).
 */
export async function rebuildSemanticIndex(env: CloudflareEnv): Promise<void> {
	const requeue = (origin: string) =>
		env.DB.prepare(
			`UPDATE message_embeddings
		SET status = 'pending', queued_at = CAST(strftime('%s', 'now') AS integer), lease_until = NULL, attempts = 0, error = NULL${origin}
		WHERE mailbox_id IS NOT NULL
			AND NOT coalesce((SELECT ai_disabled FROM mailbox_agent_settings WHERE mailbox_id = message_embeddings.mailbox_id), false)
			AND coalesce((SELECT semantic_index FROM mailbox_agent_settings WHERE mailbox_id = message_embeddings.mailbox_id), true) = true`,
		).run();
	// A rebuild is live work, whoever queued the row first (`origin`, migration 0110).
	await withOriginColumn(
		() => requeue(", origin = 'live'"),
		() => requeue(""),
	);
}

/**
 * Turning the feature off (section 13): deletes every vector this install's own rows name, then every
 * `message_embeddings` and `message_embedding_deletes` row and the backfill cursor. Turning it on again starts a
 * complete backfill, since the cursor it would otherwise resume from now names messages whose vectors are gone.
 */
export async function disableSemanticSearch(env: CloudflareEnv): Promise<void> {
	await deleteKnownVectors(env, "1 = 1", []);
	await env.DB.prepare("DELETE FROM message_embeddings").run();
	await env.DB.prepare("DELETE FROM message_embedding_deletes").run();
	await env.DB.prepare(
		"UPDATE app_settings SET semantic_search_enabled = false, semantic_backfill_cursor = NULL WHERE id = ?",
	)
		.bind(AGENT_SETTINGS_ID)
		.run();
}

/**
 * A mailbox manager switching **Search by meaning** off, or the primary admin turning on "No AI for this mailbox"
 * (which must keep the mailbox's mail away from every AI provider just as strictly): pending and running rows are
 * marked `skipped` and every vector the mailbox's rows name is deleted. Rows are kept (not deleted), so turning the
 * switch back on can tell apart "never indexed" from "was indexed, now excluded".
 *
 * Marked `skipped` *before* the vectors are deleted, and `chunk_count` is kept until the delete has gone through:
 * a drain batch already past its `rowsStillRunning` check (for this same mailbox) reads `skipped`, not `running`,
 * the moment it looks again, so it writes nothing for these rows. The search path (`search.ts`) only ever maps a
 * vector key back to an `indexed` row of a mailbox whose switches still allow it, which is the real guarantee: it
 * holds even in the narrow window a concurrent write could still land between these two statements.
 *
 * Returns early while the install feature is off (S2 of review round 2, also its own `message_embeddings` table
 * cannot have anything to clear before migration 0099, and `getSemanticInstallSettings` already reads as `enabled:
 * false` on a database that has not applied it): a mailbox's AI switch flips on every install, most of which never
 * turn this feature on, and would otherwise page the mailbox's whole row set for nothing every time.
 */
export async function clearMailboxSemanticIndex(env: CloudflareEnv, mailboxId: string): Promise<void> {
	if (!(await getSemanticInstallSettings(env)).enabled) return;
	await getDb(env)
		.update(messageEmbeddings)
		.set({ status: "skipped", leaseUntil: null })
		.where(eq(messageEmbeddings.mailboxId, mailboxId));
	await deleteKnownVectors(env, "mailbox_id = ?", [mailboxId]);
	await getDb(env).update(messageEmbeddings).set({ chunkCount: 0 }).where(eq(messageEmbeddings.mailboxId, mailboxId));
}

/**
 * Eligible messages of the mailbox with no `message_embeddings` row at all, paged: a message delivered while the
 * mailbox was excluded never got one from the INSERT trigger, and the backfill, which only looks at messages with
 * no row, had already walked past it (or skips the mailbox outright) while it was excluded.
 */
async function* pagesOfMissingRows(env: CloudflareEnv, mailboxId: string): AsyncGenerator<string[]> {
	let cursor = 0;
	for (;;) {
		const { results } = await env.DB.prepare(
			`SELECT m.rowid AS cursor, m.id AS id FROM messages m
			LEFT JOIN message_embeddings me ON me.message_id = m.id
			WHERE me.message_id IS NULL
				AND m.mailbox_id = ?
				AND m.status IN ('received', 'sent', 'archived')
				AND (m.spam_verdict IS NULL OR m.spam_verdict <> 'spam')
				AND m.rowid > ?
			ORDER BY m.rowid LIMIT ?`,
		)
			.bind(mailboxId, cursor, PAGE_SIZE)
			.all<{ cursor: number; id: string }>();
		if (results.length === 0) return;
		yield results.map((row) => row.id);
		cursor = results[results.length - 1].cursor;
		if (results.length < PAGE_SIZE) return;
	}
}

/**
 * Switching **Search by meaning** back on for a mailbox (or turning "No AI for this mailbox" back off): every row
 * of the mailbox is set back to `pending`, including ones marked `indexed`, because their vectors are gone and the
 * content-hash skip in `indexer.ts` must not keep them out. The triggers do not see this (no message status
 * changes) and the backfill cursor may have long passed these messages, so the switch does it itself.
 *
 * Returns early while the install feature is off (S2 and R4 of review round 2): before migration 0099 is applied,
 * `mailbox_agent_settings.semantic_index`, read below, does not exist yet either, and reading a missing column
 * fails as "no such column", not "no such table" — `getSemanticInstallSettings` already reads as `enabled: false`
 * on such a database, so checking it first here means this never reaches that read until 0099 is applied.
 */
export async function requeueMailboxSemanticIndex(env: CloudflareEnv, mailboxId: string): Promise<void> {
	if (!(await getSemanticInstallSettings(env)).enabled) return;
	// Guarded by the mailbox's own switches, so a caller flipping "No AI for this mailbox" back off never requeues a
	// mailbox whose manager separately turned "Search by meaning" off for it (and vice versa for ai_disabled).
	const allowed = await env.DB.prepare(
		`SELECT NOT coalesce((SELECT ai_disabled FROM mailbox_agent_settings WHERE mailbox_id = ?), false)
			AND coalesce((SELECT semantic_index FROM mailbox_agent_settings WHERE mailbox_id = ?), true) = true AS ok`,
	)
		.bind(mailboxId, mailboxId)
		.first<{ ok: number }>();
	if (!allowed?.ok) return;
	const requeue = (origin: string) =>
		env.DB.prepare(
			`UPDATE message_embeddings SET status = 'pending', queued_at = CAST(strftime('%s', 'now') AS integer), lease_until = NULL, attempts = 0, error = NULL, content_hash = NULL${origin}
		WHERE mailbox_id = ?`,
		)
			.bind(mailboxId)
			.run();
	await withOriginColumn(
		() => requeue(", origin = 'live'"),
		() => requeue(""),
	);
	// A message delivered or imported while the mailbox was excluded, or already walked past by the backfill,
	// never got a row at all: give it one now, instead of only ever resetting rows that already existed.
	const now = new Date();
	for await (const ids of pagesOfMissingRows(env, mailboxId)) {
		await insertPendingEmbeddingRows(
			env,
			ids.map((id) => ({ id, mailboxId, queuedAt: now })),
		);
	}
}

export type ClearStaleVectorsResult = { supported: boolean; removed: number };

/**
 * "Clear stale vectors" (Admin): removes any vector in the store whose key is not in `message_embeddings`, for an
 * index left with orphans after a restore into a different database. Only the stores with a real backing table to
 * list (the Node and dev/e2e brute-force stores) support this; Vectorize's binding has no way to list every vector
 * it holds, so this is unavailable on Workers until Cloudflare adds one.
 */
export async function clearStaleVectors(env: CloudflareEnv): Promise<ClearStaleVectorsResult> {
	const store = getVectorStore(env);
	if (!store.listIds) return { supported: false, removed: 0 };
	const db = getDb(env);
	let removed = 0;
	let cursor: number | null = 0;
	while (cursor !== null) {
		const page = await store.listIds(cursor);
		const keys = [...new Set(page.ids.map((id) => id.split(":")[0]))];
		if (keys.length > 0) {
			const known = await db
				.select({ vectorKey: messageEmbeddings.vectorKey })
				.from(messageEmbeddings)
				.where(inArray(messageEmbeddings.vectorKey, keys));
			const knownKeys = new Set(known.map((row) => row.vectorKey));
			const orphans = page.ids.filter((id) => !knownKeys.has(id.split(":")[0]));
			if (orphans.length > 0) {
				await store.deleteByIds(orphans);
				removed += orphans.length;
			}
		}
		cursor = page.cursor;
	}
	return { supported: true, removed };
}

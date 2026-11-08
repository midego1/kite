import { AGENT_SETTINGS_ID } from "@/lib/agent/provider-constants";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { formatBackfillCursor, getSemanticInstallSettings, type SemanticBackfillCursor } from "./install-settings";
import { insertPendingEmbeddingRows } from "./queue-pending";
import { backfillCapReached } from "./spend";

/** Each cron tick inserts `pending` rows for up to this many more eligible messages. */
const BACKFILL_PAGE_SIZE = 5_000;
/**
 * Nothing is inserted while at least this many rows are already `pending`: about 2x a Workers drain tick's
 * capacity (4 batches of `CLAIM_BATCH_SIZE`), so a single tick's 5,000-row page cannot build a backlog the drain
 * then spends through for minutes regardless of the backfill's own cap share (B6).
 */
const PENDING_BACKLOG_LIMIT = 256;

type Candidate = { id: string; mailboxId: string; createdAt: number };

/** Eligible messages with no `message_embeddings` row yet, newest first from the cursor, oldest-reached-so-far. */
async function selectBackfillCandidates(
	env: CloudflareEnv,
	cursor: SemanticBackfillCursor | null,
): Promise<Candidate[]> {
	const { results } = await env.DB.prepare(
		`SELECT m.id AS id, m.mailbox_id AS mailboxId, m.created_at AS createdAt
		FROM messages m
		LEFT JOIN message_embeddings me ON me.message_id = m.id
		WHERE me.message_id IS NULL
			AND m.mailbox_id IS NOT NULL
			AND m.status IN ('received', 'sent', 'archived')
			AND (m.spam_verdict IS NULL OR m.spam_verdict <> 'spam')
			AND NOT coalesce((SELECT ai_disabled FROM mailbox_agent_settings WHERE mailbox_id = m.mailbox_id), false)
			AND coalesce((SELECT semantic_index FROM mailbox_agent_settings WHERE mailbox_id = m.mailbox_id), true) = true
			AND (? IS NULL OR m.created_at < ? OR (m.created_at = ? AND m.id < ?))
		ORDER BY m.created_at DESC, m.id DESC
		LIMIT ?`,
	)
		.bind(
			cursor?.createdAt ?? null,
			cursor?.createdAt ?? null,
			cursor?.createdAt ?? null,
			cursor?.id ?? null,
			BACKFILL_PAGE_SIZE,
		)
		.all<Candidate>();
	return results;
}

/** Whether the queue already holds `PENDING_BACKLOG_LIMIT` or more rows waiting to be drained. */
async function pendingBacklogTooDeep(env: CloudflareEnv): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT count(*) AS total FROM (SELECT 1 FROM message_embeddings WHERE status = 'pending' LIMIT ?)`,
	)
		.bind(PENDING_BACKLOG_LIMIT)
		.first<{ total: number }>();
	return (row?.total ?? 0) >= PENDING_BACKLOG_LIMIT;
}

/**
 * Turning the feature on starts the backfill: each tick inserts `pending` rows for up to `BACKFILL_PAGE_SIZE` more
 * eligible messages, newest first from the cursor, until no message is left. Gives way to everything else: it
 * inserts nothing while today's embedding spend from its own `embedding_backfill` source is already at
 * `semantic_backfill_cap_share` of the install cap (checked again at drain time in `indexer.ts`, which is what
 * actually spends it), while the pending queue is already deep enough to keep a drain busy for a while, or while
 * paused.
 */
export async function runSemanticBackfillTick(env: CloudflareEnv): Promise<void> {
	try {
		const settings = await getSemanticInstallSettings(env);
		if (!settings.enabled || settings.backfillPaused) return;
		if (await backfillCapReached(env, settings.backfillCapShare)) return;
		if (await pendingBacklogTooDeep(env)) return;
		const candidates = await selectBackfillCandidates(env, settings.backfillCursor);
		if (candidates.length === 0) return;
		// Each message's own date, not "now": the drain (`indexer.ts`'s `isBackfillClaim`) tells a backfill batch
		// apart from live mail by this, and it keeps a backfill page from claiming ahead of mail that arrives while
		// it is still running (`queued_at DESC` favours the newer timestamp, which live mail's "now" almost always is).
		await insertPendingEmbeddingRows(
			env,
			candidates.map((row) => ({ id: row.id, mailboxId: row.mailboxId, queuedAt: new Date(row.createdAt * 1000) })),
		);
		const last = candidates[candidates.length - 1];
		await env.DB.prepare("UPDATE app_settings SET semantic_backfill_cursor = ? WHERE id = ?")
			.bind(formatBackfillCursor({ createdAt: last.createdAt, id: last.id }), AGENT_SETTINGS_ID)
			.run();
	} catch (error) {
		if (isNoSuchTableError(error)) return; // Migration 0099 not applied yet.
		throw error;
	}
}

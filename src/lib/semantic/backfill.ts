import { getDb } from "@/db";
import { messageEmbeddings } from "@/db/schema/semantic";
import { AGENT_SETTINGS_ID } from "@/lib/agent/provider-constants";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { formatBackfillCursor, getSemanticInstallSettings, type SemanticBackfillCursor } from "./install-settings";
import { backfillCapReached } from "./spend";

/** Each cron tick inserts `pending` rows for up to this many more eligible messages. */
const BACKFILL_PAGE_SIZE = 5_000;
/** `message_embeddings` rows are inserted in batches this small to stay under D1's 100 bound-parameter limit. */
const INSERT_CHUNK_SIZE = 20;

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

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

/**
 * Turning the feature on starts the backfill: each tick inserts `pending` rows for up to `BACKFILL_PAGE_SIZE` more
 * eligible messages, newest first from the cursor, until no message is left. Gives way to everything else: it
 * inserts nothing while today's embedding spend is already at `semantic_backfill_cap_share` of the install cap, or
 * while paused.
 */
export async function runSemanticBackfillTick(env: CloudflareEnv): Promise<void> {
	try {
		const settings = await getSemanticInstallSettings(env);
		if (!settings.enabled || settings.backfillPaused) return;
		if (await backfillCapReached(env, settings.backfillCapShare)) return;
		const candidates = await selectBackfillCandidates(env, settings.backfillCursor);
		if (candidates.length === 0) return;
		const db = getDb(env);
		const now = new Date();
		for (const batch of chunks(candidates, INSERT_CHUNK_SIZE)) {
			await db
				.insert(messageEmbeddings)
				.values(
					batch.map((row) => ({
						messageId: row.id,
						mailboxId: row.mailboxId,
						status: "pending" as const,
						queuedAt: now,
					})),
				)
				.onConflictDoNothing();
		}
		const last = candidates[candidates.length - 1];
		await env.DB.prepare("UPDATE app_settings SET semantic_backfill_cursor = ? WHERE id = ?")
			.bind(formatBackfillCursor({ createdAt: last.createdAt, id: last.id }), AGENT_SETTINGS_ID)
			.run();
	} catch (error) {
		if (isNoSuchTableError(error)) return; // Migration 0095 not applied yet.
		throw error;
	}
}

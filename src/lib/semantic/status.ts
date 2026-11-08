import { resolveAgentModelRates } from "@/lib/agent/model-prices-utils";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { EMBEDDING_MODEL_ID } from "./embedding";
import { getSemanticInstallSettings, type SemanticInstallSettings } from "./install-settings";

type SemanticStatusCounts = {
	pending: number;
	running: number;
	indexed: number;
	skipped: number;
	failed: number;
	/** Messages that would be indexed once the feature is on, but have no `message_embeddings` row yet. */
	eligibleUnqueued: number;
};

export type SemanticStatus = {
	ready: boolean;
	settings: SemanticInstallSettings;
	counts: SemanticStatusCounts;
	/** USD to embed `eligibleUnqueued` at bge-m3's rate; null without a resolvable rate. */
	estimatedCostUsd: number | null;
};

const EMPTY_COUNTS: SemanticStatusCounts = {
	pending: 0,
	running: 0,
	indexed: 0,
	skipped: 0,
	failed: 0,
	eligibleUnqueued: 0,
};

async function statusCounts(env: CloudflareEnv): Promise<SemanticStatusCounts> {
	const { results } = await env.DB.prepare(
		"SELECT status, count(*) AS total FROM message_embeddings GROUP BY status",
	).all<{
		status: string;
		total: number;
	}>();
	const counts = { ...EMPTY_COUNTS };
	for (const row of results) if (row.status in counts) (counts as Record<string, number>)[row.status] = row.total;
	const unqueued = await env.DB.prepare(
		`SELECT count(*) AS total FROM messages m
		LEFT JOIN message_embeddings me ON me.message_id = m.id
		WHERE me.message_id IS NULL
			AND m.mailbox_id IS NOT NULL
			AND m.status IN ('received', 'sent', 'archived')
			AND (m.spam_verdict IS NULL OR m.spam_verdict <> 'spam')
			AND NOT coalesce((SELECT ai_disabled FROM mailbox_agent_settings WHERE mailbox_id = m.mailbox_id), false)
			AND coalesce((SELECT semantic_index FROM mailbox_agent_settings WHERE mailbox_id = m.mailbox_id), true) = true`,
	).first<{ total: number }>();
	counts.eligibleUnqueued = unqueued?.total ?? 0;
	return counts;
}

/** ~600 tokens of embedded text per message on average (header plus up to 8 chunks; most mail is one chunk). */
const AVERAGE_TOKENS_PER_MESSAGE = 600;

function estimatedCost(messages: number): number | null {
	const rates = resolveAgentModelRates({}, [EMBEDDING_MODEL_ID])[EMBEDDING_MODEL_ID];
	if (!rates || rates.input === null) return null;
	return (messages * AVERAGE_TOKENS_PER_MESSAGE * rates.input) / 1_000_000;
}

/** Admin -> Agent -> Search by meaning: settings, progress and the estimated cost to finish the backfill. */
export async function getSemanticStatus(env: CloudflareEnv): Promise<SemanticStatus> {
	const settings = await getSemanticInstallSettings(env);
	try {
		const counts = await statusCounts(env);
		return { ready: true, settings, counts, estimatedCostUsd: estimatedCost(counts.pending + counts.eligibleUnqueued) };
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
		return { ready: false, settings, counts: EMPTY_COUNTS, estimatedCostUsd: null };
	}
}

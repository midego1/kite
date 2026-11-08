import { and, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { messageEmbeddings } from "@/db/schema/semantic";
import { queryInChunks } from "@/db/chunk-utils";
import { buildFtsMatch, parseSearchQuery } from "@/lib/search/query-utils";
import { type FusedHit, reciprocalRankFusion, type SemanticMatch } from "./fusion-utils";
import { parseChunkVectorId } from "./filter-utils";
import { embeddingAvailability, embeddingErrorCode, getEmbeddingProvider } from "./embedding";
import { reserveEmbeddingQuerySpend, settleEmbeddingSpend } from "./spend";
import { getVectorStore, VectorStoreUnavailableError } from "./vector-store";

export type { SemanticMatch };

/** The free text must be at least this long before it is embedded; a shorter one is keyword-only. */
const MIN_QUERY_CHARS = 3;
const FTS_TOP_K = 100;
const VECTOR_TOP_K = 100;
/** Cosine similarity below this is dropped before fusion (tuned in the spike, section 4.6). */
const MIN_SIMILARITY = 0.45;
/** At most this many messages are returned, in fused order; "Show more" continues with keyword results by date. */
const RESULT_LIMIT = 50;

export type SemanticSearchInput = {
	env: CloudflareEnv;
	/** Every condition the keyword search already applies — mailbox scope, folder, status, operators — except the
	 * free-text FTS condition itself. Used both to scope the keyword ranking query and as the D1 re-check. */
	scopeWhere: SQL;
	/** The free-text part of the query only (operators already split out by the caller). */
	queryText: string;
	/** The mailboxes the vector store query is scoped to: the accessible ids, or just the selected mailbox. */
	mailboxIds: readonly string[];
};

export type SemanticSearchResult = {
	/** Message ids in fused, re-checked order, newest-ranked first, capped at `RESULT_LIMIT`. */
	ids: string[];
	matches: Map<string, SemanticMatch>;
	semantic: "on" | "unavailable";
	semanticReason?: string;
};

/** Keyword hits ranked by `bm25`, scoped exactly like the rest of the search (`docs/specs/semantic-search.md` 4.6 step 2). */
async function keywordRankedIds(db: AppDatabase, scopeWhere: SQL, ftsMatch: string): Promise<string[]> {
	const rows = await db.all<{ id: string }>(sql`
		SELECT ${messages.id} AS id FROM messages_fts
		JOIN ${messages} ON ${messages}.rowid = messages_fts.rowid
		WHERE messages_fts MATCH ${ftsMatch} AND (${scopeWhere})
		ORDER BY messages_fts.rank
		LIMIT ${FTS_TOP_K}
	`);
	return rows.map((row) => row.id);
}

/**
 * Meaning hits (section 4.6 step 3): embeds the query, asks the vector store scoped to `mailboxIds`, drops anything
 * under `MIN_SIMILARITY`, and maps each surviving chunk back to its message id through `message_embeddings.vector_key`,
 * keeping each message's best-scoring chunk. Returns `[]` (never throws) when the provider or spend cap refuses.
 */
async function meaningRankedIds(
	env: CloudflareEnv,
	db: AppDatabase,
	queryText: string,
	mailboxIds: readonly string[],
	spendMailboxId: string | null,
): Promise<string[]> {
	if (mailboxIds.length === 0) return [];
	const provider = await getEmbeddingProvider(env);
	const reservation = await reserveEmbeddingQuerySpend(env, provider.kind, spendMailboxId, queryText.length);
	if (!reservation) return [];
	let vector: Float32Array;
	try {
		const embedded = await provider.embedTexts([queryText]);
		await settleEmbeddingSpend(env, reservation, { inputTokens: embedded.inputTokens });
		vector = embedded.vectors[0];
	} catch (error) {
		await settleEmbeddingSpend(env, reservation, { failed: embeddingErrorCode(error) });
		throw error;
	}
	const store = getVectorStore(env);
	const hits = await store.query(vector, { mailboxIds: [...mailboxIds], topK: VECTOR_TOP_K });
	const bestScorePerKey = new Map<string, number>();
	for (const hit of hits) {
		if (hit.score < MIN_SIMILARITY) continue;
		const parsed = parseChunkVectorId(hit.id);
		if (!parsed) continue;
		const current = bestScorePerKey.get(parsed.key);
		if (current === undefined || current < hit.score) bestScorePerKey.set(parsed.key, hit.score);
	}
	const keys = [...bestScorePerKey.keys()];
	if (keys.length === 0) return [];
	const rows = await queryInChunks(keys, (chunk) =>
		db
			.select({ messageId: messageEmbeddings.messageId, vectorKey: messageEmbeddings.vectorKey })
			.from(messageEmbeddings)
			.where(inArray(messageEmbeddings.vectorKey, chunk)),
	);
	return rows
		.map((row) => ({ id: row.messageId, score: bestScorePerKey.get(row.vectorKey!) ?? 0 }))
		.sort((a, b) => b.score - a.score)
		.map((row) => row.id);
}

/**
 * Hybrid search (`docs/specs/semantic-search.md` section 4.6): keyword hits are always ranked; meaning hits are
 * added when the feature is on, the query has at least `MIN_QUERY_CHARS` characters and the embedding call and
 * spend cap allow it. The two lists are fused (reciprocal rank fusion), then every fused id is re-checked against
 * `scopeWhere` (the same guarantee the keyword path already has) before the top `RESULT_LIMIT` are returned.
 * Falls back to keyword-only (never throws) whenever meaning search is unavailable.
 */
export async function semanticSearch(input: SemanticSearchInput): Promise<SemanticSearchResult> {
	const db = getDb(input.env);
	const parsed = parseSearchQuery(input.queryText);
	const ftsMatch = buildFtsMatch(parsed);
	const keywordIds = ftsMatch ? await keywordRankedIds(db, input.scopeWhere, ftsMatch) : [];

	let semantic: "on" | "unavailable" = "on";
	let semanticReason: string | undefined;
	let meaningIds: string[] = [];
	if (input.queryText.trim().length < MIN_QUERY_CHARS) {
		// Too short to embed; keyword-only, but not "unavailable" (nothing failed).
	} else {
		const availability = await embeddingAvailability(input.env);
		if (!availability.ok) {
			semantic = "unavailable";
			semanticReason = availability.reason;
		} else {
			try {
				const spendMailboxId = input.mailboxIds.length === 1 ? input.mailboxIds[0] : null;
				meaningIds = await meaningRankedIds(input.env, db, input.queryText, input.mailboxIds, spendMailboxId);
			} catch (error) {
				semantic = "unavailable";
				semanticReason = error instanceof VectorStoreUnavailableError ? "no_vector_store" : embeddingErrorCode(error);
			}
		}
	}

	const fused = reciprocalRankFusion(keywordIds, meaningIds);
	if (fused.length === 0) return { ids: [], matches: new Map(), semantic, semanticReason };

	// The D1 re-check: every fused id must still satisfy the exact conditions the keyword search applies.
	const allowed = new Set(
		(
			await queryInChunks(
				fused.map((hit) => hit.id),
				(chunk) =>
					db
						.select({ id: messages.id })
						.from(messages)
						.where(and(input.scopeWhere, inArray(messages.id, chunk))),
			)
		).map((row) => row.id),
	);
	const kept = fused.filter((hit: FusedHit) => allowed.has(hit.id)).slice(0, RESULT_LIMIT);
	return {
		ids: kept.map((hit) => hit.id),
		matches: new Map(kept.map((hit) => [hit.id, hit.match])),
		semantic,
		semanticReason,
	};
}

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
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
/**
 * The meaning half (the query embedding plus the vector store query together) gets this long before a search
 * answers with keyword matches alone: a search request is interactive, so it gets a much shorter budget than a
 * drain batch's (`embedding.ts`'s `EMBEDDING_CALL_TIMEOUT_MS`). The abandoned call may still finish after this
 * function has moved on (a Workers isolate does not cancel it, only the caller stops waiting); it settles its own
 * spend reservation when it does, so nothing is double-charged or left reserved for long.
 */
const MEANING_SEARCH_TIMEOUT_MS = 2_500;

export class MeaningSearchTimeoutError extends Error {
	constructor() {
		super(`Meaning search timed out after ${MEANING_SEARCH_TIMEOUT_MS}ms`);
		this.name = "MeaningSearchTimeoutError";
	}
}

function withSearchDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new MeaningSearchTimeoutError()), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

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
 * Mailboxes of `mailboxIds` whose own switches still allow meaning search (no row means allowed, the same default
 * every other semantic read/write uses). Checked again here, not just at index time, because `clearMailboxSemanticIndex`
 * marks rows skipped and deletes vectors in two separate statements (`admin-actions.ts`): a vector a concurrent
 * drain write landed in the narrow window between them must never surface through search for an excluded mailbox.
 */
async function allowedSemanticMailboxIds(env: CloudflareEnv, mailboxIds: readonly string[]): Promise<string[]> {
	if (mailboxIds.length === 0) return [];
	const placeholders = mailboxIds.map(() => "?").join(", ");
	const { results } = await env.DB.prepare(
		`SELECT mailbox_id AS mailboxId FROM mailbox_agent_settings
		WHERE mailbox_id IN (${placeholders}) AND (ai_disabled = 1 OR semantic_index = 0)`,
	)
		.bind(...mailboxIds)
		.all<{ mailboxId: string }>();
	const excluded = new Set(results.map((row) => row.mailboxId));
	return mailboxIds.filter((id) => !excluded.has(id));
}

/**
 * Meaning hits (section 4.6 step 3): embeds the query, asks the vector store scoped to the mailboxes still allowed
 * (B3's defence in depth), drops anything under `MIN_SIMILARITY`, and maps each surviving chunk back to its message
 * id through `message_embeddings.vector_key`, requiring the row to still be `indexed` (the same defence: a row a
 * concurrent clear marked `skipped` must never resolve), keeping each message's best-scoring chunk. The whole call
 * (the embedding plus the store query) shares one `MEANING_SEARCH_TIMEOUT_MS` deadline. Returns `[]` (never throws)
 * when the provider, the spend cap, or every mailbox being excluded, refuses meaning search outright.
 */
async function meaningRankedIds(
	env: CloudflareEnv,
	db: AppDatabase,
	queryText: string,
	mailboxIds: readonly string[],
	spendMailboxId: string | null,
): Promise<string[]> {
	const allowedMailboxIds = await allowedSemanticMailboxIds(env, mailboxIds);
	if (allowedMailboxIds.length === 0) return [];
	const provider = await getEmbeddingProvider(env);
	const reservation = await reserveEmbeddingQuerySpend(env, provider.kind, spendMailboxId, queryText.length);
	if (!reservation) return [];
	const deadline = Date.now() + MEANING_SEARCH_TIMEOUT_MS;
	let vector: Float32Array;
	try {
		const embedded = await withSearchDeadline(provider.embedTexts([queryText]), MEANING_SEARCH_TIMEOUT_MS);
		await settleEmbeddingSpend(env, reservation, { inputTokens: embedded.inputTokens });
		vector = embedded.vectors[0];
	} catch (error) {
		await settleEmbeddingSpend(env, reservation, {
			failed: error instanceof MeaningSearchTimeoutError ? "timeout" : embeddingErrorCode(error),
		});
		throw error;
	}
	const store = getVectorStore(env);
	const hits = await withSearchDeadline(
		store.query(vector, { mailboxIds: allowedMailboxIds, topK: VECTOR_TOP_K }),
		Math.max(0, deadline - Date.now()),
	);
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
			.where(and(inArray(messageEmbeddings.vectorKey, chunk), eq(messageEmbeddings.status, "indexed"))),
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
			// "off" and "assistant_disabled" are not runtime failures: every default-install search would otherwise
			// report "unavailable" and show the note, and the chip itself is already hidden on the client while the
			// feature has nothing to do (`GET /api/mailboxes`'s semanticSearchAvailable) — nothing here to tell the
			// searcher about this request in particular. Treated exactly like a too-short query: keyword-only, quietly.
			if (availability.reason !== "off" && availability.reason !== "assistant_disabled") {
				semantic = "unavailable";
				semanticReason = availability.reason;
			}
		} else {
			try {
				const spendMailboxId = input.mailboxIds.length === 1 ? input.mailboxIds[0] : null;
				meaningIds = await meaningRankedIds(input.env, db, input.queryText, input.mailboxIds, spendMailboxId);
			} catch (error) {
				semantic = "unavailable";
				semanticReason =
					error instanceof VectorStoreUnavailableError
						? "no_vector_store"
						: error instanceof MeaningSearchTimeoutError
							? "timeout"
							: embeddingErrorCode(error);
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

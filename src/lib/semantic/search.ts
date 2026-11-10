import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { mailboxAgentSettings, messages } from "@/db/schema";
import { messageEmbeddings } from "@/db/schema/semantic";
import { inJsonArray, queryInChunks } from "@/db/chunk-utils";
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
	/** Message ids in fused, re-checked order, newest-ranked first, capped at `RESULT_LIMIT`. Empty, and never
	 * meaningful, whenever `semantic` is not `"on"`: every caller must use its own unchanged keyword path then,
	 * not these ids (C-1 of review round 3 — this was the mistake: "off" used to answer exactly like "on" with an
	 * empty meaning half, which silently capped and re-ordered a plain keyword search for every default install). */
	ids: string[];
	matches: Map<string, SemanticMatch>;
	/**
	 * `"on"`: meaning genuinely ran (found something or not) and `ids` is the fused, capped order a caller may use.
	 * `"off"`: meaning was never attempted at all (the feature or the assistant is off, or the query is too short
	 * to embed) — quiet, not a failure, and callers must run their own unchanged keyword path instead of this
	 * function's `ids`. `"unavailable"`: a real runtime failure (`semanticReason` says which); same fallback as
	 * `"off"`, but worth telling the searcher about.
	 */
	semantic: "on" | "off" | "unavailable";
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
	// `inJsonArray`, not one bound parameter per id (C-2 of review round 3): someone with more than 100 accessible
	// mailboxes made every search answer "unavailable" outright, since a plain `IN (...)` here failed the whole
	// query on D1 before a fallback could even run.
	const excludedRows = await getDb(env)
		.select({ mailboxId: mailboxAgentSettings.mailboxId })
		.from(mailboxAgentSettings)
		.where(
			and(
				inJsonArray(mailboxAgentSettings.mailboxId, mailboxIds),
				or(eq(mailboxAgentSettings.aiDisabled, true), eq(mailboxAgentSettings.semanticIndex, false)),
			),
		);
	const excluded = new Set(excludedRows.map((row) => row.mailboxId));
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

const NOT_ATTEMPTED: SemanticSearchResult = { ids: [], matches: new Map(), semantic: "off" };

/**
 * Hybrid search (`docs/specs/semantic-search.md` section 4.6): keyword hits are always ranked; meaning hits are
 * added when the feature is on, the query has at least `MIN_QUERY_CHARS` characters and the embedding call and
 * spend cap allow it. The two lists are fused (reciprocal rank fusion), then every fused id is re-checked against
 * `scopeWhere` (the same guarantee the keyword path already has) before the top `RESULT_LIMIT` are returned.
 *
 * Answers `"off"` (never throwing, and doing no keyword work at all — every caller must run its own unchanged
 * keyword path instead) the moment meaning is not even going to be attempted: too short to embed, the feature
 * off, or the assistant off. C-1 of review round 3: this function used to still run the fused, capped, unpaged
 * path for these exact cases, answering `"on"` quietly — which was fine for a short query (always a narrow edge
 * case) but, once the install feature itself joined the list of quiet reasons (review round 1's C1), meant every
 * default install (the feature is off by default) took the hybrid path for every free-text search, for no reason:
 * capped at `RESULT_LIMIT`, in keyword-rank order instead of by date, with no real pagination. `"unavailable"` is
 * the other non-"on" answer, for a real runtime failure (`semanticReason` says which); every caller must treat it
 * exactly like `"off"` for the fallback decision, the one difference being that it is worth telling the searcher.
 */
export async function semanticSearch(input: SemanticSearchInput): Promise<SemanticSearchResult> {
	if (input.queryText.trim().length < MIN_QUERY_CHARS) return NOT_ATTEMPTED;
	const availability = await embeddingAvailability(input.env);
	if (!availability.ok) {
		if (availability.reason === "off" || availability.reason === "assistant_disabled") return NOT_ATTEMPTED;
		return { ids: [], matches: new Map(), semantic: "unavailable", semanticReason: availability.reason };
	}

	const db = getDb(input.env);
	const parsed = parseSearchQuery(input.queryText);
	const ftsMatch = buildFtsMatch(parsed);
	const keywordIds = ftsMatch ? await keywordRankedIds(db, input.scopeWhere, ftsMatch) : [];

	let semantic: "on" | "unavailable" = "on";
	let semanticReason: string | undefined;
	let meaningIds: string[] = [];
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

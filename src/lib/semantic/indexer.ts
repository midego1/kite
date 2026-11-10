import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { messageEmbeddings } from "@/db/schema/semantic";
import { externalProviderRefused } from "@/lib/agent/external-provider";
import { getAgentEnabled } from "@/lib/agent/provider";
import { loadMessageBodies } from "@/lib/email/bodies";
import { listMessageAttachments } from "@/lib/email/attachments";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { buildEmbeddingText, isSemanticEligibleMessage } from "./chunk-utils";
import {
	embeddingErrorCode,
	EmbeddingProviderUnavailableError,
	getEmbeddingProvider,
	resolvedEmbeddingProviderKind,
} from "./embedding";
import { chunkVectorId, vectorKeyFor } from "./filter-utils";
import { getSemanticInstallSettings } from "./install-settings";
import { backfillCapReached, reserveEmbeddingBatchSpend, settleEmbeddingSpend } from "./spend";
import { getVectorStore } from "./vector-store";

/** Up to this many `pending` (or lease-expired `running`) rows are claimed per drain batch. */
const CLAIM_BATCH_SIZE = 32;
/** How long a claim holds a row before another drain may reclaim it. */
const LEASE_MS = 5 * 60_000;
/** A provider error is retried up to this many times before the row is `failed`. */
const MAX_ATTEMPTS = 3;
/** At most this many tombstones are drained per run. */
const TOMBSTONE_BATCH_SIZE = 1_000;
/**
 * A claimed row is treated as backfill-origin when its `queued_at` is older than this, relative to the claim
 * time: the backfill (`backfill.ts`) is the only writer that ever sets `queued_at` to a message's own `created_at`
 * rather than "now", so a row queued this long ago can only be one of its pages, never a just-delivered message or
 * a rebuild (both queue with "now"). Used to charge the backfill's own spend against its cap share (B6).
 */
const BACKFILL_AGE_MARGIN_MS = 10 * 60_000;

type ClaimedRow = {
	messageId: string;
	mailboxId: string | null;
	vectorKey: string | null;
	contentHash: string | null;
	chunkCount: number;
	attempts: number;
	queuedAt: number | null;
};

/**
 * Claims up to `CLAIM_BATCH_SIZE` rows, newest queued first, so new mail is searchable before old mail is. With
 * `excludeBackfillOrigin`, leaves out any row old enough to only be the backfill's (S3 of review round 2): once
 * the backfill's cap share is already spent for the day, claiming its rows anyway just to load their bodies and
 * attachments and give them straight back wastes a whole batch's work, every batch, for the rest of the day.
 */
async function claimPendingRows(env: CloudflareEnv, now: Date, excludeBackfillOrigin: boolean): Promise<ClaimedRow[]> {
	const leaseUntil = Math.floor((now.getTime() + LEASE_MS) / 1000);
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const backfillCutoff = Math.floor((now.getTime() - BACKFILL_AGE_MARGIN_MS) / 1000);
	const { results } = await env.DB.prepare(
		`UPDATE message_embeddings
		SET status = 'running', lease_until = ?
		WHERE message_id IN (
			SELECT message_id FROM message_embeddings
			WHERE (status = 'pending' OR (status = 'running' AND lease_until < ?))
				AND (NOT ? OR queued_at IS NULL OR queued_at >= ?)
			ORDER BY queued_at DESC
			LIMIT ?
		)
		RETURNING message_id AS messageId, mailbox_id AS mailboxId, vector_key AS vectorKey, content_hash AS contentHash, chunk_count AS chunkCount, attempts, queued_at AS queuedAt`,
	)
		.bind(leaseUntil, nowSeconds, excludeBackfillOrigin ? 1 : 0, backfillCutoff, CLAIM_BATCH_SIZE)
		.all<ClaimedRow>();
	return results;
}

/** Whether a claimed row was queued by the backfill rather than the trigger or a rebuild (see `BACKFILL_AGE_MARGIN_MS`). */
function isBackfillClaim(queuedAt: number | null, now: Date): boolean {
	if (queuedAt === null) return false;
	return now.getTime() - queuedAt * 1000 > BACKFILL_AGE_MARGIN_MS;
}

/** Whether a mailbox has search by meaning on and AI allowed, re-checked at drain time (never at enqueue time for `semantic_index`). */
async function mailboxSemanticAllowed(env: CloudflareEnv, mailboxId: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT semantic_index AS semanticIndex, ai_disabled AS aiDisabled FROM mailbox_agent_settings WHERE mailbox_id = ?",
	)
		.bind(mailboxId)
		.first<{ semanticIndex: number | null; aiDisabled: number | null }>();
	if (!row) return true;
	return row.semanticIndex !== 0 && !row.aiDisabled;
}

type LoadedMessage = {
	id: string;
	mailboxId: string | null;
	status: string;
	spamVerdict: string | null;
	subject: string | null;
	fromAddr: string;
	toAddr: string;
	createdAt: Date;
	textBody: string | null;
	htmlBody: string | null;
};

async function loadClaimedMessages(env: CloudflareEnv, ids: string[]): Promise<Map<string, LoadedMessage>> {
	if (ids.length === 0) return new Map();
	const db = getDb(env);
	const rows = await db
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			status: messages.status,
			spamVerdict: messages.spamVerdict,
			subject: messages.subject,
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			createdAt: messages.createdAt,
			textBody: messages.textBody,
			htmlBody: messages.htmlBody,
		})
		.from(messages)
		.where(inArray(messages.id, ids));
	const withBodies = await loadMessageBodies(env, rows, { textFirst: true });
	return new Map(withBodies.map((row) => [row.id, row]));
}

async function markSkipped(env: CloudflareEnv, messageIds: string[]): Promise<void> {
	if (messageIds.length === 0) return;
	await getDb(env)
		.update(messageEmbeddings)
		.set({ status: "skipped", leaseUntil: null })
		.where(inArray(messageEmbeddings.messageId, messageIds));
}

type PreparedChunk = {
	messageId: string;
	mailboxId: string;
	vectorKey: string;
	texts: string[];
	contentHash: string;
	oldChunkCount: number;
	backfill: boolean;
};

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The gates in front of every batch, re-read every time (an external provider can be turned off between batches):
 * `semantic_search_enabled`, the install kill switch, and a configured embedding provider (the compatible kind also
 * needs the external-provider opt-in).
 */
async function embeddingDrainAllowed(env: CloudflareEnv): Promise<boolean> {
	const [settings, agentEnabled] = await Promise.all([getSemanticInstallSettings(env), getAgentEnabled(env)]);
	if (!settings.enabled || !agentEnabled) return false;
	const kind = await resolvedEmbeddingProviderKind(env);
	if (kind === "compatible" && (await externalProviderRefused(env, "compatible"))) return false;
	if (kind === "compatible" && !settings.compatibleBaseUrl) return false;
	return true;
}

/**
 * One drain batch (`docs/specs/semantic-search.md` section 4.5): claims up to `CLAIM_BATCH_SIZE` rows, re-checks
 * eligibility, embeds the still-eligible ones under one spend reservation, upserts their vectors and drains a page
 * of delete tombstones. Returns how many rows were claimed, so callers can stop once a run claims nothing.
 */
export async function processEmbeddingBatch(env: CloudflareEnv): Promise<{ claimed: number }> {
	// Deletes make no embedding call, so they drain even while the gate below is closed (a kill switch, a
	// revoked external-provider opt-in): otherwise a deleted message's vectors would stay searchable indefinitely.
	await drainDeleteTombstones(env);
	if (!(await embeddingDrainAllowed(env))) return { claimed: 0 };
	const now = new Date();
	const settings = await getSemanticInstallSettings(env);
	// Checked before claiming, not just before embedding (S3 of review round 2): once the backfill's own share of
	// the cap is spent, leaving its rows out of the claim entirely means a tick with nothing but backfill work left
	// claims nothing and `runEmbeddingDrainBatches` stops early, instead of claiming, loading and giving back the
	// same rows every batch for the rest of the day.
	const backfillCapped = await backfillCapReached(env, settings.backfillCapShare);
	const claimed = await claimPendingRows(env, now, backfillCapped);
	if (claimed.length === 0) {
		return { claimed: 0 };
	}
	const messagesById = await loadClaimedMessages(
		env,
		claimed.map((row) => row.messageId),
	);

	const toSkip: string[] = [];
	const toFail: { messageId: string; attempts: number; code: string }[] = [];
	const prepared: PreparedChunk[] = [];
	const alreadyCurrent: ClaimedRow[] = [];

	for (const row of claimed) {
		const message = messagesById.get(row.messageId);
		const mailboxId = message?.mailboxId ?? row.mailboxId;
		if (
			!message ||
			!mailboxId ||
			!isSemanticEligibleMessage(message) ||
			!(await mailboxSemanticAllowed(env, mailboxId))
		) {
			toSkip.push(row.messageId);
			continue;
		}
		const attachmentNames = (await listMessageAttachments(env, message.id)).map((attachment) => attachment.filename);
		const texts = buildEmbeddingText({ ...message, attachmentNames });
		const contentHash = await sha256Hex(`${texts.join("\u0000")}\u0000@cf/baai/bge-m3`);
		if (contentHash === row.contentHash) {
			// Unchanged since it was last indexed (a rebuild re-queued it): its vectors are still correct.
			alreadyCurrent.push(row);
			continue;
		}
		const vectorKey = row.vectorKey ?? (await vectorKeyFor(message.id));
		prepared.push({
			messageId: message.id,
			mailboxId,
			vectorKey,
			texts,
			contentHash,
			oldChunkCount: row.chunkCount,
			backfill: isBackfillClaim(row.queuedAt, now),
		});
	}

	if (toSkip.length > 0) await markSkipped(env, toSkip);
	if (alreadyCurrent.length > 0) {
		await getDb(env)
			.update(messageEmbeddings)
			.set({ status: "indexed", leaseUntil: null, indexedAt: now })
			.where(
				inArray(
					messageEmbeddings.messageId,
					alreadyCurrent.map((row) => row.messageId),
				),
			);
	}

	// Charged to separate ai_usage sources, so the backfill's own spend can be capped at its install-cap share
	// (B6) without ever throttling a live, just-delivered message, which always classifies as "live" here.
	const liveItems = prepared.filter((item) => !item.backfill);
	const backfillItems = prepared.filter((item) => item.backfill);
	if (liveItems.length > 0) await embedAndUpsert(env, liveItems, claimed, now, toFail, "embedding");
	if (backfillItems.length > 0) {
		// Re-checked fresh, not the pre-claim `backfillCapped` above: this is the one point that actually spends, and
		// the cap may have been reached while bodies were loading and the embedding call was made.
		if (await backfillCapReached(env, settings.backfillCapShare)) {
			// Give these back to pending rather than spending past the backfill's own share; a later tick (a new
			// UTC day, or live spend settling lower than its estimate) may have room again.
			await getDb(env)
				.update(messageEmbeddings)
				.set({ status: "pending", leaseUntil: null })
				.where(
					inArray(
						messageEmbeddings.messageId,
						backfillItems.map((item) => item.messageId),
					),
				);
		} else {
			await embedAndUpsert(env, backfillItems, claimed, now, toFail, "embedding_backfill");
		}
	}
	if (toFail.length > 0) await applyFailures(env, toFail);

	// A message can be deleted while its own embedding call is still in flight (above), leaving a fresh
	// tombstone this same run should still clear rather than waiting for the next one.
	await drainDeleteTombstones(env);
	return { claimed: claimed.length };
}

async function embedAndUpsert(
	env: CloudflareEnv,
	prepared: PreparedChunk[],
	claimed: ClaimedRow[],
	now: Date,
	toFail: { messageId: string; attempts: number; code: string }[],
	source: "embedding" | "embedding_backfill",
): Promise<void> {
	let provider: Awaited<ReturnType<typeof getEmbeddingProvider>>;
	try {
		provider = await getEmbeddingProvider(env);
	} catch (error) {
		const code = error instanceof EmbeddingProviderUnavailableError ? "no_provider" : embeddingErrorCode(error);
		for (const item of prepared)
			toFail.push({ messageId: item.messageId, attempts: claimAttempts(claimed, item.messageId), code });
		return;
	}
	const allTexts = prepared.flatMap((item) => item.texts);
	const promptChars = allTexts.reduce((sum, text) => sum + text.length, 0);
	const reservation = await reserveEmbeddingBatchSpend(env, provider.kind, promptChars, source);
	if (!reservation) {
		// No budget left: release the claim so another run (with room under the cap) can pick these up.
		await getDb(env)
			.update(messageEmbeddings)
			.set({ status: "pending", leaseUntil: null })
			.where(
				inArray(
					messageEmbeddings.messageId,
					prepared.map((item) => item.messageId),
				),
			);
		return;
	}
	let vectors: Float32Array[];
	try {
		const embedded = await provider.embedTexts(allTexts);
		vectors = embedded.vectors;
		await settleEmbeddingSpend(env, reservation, { inputTokens: embedded.inputTokens });
	} catch (error) {
		const code = embeddingErrorCode(error);
		await settleEmbeddingSpend(env, reservation, { failed: code });
		for (const item of prepared)
			toFail.push({ messageId: item.messageId, attempts: claimAttempts(claimed, item.messageId), code });
		return;
	}
	// The embedding call succeeded and its spend is settled: a vector-store error from here on is not a provider
	// failure, and must neither settle the spend again nor fail rows already written (`done`).
	const done = new Set<string>();
	try {
		let cursor = 0;
		const store = getVectorStore(env);
		const stillRunning = await rowsStillRunning(
			env,
			prepared.map((item) => item.messageId),
		);
		for (const item of prepared) {
			const itemVectors = item.texts.map(() => vectors[cursor++]);
			if (!stillRunning.has(item.messageId)) continue; // deleted while the call was in flight; nothing to write.
			await store.upsert(
				itemVectors.map((values, chunk) => ({
					id: chunkVectorId(item.vectorKey, chunk),
					values,
					mailboxId: item.mailboxId,
				})),
			);
			// The message now needs fewer chunks than it did the last time it was indexed: the extra old ones are
			// gone from the store, not just left stale (never returned by a query, but no point keeping them).
			if (item.oldChunkCount > itemVectors.length) {
				const shrunk = Array.from(
					{ length: item.oldChunkCount - itemVectors.length },
					(_, index) => itemVectors.length + index,
				).map((chunk) => chunkVectorId(item.vectorKey, chunk));
				await store.deleteByIds(shrunk);
			}
			// Guarded by `status = 'running'` (S1 of review round 2): a clear between the `rowsStillRunning` check
			// above and this write (the loop awaits one upsert per message, so the window can be seconds) marks the
			// row `skipped` before this runs, so the condition matches nothing — the vectors just written for an
			// excluded or No-AI mailbox are then deleted again rather than left orphaned in the store.
			const written = await getDb(env)
				.update(messageEmbeddings)
				.set({
					status: "indexed",
					vectorKey: item.vectorKey,
					chunkCount: itemVectors.length,
					contentHash: item.contentHash,
					model: provider.model,
					error: null,
					leaseUntil: null,
					indexedAt: now,
				})
				.where(and(eq(messageEmbeddings.messageId, item.messageId), eq(messageEmbeddings.status, "running")))
				.returning({ messageId: messageEmbeddings.messageId });
			if (written.length === 0)
				await store.deleteByIds(itemVectors.map((_, chunk) => chunkVectorId(item.vectorKey, chunk)));
			done.add(item.messageId);
		}
	} catch (error) {
		const code = embeddingErrorCode(error);
		for (const item of prepared)
			if (!done.has(item.messageId))
				toFail.push({ messageId: item.messageId, attempts: claimAttempts(claimed, item.messageId), code });
	}
}

function claimAttempts(claimed: ClaimedRow[], messageId: string): number {
	return claimed.find((row) => row.messageId === messageId)?.attempts ?? 0;
}

/** Rows still `running` (not deleted, not reclaimed by another lease) just before vectors are written. */
async function rowsStillRunning(env: CloudflareEnv, messageIds: string[]): Promise<Set<string>> {
	if (messageIds.length === 0) return new Set();
	const rows = await getDb(env)
		.select({ messageId: messageEmbeddings.messageId })
		.from(messageEmbeddings)
		.where(and(inArray(messageEmbeddings.messageId, messageIds), eq(messageEmbeddings.status, "running")));
	return new Set(rows.map((row) => row.messageId));
}

async function applyFailures(
	env: CloudflareEnv,
	failures: { messageId: string; attempts: number; code: string }[],
): Promise<void> {
	const db = getDb(env);
	for (const failure of failures) {
		const attempts = failure.attempts + 1;
		if (attempts >= MAX_ATTEMPTS) {
			await db
				.update(messageEmbeddings)
				.set({ status: "failed", attempts, leaseUntil: null, error: failure.code })
				.where(and(eq(messageEmbeddings.messageId, failure.messageId), eq(messageEmbeddings.status, "running")));
		} else {
			await db
				.update(messageEmbeddings)
				.set({ status: "pending", attempts, leaseUntil: null })
				.where(and(eq(messageEmbeddings.messageId, failure.messageId), eq(messageEmbeddings.status, "running")));
		}
	}
}

/**
 * Drains up to `TOMBSTONE_BATCH_SIZE` delete tombstones, removing their vectors from the store. Ordered by `id`,
 * not `created_at`, so the page's rows are exactly "every row up to the highest one read": the delete can bind a
 * single maximum id rather than a cursor per row, which no longer grows past D1's 100-parameter limit however
 * large `TOMBSTONE_BATCH_SIZE` is (R3 of review round 2: a page of more than 100 tombstones used to bind one
 * parameter per row and fail the delete outright, retrying the same page forever and, since B2 drains tombstones
 * first, stopping the whole batch).
 *
 * `id` is `AUTOINCREMENT` (S-A of review round 3), which is what makes the range delete safe against two
 * overlapping drains (the cron runs several batches, every `search.embed` queue message runs one, and inbound mail
 * and sends each queue one, so overlap is normal): a plain rowid is reused once the table empties, so a tombstone
 * a second delete inserted after this query already ran, but before this delete executes, could land at an id at
 * or below `maxId` and be dropped here undrained, leaking its vectors. `AUTOINCREMENT` never reuses an id, so a
 * freshly inserted tombstone's id is always higher than the top of any page already read, whatever the table's
 * current size.
 *
 * Quiet, not just caught by the caller, before migration 0099 (S5 of review round 2): `worker.ts` and
 * `scheduler.ts` call this directly from cron, every tick, on every install (the feature is off by default), so
 * logging the missing table as an error there would be permanent noise rather than a one-time thing.
 */
export async function drainDeleteTombstones(env: CloudflareEnv): Promise<void> {
	try {
		const { results } = await env.DB.prepare(
			`SELECT id AS cursor, vector_key AS vectorKey, chunk_count AS chunkCount FROM message_embedding_deletes ORDER BY id LIMIT ?`,
		)
			.bind(TOMBSTONE_BATCH_SIZE)
			.all<{ cursor: number; vectorKey: string | null; chunkCount: number }>();
		if (results.length === 0) return;
		const ids = results.flatMap((row) =>
			row.vectorKey && row.chunkCount > 0
				? Array.from({ length: row.chunkCount }, (_, chunk) => chunkVectorId(row.vectorKey!, chunk))
				: [],
		);
		if (ids.length > 0) {
			try {
				await getVectorStore(env).deleteByIds(ids);
			} catch (error) {
				if (!(error instanceof Error) || error.name !== "VectorStoreUnavailableError") throw error;
				return; // Nothing configured yet: leave the tombstones for a later run.
			}
		}
		const maxId = results[results.length - 1].cursor;
		await env.DB.prepare(`DELETE FROM message_embedding_deletes WHERE id <= ?`).bind(maxId).run();
	} catch (error) {
		if (isNoSuchTableError(error)) return; // Migration 0099 not applied yet.
		throw error;
	}
}

/** Runs up to `maxBatches` drain batches, stopping early once a batch claims nothing (cron: 4 on Workers, 2 on Node). */
export async function runEmbeddingDrainBatches(env: CloudflareEnv, maxBatches: number): Promise<void> {
	for (let index = 0; index < maxBatches; index++) {
		try {
			const { claimed } = await processEmbeddingBatch(env);
			if (claimed === 0) return;
		} catch (error) {
			if (isNoSuchTableError(error)) return; // Migration 0099 not applied yet.
			throw error;
		}
	}
}

/**
 * Cheap and idempotent: the claim makes a duplicate message a no-op. Sent after `processInboundMessage` and
 * `sendEmail` store a message, so new mail is searchable without waiting for the next cron tick.
 */
export async function triggerEmbeddingDrain(env: CloudflareEnv): Promise<void> {
	if (!env.AGENT_QUEUE) return;
	try {
		if (!(await getSemanticInstallSettings(env)).enabled) return;
	} catch (error) {
		if (isNoSuchTableError(error)) return;
		throw error;
	}
	await env.AGENT_QUEUE.send({ kind: "search.embed" });
}

export function isSearchEmbedMessage(body: unknown): body is { kind: "search.embed" } {
	return typeof body === "object" && body !== null && (body as { kind?: unknown }).kind === "search.embed";
}

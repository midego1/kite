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
import { reserveEmbeddingBatchSpend, settleEmbeddingSpend } from "./spend";
import { getVectorStore } from "./vector-store";

/** Up to this many `pending` (or lease-expired `running`) rows are claimed per drain batch. */
const CLAIM_BATCH_SIZE = 32;
/** How long a claim holds a row before another drain may reclaim it. */
const LEASE_MS = 5 * 60_000;
/** A provider error is retried up to this many times before the row is `failed`. */
const MAX_ATTEMPTS = 3;
/** At most this many tombstones are drained per run. */
const TOMBSTONE_BATCH_SIZE = 1_000;

type ClaimedRow = {
	messageId: string;
	mailboxId: string | null;
	vectorKey: string | null;
	contentHash: string | null;
	chunkCount: number;
	attempts: number;
};

/** Claims up to `CLAIM_BATCH_SIZE` rows, newest queued first, so new mail is searchable before old mail is. */
async function claimPendingRows(env: CloudflareEnv, now: Date): Promise<ClaimedRow[]> {
	const leaseUntil = Math.floor((now.getTime() + LEASE_MS) / 1000);
	const nowSeconds = Math.floor(now.getTime() / 1000);
	const { results } = await env.DB.prepare(
		`UPDATE message_embeddings
		SET status = 'running', lease_until = ?
		WHERE message_id IN (
			SELECT message_id FROM message_embeddings
			WHERE status = 'pending' OR (status = 'running' AND lease_until < ?)
			ORDER BY queued_at DESC
			LIMIT ?
		)
		RETURNING message_id AS messageId, mailbox_id AS mailboxId, vector_key AS vectorKey, content_hash AS contentHash, chunk_count AS chunkCount, attempts`,
	)
		.bind(leaseUntil, nowSeconds, CLAIM_BATCH_SIZE)
		.all<ClaimedRow>();
	return results;
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
	const claimed = await claimPendingRows(env, now);
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
		prepared.push({ messageId: message.id, mailboxId, vectorKey, texts, contentHash, oldChunkCount: row.chunkCount });
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

	if (prepared.length > 0) await embedAndUpsert(env, prepared, claimed, now, toFail);
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
	const reservation = await reserveEmbeddingBatchSpend(env, provider.kind, promptChars);
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
	try {
		const { vectors, inputTokens } = await provider.embedTexts(allTexts);
		await settleEmbeddingSpend(env, reservation, { inputTokens });
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
			await getDb(env)
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
				.where(eq(messageEmbeddings.messageId, item.messageId));
		}
	} catch (error) {
		const code = embeddingErrorCode(error);
		await settleEmbeddingSpend(env, reservation, { failed: code });
		for (const item of prepared)
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
				.where(eq(messageEmbeddings.messageId, failure.messageId));
		} else {
			await db
				.update(messageEmbeddings)
				.set({ status: "pending", attempts, leaseUntil: null })
				.where(eq(messageEmbeddings.messageId, failure.messageId));
		}
	}
}

/** Drains up to `TOMBSTONE_BATCH_SIZE` delete tombstones, removing their vectors from the store. */
export async function drainDeleteTombstones(env: CloudflareEnv): Promise<void> {
	const { results } = await env.DB.prepare(
		`SELECT rowid AS cursor, vector_key AS vectorKey, chunk_count AS chunkCount FROM message_embedding_deletes ORDER BY created_at LIMIT ?`,
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
	const cursors = results.map((row) => row.cursor);
	const placeholders = cursors.map(() => "?").join(", ");
	await env.DB.prepare(`DELETE FROM message_embedding_deletes WHERE rowid IN (${placeholders})`)
		.bind(...cursors)
		.run();
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

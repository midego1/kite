import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, spamFeedback } from "@/db/schema";
import { spamReportReceipts } from "@/db/schema/spam-reports";
import { agentSuggestions } from "@/db/schema/agent-auto-read";
import { notifySuggestionsQuietly } from "@/lib/agent/auto-read/suggestion-events";
import { unblockContact } from "@/lib/contacts/service";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { chunkArray } from "@/db/chunk-utils";
import type { NewSpamReceipt, ReceiptExtras, ReceiptUndoResult } from "./report-receipts-types";
import { trainingStatements } from "./training";
import type { ReputationKey, SpamClassification } from "./types";

/** Receipts are kept as long as the assistant's other undo window. */
export const RECEIPT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function parseList<T>(value: string): T[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

function parseExtras(value: string): ReceiptExtras {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === "object" ? (parsed as ReceiptExtras) : {};
	} catch {
		return {};
	}
}

/** The tokens and reputation keys that have no row yet, which the report is about to create. */
export async function findMissingRows(
	env: CloudflareEnv,
	mailboxId: string,
	tokens: readonly string[],
	keys: readonly ReputationKey[],
): Promise<{ tokens: string[]; keys: ReputationKey[] }> {
	const existingTokens = new Set<string>();
	for (const chunk of chunkArray([...new Set(tokens)], 90)) {
		const { results } = await env.DB.prepare(
			`SELECT token FROM spam_token_stats WHERE mailbox_id = ? AND token IN (${chunk.map(() => "?").join(", ")})`,
		)
			.bind(mailboxId, ...chunk)
			.all<{ token: string }>();
		for (const row of results) existingTokens.add(row.token);
	}
	const missingKeys: ReputationKey[] = [];
	for (const item of keys) {
		const row = await env.DB.prepare(
			"SELECT 1 AS present FROM spam_reputation WHERE mailbox_id = ? AND type = ? AND key = ?",
		)
			.bind(mailboxId, item.type, item.key)
			.first();
		if (!row) missingKeys.push(item);
	}
	return { tokens: [...new Set(tokens)].filter((token) => !existingTokens.has(token)), keys: missingKeys };
}

/**
 * Records a receipt. Returns null, and never throws, when the table is missing or the write fails: the report
 * already happened, and a lost receipt only means its training cannot be undone.
 */
export async function saveReceipt(env: CloudflareEnv, receipt: NewSpamReceipt): Promise<string | null> {
	const id = crypto.randomUUID();
	const db = getDb(env);
	try {
		await db.insert(spamReportReceipts).values({
			id,
			messageId: receipt.messageId,
			mailboxId: receipt.mailboxId,
			actorUserId: receipt.actorUserId,
			classification: receipt.classification,
			previousClassification: receipt.previousClassification,
			trained: receipt.trained,
			createdTokens: JSON.stringify(receipt.createdTokens),
			createdKeys: JSON.stringify(receipt.createdKeys),
			previousStatus: receipt.previousStatus,
			previousFolderId: receipt.previousFolderId,
			extras: JSON.stringify(receipt.extras),
			createdAt: new Date(),
		});
		await db
			.delete(spamReportReceipts)
			.where(lt(spamReportReceipts.createdAt, new Date(Date.now() - RECEIPT_WINDOW_MS)));
		return id;
	} catch (error) {
		if (!isNoSuchTableError(error))
			console.error("spam.receipt_failed", error instanceof Error ? error.message : error);
		return null;
	}
}

/** Adds what a phishing report did beyond training to its receipt. */
export async function addReceiptExtras(
	env: CloudflareEnv,
	receiptId: string | null,
	extras: ReceiptExtras,
): Promise<void> {
	if (!receiptId) return;
	const db = getDb(env);
	const [row] = await db
		.select({ extras: spamReportReceipts.extras })
		.from(spamReportReceipts)
		.where(eq(spamReportReceipts.id, receiptId))
		.limit(1);
	if (!row) return;
	await db
		.update(spamReportReceipts)
		.set({ extras: JSON.stringify({ ...parseExtras(row.extras), ...extras }) })
		.where(eq(spamReportReceipts.id, receiptId));
}

type Receipt = typeof spamReportReceipts.$inferSelect;

/**
 * The token and reputation rows that a report in this mailbox created, limited to this message's own tokens
 * and keys: only those can reach zero when it is undone.
 */
async function rowsCreatedByReceipts(
	env: CloudflareEnv,
	receipt: Receipt,
): Promise<{ tokens: Set<string>; keys: Set<string> }> {
	const { results } = await env.DB.prepare(
		"SELECT created_tokens, created_keys FROM spam_report_receipts WHERE mailbox_id = ?",
	)
		.bind(receipt.mailboxId)
		.all<{ created_tokens: string; created_keys: string }>();
	const tokens = new Set<string>();
	const keys = new Set<string>();
	for (const row of results) {
		for (const token of parseList<string>(row.created_tokens)) tokens.add(token);
		for (const item of parseList<ReputationKey>(row.created_keys)) keys.add(`${item.type}\u0000${item.key}`);
	}
	return { tokens, keys };
}

/** The statements that take back what the report trained, or none when a later change already replaced it. */
async function trainingReversal(
	env: CloudflareEnv,
	receipt: Receipt,
	extras: ReceiptExtras,
	now: number,
): Promise<D1PreparedStatement[]> {
	const [feedback] = await getDb(env)
		.select()
		.from(spamFeedback)
		.where(eq(spamFeedback.messageId, receipt.messageId))
		.limit(1);
	// A later report or "Not spam" already changed the training; undoing this one on top would count twice.
	if (!receipt.trained || feedback?.classification !== receipt.classification) return [];
	const tokens = parseList<string>(feedback.trainingTokens);
	const keys = parseList<ReputationKey>(feedback.reputationKeys);
	const statements = trainingStatements(env, receipt.mailboxId, tokens, keys, receipt.classification, -1, now);
	const previous: SpamClassification | null = receipt.previousClassification;
	if (previous) {
		statements.push(...trainingStatements(env, receipt.mailboxId, tokens, keys, previous, 1, now));
		statements.push(
			env.DB.prepare(
				"UPDATE spam_feedback SET classification = ?, actor_user_id = ?, updated_at = ? WHERE message_id = ?",
			).bind(previous, extras.previousActor ?? feedback.actorUserId, now, receipt.messageId),
		);
	} else {
		statements.push(env.DB.prepare("DELETE FROM spam_feedback WHERE message_id = ?").bind(receipt.messageId));
	}
	// A row this or another report created is removed once nothing is left on it; an overlapping report
	// (the same words in a second message of a bulk report) may be undone before or after this one.
	const owned = await rowsCreatedByReceipts(env, receipt);
	for (const token of tokens.filter((candidate) => owned.tokens.has(candidate)))
		statements.push(
			env.DB.prepare(
				"DELETE FROM spam_token_stats WHERE mailbox_id = ? AND token = ? AND spam_count = 0 AND ham_count = 0",
			).bind(receipt.mailboxId, token),
		);
	for (const item of keys.filter((candidate) => owned.keys.has(`${candidate.type}\u0000${candidate.key}`)))
		statements.push(
			env.DB.prepare(
				"DELETE FROM spam_reputation WHERE mailbox_id = ? AND type = ? AND key = ? AND spam_count = 0 AND ham_count = 0",
			).bind(receipt.mailboxId, item.type, item.key),
		);
	return statements;
}

/** Puts the message back where it was, only while it is still where the report left it; a later move wins. */
async function locationRestore(env: CloudflareEnv, receipt: Receipt): Promise<D1PreparedStatement> {
	const [folder] = receipt.previousFolderId
		? await getDb(env)
				.select({ id: folders.id })
				.from(folders)
				.where(and(eq(folders.id, receipt.previousFolderId), eq(folders.mailboxId, receipt.mailboxId)))
				.limit(1)
		: [];
	return env.DB.prepare(
		"UPDATE messages SET status = ?, folder_id = ? WHERE id = ? AND mailbox_id = ? AND status = ?",
	).bind(
		receipt.previousStatus,
		folder?.id ?? null,
		receipt.messageId,
		receipt.mailboxId,
		receipt.classification === "ham" ? "received" : "spam",
	);
}

/** Lifts the block this report placed and reopens the warnings it closed. */
async function reverseExtras(env: CloudflareEnv, extras: ReceiptExtras): Promise<void> {
	if (extras.block) await unblockContact(env, extras.block);
	if (!extras.closedSuggestionIds?.length) return;
	const reopened = await getDb(env)
		.update(agentSuggestions)
		.set({ status: "open", decidedAt: null, decidedByUserId: null })
		.where(and(inArray(agentSuggestions.id, extras.closedSuggestionIds), eq(agentSuggestions.status, "accepted")))
		.returning({ id: agentSuggestions.id });
	if (reopened.length > 0)
		await notifySuggestionsQuietly(
			env,
			reopened.map((row) => row.id),
		);
}

/** Takes back the training, the place and the phishing extras of one receipt; a second call changes nothing. */
async function undoReceipt(
	env: CloudflareEnv,
	receipt: Receipt,
	options: { restoreLocation: boolean },
): Promise<ReceiptUndoResult> {
	const db = getDb(env);
	if (receipt.undoneAt || receipt.createdAt.getTime() < Date.now() - RECEIPT_WINDOW_MS) return "already_undone";
	// Claiming first makes a second undo, however it arrives, a no-op.
	const claimed = await db
		.update(spamReportReceipts)
		.set({ undoneAt: new Date() })
		.where(and(eq(spamReportReceipts.id, receipt.id), isNull(spamReportReceipts.undoneAt)))
		.returning({ id: spamReportReceipts.id });
	if (claimed.length === 0) return "already_undone";

	const extras = parseExtras(receipt.extras);
	try {
		const statements = await trainingReversal(env, receipt, extras, Math.floor(Date.now() / 1000));
		if (options.restoreLocation) statements.push(await locationRestore(env, receipt));
		// One atomic batch: it either takes back all of the training and the place or none, so the claim can be released.
		if (statements.length > 0) await env.DB.batch(statements);
	} catch (error) {
		await db.update(spamReportReceipts).set({ undoneAt: null }).where(eq(spamReportReceipts.id, receipt.id));
		throw error;
	}
	// Past the batch the training is gone for good, so the claim stays even if these fail.
	await reverseExtras(env, extras);
	return "undone";
}

/** Undo of one report from its Undo toast: the receipt must belong to the message the caller named. */
export async function undoSpamReceipt(
	env: CloudflareEnv,
	messageId: string,
	receiptId: string,
	options: { restoreLocation: boolean } = { restoreLocation: true },
): Promise<ReceiptUndoResult> {
	let receipt: Receipt | undefined;
	try {
		[receipt] = await getDb(env)
			.select()
			.from(spamReportReceipts)
			.where(and(eq(spamReportReceipts.id, receiptId), eq(spamReportReceipts.messageId, messageId)))
			.limit(1);
	} catch (error) {
		if (isNoSuchTableError(error)) return "missing";
		throw error;
	}
	return receipt ? undoReceipt(env, receipt, options) : "missing";
}

/**
 * Undo of a move to or out of Spam that was not started from a toast (an approved chat move, Mark as spam on a
 * phishing warning): takes back the newest report the message got since `since`. The caller has put the place
 * back already.
 */
export async function undoLatestSpamReceipt(
	env: CloudflareEnv,
	messageId: string,
	direction: "to_spam" | "from_spam",
	since: Date,
): Promise<ReceiptUndoResult> {
	let receipt: Receipt | undefined;
	try {
		[receipt] = await getDb(env)
			.select()
			.from(spamReportReceipts)
			.where(
				and(
					eq(spamReportReceipts.messageId, messageId),
					isNull(spamReportReceipts.undoneAt),
					gte(spamReportReceipts.createdAt, since),
					direction === "to_spam"
						? inArray(spamReportReceipts.classification, ["spam", "phishing"])
						: eq(spamReportReceipts.classification, "ham"),
				),
			)
			.orderBy(desc(spamReportReceipts.createdAt))
			.limit(1);
	} catch (error) {
		if (isNoSuchTableError(error)) return "missing";
		throw error;
	}
	return receipt ? undoReceipt(env, receipt, { restoreLocation: false }) : "missing";
}

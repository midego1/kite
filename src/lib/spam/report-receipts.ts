import { and, eq, inArray, lt } from "drizzle-orm";
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
 * already happened, and a lost receipt only means its training cannot be undone. Old receipts are pruned
 * separately, so a failed prune cannot lose this one.
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
	} catch (error) {
		if (!isNoSuchTableError(error))
			console.error("spam.receipt_failed", error instanceof Error ? error.message : error);
		return null;
	}
	try {
		await db
			.delete(spamReportReceipts)
			.where(lt(spamReportReceipts.createdAt, new Date(Date.now() - RECEIPT_WINDOW_MS)));
	} catch (error) {
		console.error("spam.receipt_prune_failed", error instanceof Error ? error.message : error);
	}
	return id;
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
		"SELECT created_tokens, created_keys FROM spam_report_receipts WHERE mailbox_id = ? AND created_at >= ?",
	)
		.bind(receipt.mailboxId, Math.floor((Date.now() - RECEIPT_WINDOW_MS) / 1000))
		.all<{ created_tokens: string; created_keys: string }>();
	const tokens = new Set<string>();
	const keys = new Set<string>();
	for (const row of results) {
		for (const token of parseList<string>(row.created_tokens)) tokens.add(token);
		for (const item of parseList<ReputationKey>(row.created_keys)) keys.add(`${item.type}\u0000${item.key}`);
	}
	return { tokens, keys };
}

type Plan = {
	statements: D1PreparedStatement[];
	/** The feedback row the training statements assume; the batch fails when it changed in between. */
	expectedFeedback: { classification: SpamClassification; updatedAt: number } | null;
};

/** The statements that take back what the report trained, or none when the training was replaced by something else. */
async function trainingReversal(
	env: CloudflareEnv,
	receipt: Receipt,
	extras: ReceiptExtras,
	now: number,
): Promise<Plan> {
	const none: Plan = { statements: [], expectedFeedback: null };
	const [feedback] = await getDb(env)
		.select()
		.from(spamFeedback)
		.where(eq(spamFeedback.messageId, receipt.messageId))
		.limit(1);
	if (!receipt.trained || feedback?.classification !== receipt.classification) return none;
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
	return {
		statements,
		expectedFeedback: {
			classification: feedback.classification,
			updatedAt: Math.floor(feedback.updatedAt.getTime() / 1000),
		},
	};
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

/** SQL for "a newer report on this message that trained the filter has not been undone", for receipt `?`. */
const NEWER_TRAINED_RECEIPT = `EXISTS (SELECT 1 FROM spam_report_receipts newer WHERE newer.message_id = ? AND newer.undone_at IS NULL AND newer.trained = 1 AND newer.rowid > (SELECT rowid FROM spam_report_receipts WHERE id = ?))`;

async function hasNewerTrainedReceipt(env: CloudflareEnv, receipt: Receipt): Promise<boolean> {
	const row = await env.DB.prepare(`SELECT ${NEWER_TRAINED_RECEIPT} AS newer`)
		.bind(receipt.messageId, receipt.id)
		.first<{ newer: number }>();
	return !!row?.newer;
}

/**
 * The first statement of the undo batch. SQLite has no assert, so it evaluates `json()` of a value that is only
 * valid JSON while the undo may still run: this receipt not yet undone, no newer trained report standing, and the
 * feedback row as it was read. Otherwise the statement fails and the whole batch rolls back, which makes the
 * check and the writes one atomic step even if a report or another undo lands in between.
 */
function guardStatement(env: CloudflareEnv, receipt: Receipt, plan: Plan): D1PreparedStatement {
	const conditions = ["EXISTS (SELECT 1 FROM spam_report_receipts WHERE id = ? AND undone_at IS NULL)"];
	const binds: unknown[] = [receipt.id];
	if (receipt.trained) {
		conditions.push(`NOT ${NEWER_TRAINED_RECEIPT}`);
		binds.push(receipt.messageId, receipt.id);
	}
	if (plan.expectedFeedback) {
		conditions.push(
			"EXISTS (SELECT 1 FROM spam_feedback WHERE message_id = ? AND classification = ? AND updated_at = ?)",
		);
		binds.push(receipt.messageId, plan.expectedFeedback.classification, plan.expectedFeedback.updatedAt);
	}
	return env.DB.prepare(`SELECT json(CASE WHEN ${conditions.join(" AND ")} THEN '{}' ELSE 'refused' END)`).bind(
		...binds,
	);
}

/** Lifts what blocking the sender added, but only the parts this report added, and reopens the warnings it closed. */
async function reverseExtras(env: CloudflareEnv, extras: ReceiptExtras): Promise<void> {
	if (extras.block)
		await unblockContact(env, extras.block, {
			removeRule: extras.block.ruleCreated,
			clearContact: !extras.block.contactWasBlocked,
		});
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

const hasPendingExtras = (extras: ReceiptExtras) => !!extras.block || !!extras.closedSuggestionIds?.length;

/** Reverses the extras and, once that worked, forgets them; a failure is logged and leaves them for a retry. */
async function finishExtras(env: CloudflareEnv, receipt: Receipt, extras: ReceiptExtras): Promise<void> {
	try {
		await reverseExtras(env, extras);
		await getDb(env)
			.update(spamReportReceipts)
			.set({ extras: JSON.stringify({ previousActor: extras.previousActor }) })
			.where(eq(spamReportReceipts.id, receipt.id));
	} catch (error) {
		console.error("spam.undo_extras_failed", receipt.id, error instanceof Error ? error.message : error);
		throw error;
	}
}

/** Why the guard refused the batch: the receipt was undone meanwhile, or a newer report stands. */
async function refusalOf(env: CloudflareEnv, receipt: Receipt): Promise<ReceiptUndoResult> {
	const [current] = await getDb(env)
		.select({ undoneAt: spamReportReceipts.undoneAt })
		.from(spamReportReceipts)
		.where(eq(spamReportReceipts.id, receipt.id))
		.limit(1);
	return current?.undoneAt ? "already_undone" : "superseded";
}

/**
 * Takes back the training, the place and the phishing extras of one receipt; a second call changes nothing.
 * A receipt a newer trained report stands on is left untouched ("superseded") so it can run once that one is undone.
 * The claim (`undone_at`) is written by the same atomic batch as the training, never before it.
 */
async function undoReceipt(
	env: CloudflareEnv,
	receipt: Receipt,
	options: { restoreLocation: boolean },
): Promise<ReceiptUndoResult> {
	if (receipt.createdAt.getTime() < Date.now() - RECEIPT_WINDOW_MS) return "already_undone";
	const extras = parseExtras(receipt.extras);
	if (receipt.undoneAt) {
		// The training is gone already; only extras a failed attempt left behind are still to do.
		if (!hasPendingExtras(extras)) return "already_undone";
		await finishExtras(env, receipt, extras);
		return "undone";
	}
	if (receipt.trained && (await hasNewerTrainedReceipt(env, receipt))) return "superseded";

	const plan = await trainingReversal(env, receipt, extras, Math.floor(Date.now() / 1000));
	const statements = [
		guardStatement(env, receipt, plan),
		env.DB.prepare("UPDATE spam_report_receipts SET undone_at = ? WHERE id = ? AND undone_at IS NULL").bind(
			Math.floor(Date.now() / 1000),
			receipt.id,
		),
		...plan.statements,
	];
	if (options.restoreLocation) statements.push(await locationRestore(env, receipt));
	try {
		await env.DB.batch(statements);
	} catch (error) {
		if (/malformed JSON/i.test(error instanceof Error ? error.message : String(error))) return refusalOf(env, receipt);
		throw error;
	}
	if (hasPendingExtras(extras)) await finishExtras(env, receipt, extras);
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

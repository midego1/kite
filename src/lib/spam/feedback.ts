import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, spamFeedback } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { buildFingerprint, prepareSpamContent, tokenizeMessage } from "./tokenizer";
import { getReputationKeys } from "./analyzers/reputation";
import type { ReputationKey, SpamClassification } from "./types";
import { findMissingRows, saveReceipt } from "./report-receipts";
import type { SpamFeedbackResult } from "./report-receipts-types";
import { trainingStatements } from "./training";
import { TOKENIZER_VERSION } from "./weights";

export async function applySpamFeedback(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	classification: SpamClassification,
): Promise<boolean> {
	return (await applySpamFeedbackWithReceipt(env, user, messageId, classification)) !== null;
}

/**
 * Records the classification, trains on it and files the message under it, and saves the receipt that
 * lets an undo take all of that back. Null when the message cannot be classified by this user.
 */
export async function applySpamFeedbackWithReceipt(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	classification: SpamClassification,
): Promise<SpamFeedbackResult | null> {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId || message.direction !== "inbound") return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canManage) return null;
	const [previous] = await db.select().from(spamFeedback).where(eq(spamFeedback.messageId, messageId)).limit(1);
	const status = classification === "ham" ? "received" : "spam";
	const place = { previousStatus: message.status, previousFolderId: message.folderId ?? null };
	if (previous?.classification === classification) {
		await db.update(messages).set({ status, folderId: null }).where(eq(messages.id, messageId));
		const receiptId = await saveReceipt(env, {
			messageId,
			mailboxId: message.mailboxId,
			actorUserId: user.id,
			classification,
			previousClassification: classification,
			trained: false,
			createdTokens: [],
			createdKeys: [],
			...place,
			extras: {},
		});
		return { receiptId, ...place };
	}

	const parsed = {
		subject: message.subject,
		text: message.textBody,
		html: message.htmlBody,
		messageId: message.providerMessageId,
		fromAddr: message.fromAddr,
		toAddr: message.toAddr,
		ccAddr: message.ccAddr,
		bccAddr: message.bccAddr,
		inReplyTo: message.inReplyTo,
		references: message.references?.split(/\s+/).filter(Boolean) ?? [],
		date: message.createdAt,
		attachments: [],
	};
	const prepared = prepareSpamContent(parsed);
	const tokens = previous ? (JSON.parse(previous.trainingTokens) as string[]) : tokenizeMessage(parsed, prepared);
	const keys = previous
		? (JSON.parse(previous.reputationKeys) as ReputationKey[])
		: getReputationKeys(parsed, buildFingerprint(parsed, prepared));
	const now = Math.floor(Date.now() / 1000);
	const statements: D1PreparedStatement[] = [];
	const missing = await findMissingRows(env, message.mailboxId, tokens, keys);
	const addCounts = (target: SpamClassification, direction: 1 | -1) =>
		statements.push(...trainingStatements(env, message.mailboxId!, tokens, keys, target, direction, now));
	if (previous) addCounts(previous.classification, -1);
	addCounts(classification, 1);
	statements.push(
		env.DB.prepare(
			`INSERT INTO spam_feedback (message_id, mailbox_id, actor_user_id, classification, training_tokens, reputation_keys, tokenizer_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET actor_user_id = excluded.actor_user_id, classification = excluded.classification, updated_at = excluded.updated_at`,
		).bind(
			messageId,
			message.mailboxId,
			user.id,
			classification,
			JSON.stringify(tokens),
			JSON.stringify(keys),
			TOKENIZER_VERSION,
			now,
			now,
		),
	);
	statements.push(
		env.DB.prepare("UPDATE messages SET status = ?, folder_id = NULL WHERE id = ?").bind(status, messageId),
	);
	await env.DB.batch(statements);
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: message.mailboxId,
		messageId,
		action: "email.spam_feedback",
		metadata: { classification },
	});
	const receiptId = await saveReceipt(env, {
		messageId,
		mailboxId: message.mailboxId,
		actorUserId: user.id,
		classification,
		previousClassification: previous?.classification ?? null,
		trained: true,
		createdTokens: missing.tokens,
		createdKeys: missing.keys,
		...place,
		extras: { previousActor: previous?.actorUserId ?? null },
	});
	return { receiptId, ...place };
}

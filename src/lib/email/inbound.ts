import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { resolveInboundAddress } from "@/lib/email/routing";
import { getMessageContactNames } from "@/lib/contacts/service";
import { getEmailAddress } from "@/lib/email/address";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { listMessageAttachments } from "@/lib/email/attachments";
import { loadMessageBody } from "@/lib/email/bodies";
import { deliverInboundMessage, recoverAgentWork, storedFromRaw } from "@/lib/email/inbound-deliver";
import { processExternalInbound } from "@/lib/email/inbound-external";
import { getUnsubscribeUrlFromRawR2Key } from "@/lib/email/unsubscribe";
import type { SessionUser } from "@/lib/auth/types";
import { isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import { loadSendStates } from "@/lib/messages/send-state";

/** Mail a connected account's sync fetched (spec §6.4), with the flags it had at the source. */
export type InboundQueueSource = { kind: "external"; accountId: string; read: boolean; starred: boolean };

export type InboundQueueMessage = {
	from: string;
	to: string;
	rawR2Key: string;
	headers?: Record<string, string>;
	/**
	 * The `Authentication-Results` header the intake hop verified the message with, chosen at
	 * intake (`src/lib/spam/authentication-results-utils.ts`). Absent when no trusted hop checked
	 * the sender (the SMTP listener, an unsigned relay header map, Resend, SES): the copies in
	 * `headers` and the raw message are the sender's and never count.
	 */
	authenticationResults?: string | null;
	/**
	 * Set only by a connected account's sync: the message goes into that account's mailbox instead of through domain
	 * routing, and the account's preset decides which Authentication-Results counts.
	 */
	source?: InboundQueueSource;
};

/**
 * One inbound queue message. `finalAttempt` tells it the queue will not retry it again, so a failure can be recorded
 * where its owner sees it (a synced message's account).
 */
export async function processInboundMessage(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
	options: { finalAttempt?: boolean } = {},
): Promise<void> {
	if (payload.source?.kind === "external") {
		await processExternalInbound(env, payload, payload.source, options);
		return;
	}
	const db = getDb(env);
	// The sender is passed so that sender-based block rules resolve the same way here as they
	// do in the Worker email handler.
	const decision = await resolveInboundAddress(db, payload.to, payload.from);

	if (!decision) {
		console.warn(`No routing for inbound address: ${payload.to}`);
		return;
	}

	if (decision.action === "reject") {
		console.warn(`Rejected inbound: ${payload.to}`);
		return;
	}

	// A forward decision only reaches the queue when the rule keeps a copy; without a
	// destination mailbox there is nothing to store.
	if (decision.action === "forward" && !decision.keepCopy) {
		console.info(`Forward ${payload.to} -> ${decision.forwardTo}`);
		return;
	}

	if (!decision.mailbox) return;
	const target = { mailboxId: decision.mailbox.mailboxId, userId: decision.mailbox.userId };
	const stored = await storedFromRaw(env, target.mailboxId, payload.rawR2Key);
	if (stored) {
		await recoverAgentWork(env, target, stored, payload.headers);
		return;
	}

	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) {
		console.error(`Missing R2 object: ${payload.rawR2Key}`);
		return;
	}

	await deliverInboundMessage(env, {
		target,
		from: payload.from,
		to: payload.to,
		rawR2Key: payload.rawR2Key,
		raw: await raw.arrayBuffer(),
		deliveredAddress: getEmailAddress(payload.to) || `${decision.mailbox.localPart}@${decision.mailbox.hostname}`,
		headers: payload.headers,
		authenticationResults: payload.authenticationResults ?? null,
	});
}

export async function storeRawToR2(env: CloudflareEnv, from: string, to: string, raw: ArrayBuffer): Promise<string> {
	const key = `inbound/${Date.now()}-${newId()}.eml`;
	await env.BUCKET.put(key, raw, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { from, to },
	});
	return key;
}

export async function getMessageWithBody(env: CloudflareEnv, userId: string, messageId: string) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message || message.userId !== userId) return null;
	const contactNames = await getMessageContactNames(env, userId, message.fromAddr, message.toAddr);
	const attachments = await listMessageAttachments(env, messageId);
	const unsubscribeUrl = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	return { message: { ...message, ...contactNames }, body: message, attachments, unsubscribeUrl };
}

export async function getMessageWithBodyForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!row?.mailboxId || isHiddenDraft(row, user.id)) return null;
	const access = await getMailboxAccessLevel(db, user, row.mailboxId);
	if (!access?.canRead) return null;
	const message = await loadMessageBody(env, row);
	const contactNames = await getMessageContactNames(env, message.userId, message.fromAddr, message.toAddr);
	const attachments = await listMessageAttachments(env, messageId);
	const unsubscribeUrl = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	const sendState = (await loadSendStates(db, [message], user.id)).get(message.id);
	return {
		message: { ...message, ...contactNames, ...(sendState ? { sendState } : {}) },
		body: message,
		attachments,
		unsubscribeUrl,
	};
}

export async function getMessageMetadataForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select({
			mailboxId: messages.mailboxId,
			rawR2Key: messages.rawR2Key,
			status: messages.status,
			userId: messages.userId,
		})
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId || isHiddenDraft(message, user.id)) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const [attachments, unsubscribeUrl] = await Promise.all([
		listMessageAttachments(env, messageId),
		getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key),
	]);
	return { attachments, unsubscribeUrl };
}

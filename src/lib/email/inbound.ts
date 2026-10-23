import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { resolveInboundAddress, resolveInboxRuleDestination } from "@/lib/email/routing";
import type { ResolvedMailbox } from "@/lib/email/routing";
import type { ParsedEmail } from "@/lib/email/parse";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { getMessageContactNames, upsertContactFromAddress } from "@/lib/contacts/service";
import { getEmailAddress } from "@/lib/email/address";
import { sendMailboxAutoReply } from "@/lib/email/auto-reply";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { listMessageAttachments, storeMessageAttachments } from "@/lib/email/attachments";
import { inboundAttachmentLimitReason } from "@/lib/email/inbound-attachments";
import { inboundMessageId } from "@/lib/email/inbound-id";
import { extractOneTimeCode } from "@/lib/email/one-time-code-utils";
import { getLatestEmailContent, htmlToReadableText } from "@/lib/email/reply-content-utils";
import { getUnsubscribeUrlFromRawR2Key } from "@/lib/email/unsubscribe";
import { resolveThreadId } from "@/lib/email/threading";
import { normalizeMessageId } from "@/lib/email/thread-lookup";
import type { SessionUser } from "@/lib/auth/types";
import { analyzeSpam } from "@/lib/spam/engine";
import { configuredSpamIntelligenceProvider } from "@/lib/spam/providers/abuse-ch-key";
import { getReputationKeys } from "@/lib/spam/analyzers/reputation";
import { recordReputationObservation } from "@/lib/spam/repository";
import { getMailboxNotificationUserIds, notifyUsersOfNewMessage } from "@/lib/realtime/utils";
import type { NewMessageNotification } from "@/lib/realtime/types";
import { scheduleAgentWork } from "@/lib/agent/auto-read/schedule";
import { applyScreener } from "@/lib/screener/inbound";
import { screenerPendingRows } from "@/lib/screener/views";

export type InboundQueueMessage = {
	from: string;
	to: string;
	rawR2Key: string;
	headers?: Record<string, string>;
};

type InboundNotificationInput = {
	messageId: string;
	mailboxId: string;
	from: string;
	fromName: string | null;
	subject: string | null;
	text: string | null;
	html: string | null;
};

/**
 * Builds the realtime new-message payload. The one-time code is detected from
 * the latest (unquoted) parsed text for this event only: it is never stored in
 * a column and callers must not log it.
 */
function buildInboundNewMessageNotification(input: InboundNotificationInput): NewMessageNotification {
	let oneTimeCode: string | null = null;
	try {
		oneTimeCode = extractOneTimeCode({
			subject: input.subject,
			text: getLatestEmailContent(input.text?.trim() || htmlToReadableText(input.html)),
		});
	} catch {
		// The message is already stored; a detection failure must not fail delivery.
	}
	return {
		type: "new_message",
		messageId: input.messageId,
		mailboxId: input.mailboxId,
		from: input.from,
		fromName: input.fromName,
		subject: input.subject,
		...(oneTimeCode ? { oneTimeCode } : {}),
	};
}

/** A queue retry of a message that is already stored only needs its agent work scheduled again. */
async function recoverAgentWork(
	env: CloudflareEnv,
	mailbox: ResolvedMailbox,
	messageId: string,
	headers: Record<string, string> | undefined,
): Promise<void> {
	try {
		const db = getDb(env);
		const [existing] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
		if (!existing || (await screenerPendingRows(db, [existing])).has(existing.id)) return;
		await scheduleAgentWork(env, {
			mailboxId: mailbox.mailboxId,
			sourceMessageId: existing.id,
			ownerUserId: mailbox.userId,
			sender: existing.fromAddr,
			headers,
			status: existing.status,
			folderId: existing.folderId,
			spamVerdict: existing.spamVerdict,
			spamAnalysisError: existing.spamAnalysisError,
			recoveryReceivedAt: existing.createdAt,
		});
	} catch (error) {
		console.error("Agent work recovery failed", error);
	}
}

/** The auto-reply and the realtime notification for a freshly stored message. */
async function announceDelivery(
	env: CloudflareEnv,
	input: {
		mailbox: ResolvedMailbox;
		messageId: string;
		status: string;
		deliveredAddress: string;
		fromAddr: string;
		fromName: string | null;
		parsed: ParsedEmail;
		headers: Record<string, string> | undefined;
	},
): Promise<void> {
	const { mailbox, parsed } = input;
	if (input.status === "received") {
		try {
			await sendMailboxAutoReply(env, {
				mailboxId: mailbox.mailboxId,
				userId: mailbox.userId,
				deliveredAddress: input.deliveredAddress,
				fromAddress: input.fromAddr,
				incomingMessageId: parsed.messageId,
				headers: input.headers,
			});
		} catch (error) {
			console.error(`Auto-reply failed for mailbox ${mailbox.mailboxId}`, error);
		}
	}
	if (input.status === "spam") return;
	const notificationUserIds = await getMailboxNotificationUserIds(env, mailbox.mailboxId, mailbox.userId);
	await notifyUsersOfNewMessage(
		env,
		notificationUserIds,
		buildInboundNewMessageNotification({
			messageId: input.messageId,
			mailboxId: mailbox.mailboxId,
			from: input.fromAddr,
			fromName: input.fromName,
			subject: parsed.subject,
			text: parsed.text,
			html: parsed.html,
		}),
	);
}

export async function processInboundMessage(env: CloudflareEnv, payload: InboundQueueMessage): Promise<void> {
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
	const [stored] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(and(eq(messages.mailboxId, decision.mailbox.mailboxId), eq(messages.rawR2Key, payload.rawR2Key)))
		.limit(1);
	if (stored) {
		await recoverAgentWork(env, decision.mailbox, stored.id, payload.headers);
		return;
	}

	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) {
		console.error(`Missing R2 object: ${payload.rawR2Key}`);
		return;
	}

	const buffer = await raw.arrayBuffer();
	const parsed = await parseRawMime(buffer);
	const attachmentLimitReason = inboundAttachmentLimitReason(parsed.attachments);
	if (attachmentLimitReason) {
		console.warn(`Inbound attachment limit reached for ${payload.to}: ${attachmentLimitReason}`);
		await env.BUCKET.delete(payload.rawR2Key);
		return;
	}
	const messageId = await inboundMessageId(payload.rawR2Key);
	const snippet = buildSnippet(parsed.text, parsed.html);
	const deliveredAddress = getEmailAddress(payload.to) || `${decision.mailbox.localPart}@${decision.mailbox.hostname}`;
	// Keep the whole To header so reply-all can address everyone; rules and
	// webhooks still see the envelope recipient the message was delivered to.
	const toAddr = parsed.toAddr ?? payload.to;
	const fromAddr = parsed.fromAddr ?? payload.from;
	const destination = await resolveInboxRuleDestination(db, {
		mailboxId: decision.mailbox.mailboxId,
		toAddress: payload.to,
		fromAddress: fromAddr,
		subject: parsed.subject,
		content: [parsed.text, parsed.html, snippet].filter(Boolean).join(" "),
	});
	let spamAnalysis: Awaited<ReturnType<typeof analyzeSpam>> | null = null;
	let spamAnalysisError: string | null = null;
	const [owner] = await db
		.select({ enabled: users.spamProtectionEnabled })
		.from(users)
		.where(eq(users.id, decision.mailbox.userId))
		.limit(1);
	if (owner?.enabled !== false) {
		try {
			spamAnalysis = await analyzeSpam(db, {
				mailboxId: decision.mailbox.mailboxId,
				userId: decision.mailbox.userId,
				envelopeFrom: payload.from,
				headers: payload.headers,
				message: parsed,
				intelligenceProvider: configuredSpamIntelligenceProvider(env),
			});
		} catch (error) {
			spamAnalysisError = error instanceof Error ? error.message.slice(0, 300) : "Spam analysis failed";
			console.error(`Spam analysis failed for ${messageId}`, error);
		}
	}
	if (destination.status === "spam" && spamAnalysis) {
		spamAnalysis = {
			score: 100,
			verdict: "spam",
			signals: [{ id: "mailbox_rule_spam", score: 100, reason: "A mailbox rule marked this message as spam" }],
			fingerprint: spamAnalysis?.fingerprint ?? "",
		};
	}
	// The Screener sees only what the spam filter and mailbox rules would still deliver to the Inbox or a folder.
	const screened = await applyScreener(db, {
		mailboxId: decision.mailbox.mailboxId,
		sender: fromAddr,
		status: destination.status === "received" && spamAnalysis?.verdict === "spam" ? "spam" : destination.status,
	});
	const status = screened.status;
	const folderId = status === "spam" ? null : destination.folderId;
	const contact = await upsertContactFromAddress(env, {
		userId: decision.mailbox.userId,
		address: fromAddr,
		source: "inbound",
	});
	let threadId: string;
	try {
		threadId = await resolveThreadId(db, {
			mailboxId: decision.mailbox.mailboxId,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
		});
	} catch (error) {
		console.error("Inbound thread lookup failed", {
			rawR2Key: payload.rawR2Key,
			recipient: payload.to,
			referenceCount: parsed.references.length,
			error,
		});
		threadId = normalizeMessageId(parsed.messageId) ?? newId("thr");
	}

	try {
		const inserted = await db
			.insert(messages)
			.values({
				id: messageId,
				userId: decision.mailbox.userId,
				mailboxId: decision.mailbox.mailboxId,
				folderId,
				direction: "inbound",
				providerMessageId: parsed.messageId,
				fromAddr,
				toAddr,
				ccAddr: parsed.ccAddr,
				subject: parsed.subject,
				snippet,
				textBody: parsed.text,
				htmlBody: parsed.html,
				rawR2Key: payload.rawR2Key,
				status,
				threadId,
				inReplyTo: parsed.inReplyTo,
				references: parsed.references.length ? parsed.references.join(" ") : null,
				spamScore: spamAnalysis?.score ?? null,
				spamVerdict: spamAnalysis?.verdict ?? null,
				spamSignals: spamAnalysis ? JSON.stringify(spamAnalysis.signals) : null,
				spamAnalyzedAt: spamAnalysis ? new Date() : null,
				spamAnalysisError,
			})
			.onConflictDoNothing()
			.returning({ id: messages.id });
		if (!inserted.length) return;

		await storeMessageAttachments(env, messageId, parsed.attachments);
		if (spamAnalysis) {
			try {
				await recordReputationObservation(
					env,
					decision.mailbox.mailboxId,
					getReputationKeys(parsed, spamAnalysis.fingerprint),
				);
			} catch (error) {
				console.error(`Spam reputation observation failed for ${messageId}`, error);
			}
			console.info(
				JSON.stringify({
					messageId,
					spamScore: spamAnalysis.score,
					verdict: spamAnalysis.verdict,
					signals: spamAnalysis.signals.map((signal) => signal.id),
				}),
			);
		}
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, messageId));
		throw error;
	}

	// Mail from a sender waiting in the Screener gets no auto-reply and no notification.
	if (!screened.awaiting)
		await announceDelivery(env, {
			mailbox: decision.mailbox,
			messageId,
			status,
			deliveredAddress,
			fromAddr,
			fromName: contact?.displayName ?? null,
			parsed,
			headers: payload.headers,
		});
	await dispatchWebhooks(env, decision.mailbox.userId, "message.inbound", {
		messageId,
		from: fromAddr,
		to: payload.to,
		cc: parsed.ccAddr ?? undefined,
		subject: parsed.subject,
		threadId,
		spamScore: spamAnalysis?.score,
		spamVerdict: spamAnalysis?.verdict,
	});
	// Approving the sender schedules this message later (src/lib/screener/service.ts).
	if (screened.awaiting) return;
	try {
		await scheduleAgentWork(env, {
			mailboxId: decision.mailbox.mailboxId,
			sourceMessageId: messageId,
			ownerUserId: decision.mailbox.userId,
			sender: fromAddr,
			headers: payload.headers,
			status,
			folderId,
			spamVerdict: spamAnalysis?.verdict,
			spamAnalysisError,
		});
	} catch (error) {
		console.error("Agent work scheduling failed", error);
	}
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
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const contactNames = await getMessageContactNames(env, message.userId, message.fromAddr, message.toAddr);
	const attachments = await listMessageAttachments(env, messageId);
	const unsubscribeUrl = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	return { message: { ...message, ...contactNames }, body: message, attachments, unsubscribeUrl };
}

export async function getMessageMetadataForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const [attachments, unsubscribeUrl] = await Promise.all([
		listMessageAttachments(env, messageId),
		getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key),
	]);
	return { attachments, unsubscribeUrl };
}

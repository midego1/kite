import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, users } from "@/db/schema";
import { messageExternalAccounts } from "@/db/schema/external-accounts";
import { newId } from "@/lib/ids";
import { buildSnippet, MimeLimitError, parseRawMime } from "@/lib/email/parse";
import { resolveInboxRuleDestination } from "@/lib/email/routing";
import type { ParsedEmail } from "@/lib/email/parse";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { getSenderDisplayName } from "@/lib/contacts/utils";
import type { ContactDisplayName, ContactRow } from "@/lib/contacts/types";
import { sendMailboxAutoReply } from "@/lib/email/auto-reply";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { inboundAttachmentLimitReason } from "@/lib/email/inbound-attachments";
import { boundParsedEmail, boundTextBody } from "@/lib/email/inbound-limits";
import { canOffloadHtmlBodies, putOffloadedHtmlBody, recordOffloadedHtmlBody } from "@/lib/email/bodies";
import { planHtmlBodyOffload } from "@/lib/email/bodies-utils";
import { inboundMessageId } from "@/lib/email/inbound-id";
import { exceedsOneTimeCodeRawLength, extractOneTimeCode } from "@/lib/email/one-time-code-utils";
import { getLatestEmailContent, htmlToReadableText } from "@/lib/email/reply-content-utils";
import { resolveThreadId } from "@/lib/email/threading";
import { normalizeMessageId } from "@/lib/email/thread-lookup";
import { senderDmarc } from "@/lib/email/thread-join-utils";
import { analyzeSpam } from "@/lib/spam/engine";
import { configuredSpamIntelligenceProvider } from "@/lib/spam/providers/abuse-ch-key";
import { dmarcPolicySource } from "@/lib/spam/dmarc-policy";
import { getReputationKeys } from "@/lib/spam/analyzers/reputation";
import { recordReputationObservation } from "@/lib/spam/repository";
import { getMailboxNotificationUserIds, notifyUsersOfNewMessage } from "@/lib/realtime/utils";
import type { NewMessageNotification } from "@/lib/realtime/types";
import { scheduleAgentWork } from "@/lib/agent/auto-read/schedule";
import { applyScreener } from "@/lib/screener/inbound";
import { screenerPendingRows } from "@/lib/screener/views";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";

/** The mailbox a message is delivered into, and whose it is. */
export type DeliveryTarget = { mailboxId: string; userId: string };

/**
 * A message a connected account's sync fetched, with the flags it had at the source (spec §6.4). `junk` says it came
 * from the provider's Spam folder (the account's "Also sync the Spam folder" switch, §6.3).
 */
type ExternalDelivery = { accountId: string; read: boolean; starred: boolean; junk?: boolean };

export type InboundDelivery = {
	target: DeliveryTarget;
	/** The envelope sender and recipient, and the Mail store key of the raw message. */
	from: string;
	to: string;
	rawR2Key: string;
	raw: ArrayBuffer;
	/** The address the message was delivered to, for the auto-reply. */
	deliveredAddress: string;
	headers: Record<string, string> | undefined;
	/** The intake hop's verified `Authentication-Results`, or null when no trusted hop checked the sender. */
	authenticationResults: string | null;
	/** The SMTP listener saw a private client address, so SPF was not checked. */
	privateClient?: boolean;
	external?: ExternalDelivery;
};

export type DeliveryOutcome =
	| { delivered: true; messageId: string }
	| { delivered: false; reason: "attachment_limit"; detail: string }
	/** Over the MIME limits: the same every attempt, so the raw object is deleted. */
	| { delivered: false; reason: "unparseable"; detail: string }
	| { delivered: false; reason: "duplicate"; duplicateOf: string }
	| { delivered: false; reason: "stored" };

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
		const text = input.text?.trim();
		// Bounded before the HTML conversion and the quote split, so a very long mail costs no O(n) work here.
		if (!exceedsOneTimeCodeRawLength(text || input.html)) {
			oneTimeCode = extractOneTimeCode({
				subject: input.subject,
				text: getLatestEmailContent(text || htmlToReadableText(input.html)),
			});
		}
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
export async function recoverAgentWork(
	env: CloudflareEnv,
	target: DeliveryTarget,
	messageId: string,
	headers: Record<string, string> | undefined,
): Promise<void> {
	try {
		const db = getDb(env);
		const [existing] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
		if (!existing || (await screenerPendingRows(db, [existing])).has(existing.id)) return;
		await scheduleAgentWork(env, {
			mailboxId: target.mailboxId,
			sourceMessageId: existing.id,
			ownerUserId: target.userId,
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

/** The id of a message already stored in the mailbox from this raw object (a queue retry), or null. */
export async function storedFromRaw(env: CloudflareEnv, mailboxId: string, rawR2Key: string): Promise<string | null> {
	const [stored] = await getDb(env)
		.select({ id: messages.id })
		.from(messages)
		.where(and(eq(messages.mailboxId, mailboxId), eq(messages.rawR2Key, rawR2Key)))
		.limit(1);
	return stored?.id ?? null;
}

/**
 * The message of this mailbox a synced message duplicates, or null (spec §6.4): the same Message-ID (whichever
 * spelling, with or without angle brackets, its row stored) on a row that came from the same account (a rebuilt
 * INBOX, a message moved back into it), an import (`imports/…`, mail the users brought in themselves) or Kite's own
 * sending. Mail that reached the mailbox any other way is not compared: anyone can send the Kite address a copy with
 * a Message-ID they made up, and that copy must not hide the real message.
 */
async function duplicateOf(
	env: CloudflareEnv,
	mailboxId: string,
	accountId: string,
	messageId: string | null,
): Promise<string | null> {
	const normalized = normalizeMessageId(messageId);
	if (!normalized) return null;
	const [found] = await getDb(env)
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, mailboxId),
				inArray(messages.providerMessageId, [normalized, `<${normalized}>`]),
				or(
					sql`${messageExternalAccounts}.${sql.identifier("external_account_id")} = ${accountId}`,
					like(messages.rawR2Key, "imports/%"),
					eq(messages.direction, "outbound"),
				),
			),
		)
		.limit(1);
	return found?.id ?? null;
}

/**
 * The auto-reply and the realtime notification for a freshly stored message. Synced mail gets no auto-reply (the
 * provider has its own, and Kite's would come from a Kite address) and, when it was already read at the source, no
 * notification.
 */
async function announceDelivery(
	env: CloudflareEnv,
	input: {
		target: DeliveryTarget;
		messageId: string;
		status: string;
		deliveredAddress: string;
		fromAddr: string;
		fromName: string | null;
		parsed: ParsedEmail;
		headers: Record<string, string> | undefined;
		external?: ExternalDelivery;
	},
): Promise<void> {
	const { target, parsed } = input;
	if (input.status === "received" && !input.external) {
		try {
			await sendMailboxAutoReply(env, {
				mailboxId: target.mailboxId,
				userId: target.userId,
				deliveredAddress: input.deliveredAddress,
				fromAddress: input.fromAddr,
				incomingMessageId: parsed.messageId,
				headers: input.headers,
			});
		} catch (error) {
			console.error(`Auto-reply failed for mailbox ${target.mailboxId}`, error);
		}
	}
	// Spam and trash (a block or a mailbox rule) are filed away unread, so they never notify (upstream Mailflare #223).
	if (input.status === "spam" || input.status === "trash" || input.external?.read) return;
	const notificationUserIds = await getMailboxNotificationUserIds(env, target.mailboxId, target.userId);
	await notifyUsersOfNewMessage(
		env,
		notificationUserIds,
		buildInboundNewMessageNotification({
			messageId: input.messageId,
			mailboxId: target.mailboxId,
			from: input.fromAddr,
			fromName: input.fromName,
			subject: parsed.subject,
			text: parsed.text,
			html: parsed.html,
		}),
	);
}

type SpamAnalysis = Awaited<ReturnType<typeof analyzeSpam>>;

/** What the spam filter, the mailbox rules and the Screener decide for a message. */
type Placement = {
	status: string;
	folderId: string | null;
	awaiting: boolean;
	spamAnalysis: SpamAnalysis | null;
	spamAnalysisError: string | null;
};

/** Kite's analysis of a message from the provider's Spam folder, with the provider's verdict added on top. */
function providerJunkAnalysis(analysis: SpamAnalysis): SpamAnalysis {
	return {
		...analysis,
		score: 100,
		verdict: "spam",
		signals: [
			...analysis.signals,
			{ id: "provider_junk", score: 100, reason: "The provider filed this message in its Spam folder" },
		],
	};
}

async function placeMessage(
	env: CloudflareEnv,
	input: InboundDelivery,
	parsed: ParsedEmail,
	message: { id: string; snippet: string; fromAddr: string },
): Promise<Placement> {
	const db = getDb(env);
	const { target } = input;
	const destination = await resolveInboxRuleDestination(db, {
		mailboxId: target.mailboxId,
		toAddress: input.to,
		fromAddress: message.fromAddr,
		subject: parsed.subject,
		content: [parsed.text, parsed.html, message.snippet].filter(Boolean).join(" "),
	});
	let spamAnalysis: SpamAnalysis | null = null;
	let spamAnalysisError: string | null = null;
	const [owner] = await db
		.select({ enabled: users.spamProtectionEnabled })
		.from(users)
		.where(eq(users.id, target.userId))
		.limit(1);
	if (owner?.enabled !== false) {
		try {
			spamAnalysis = await analyzeSpam(db, {
				mailboxId: target.mailboxId,
				userId: target.userId,
				envelopeFrom: input.from,
				headers: input.headers,
				authenticationResults: input.authenticationResults,
				privateClient: input.privateClient,
				message: parsed,
				intelligenceProvider: configuredSpamIntelligenceProvider(env),
				dmarcPolicy: dmarcPolicySource(env),
			});
		} catch (error) {
			spamAnalysisError = error instanceof Error ? error.message.slice(0, 300) : "Spam analysis failed";
			console.error(`Spam analysis failed for ${message.id}`, error);
		}
	}
	// The provider's Spam folder: Kite's own analysis still runs and is kept, the message is filed in Spam whatever it
	// says, and neither the mailbox rules nor the Screener can move it anywhere else.
	if (input.external?.junk)
		return {
			status: "spam",
			folderId: null,
			awaiting: false,
			spamAnalysis: spamAnalysis && providerJunkAnalysis(spamAnalysis),
			spamAnalysisError,
		};
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
		mailboxId: target.mailboxId,
		sender: message.fromAddr,
		status: destination.status === "received" && spamAnalysis?.verdict === "spam" ? "spam" : destination.status,
	});
	return {
		status: screened.status,
		folderId: screened.status === "spam" ? null : destination.folderId,
		awaiting: screened.awaiting,
		spamAnalysis,
		spamAnalysisError,
	};
}

async function deliveryThreadId(
	env: CloudflareEnv,
	input: InboundDelivery,
	parsed: ParsedEmail,
	fromAddr: string,
): Promise<string> {
	try {
		return await resolveThreadId(getDb(env), {
			mailboxId: input.target.mailboxId,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
			// Synced mail may arrive before its parent, as imported mail does (spec §4.4). It is the user's own history,
			// so only received mail has to show it belongs in a conversation (upstream Mailflare #223).
			...(input.external
				? { fallback: "references-root" as const }
				: {
						sender: { address: fromAddr, dmarc: senderDmarc(input.authenticationResults, fromAddr) },
					}),
		});
	} catch (error) {
		console.error("Inbound thread lookup failed", {
			rawR2Key: input.rawR2Key,
			...(input.external ? { accountId: input.external.accountId } : { recipient: input.to }),
			referenceCount: parsed.references.length,
			error,
		});
		// Received mail cannot be checked against the thread its Message-ID may already key, so it starts its own.
		return (input.external ? normalizeMessageId(parsed.messageId) : null) ?? newId("thr");
	}
}

/**
 * The row, its account, its attachments and the reputation observation; false when a retry already stored it. An
 * HTML body over `BODY_OFFLOAD_BYTES` goes to the Mail store first and the row is inserted with its key in one batch,
 * as imports do (the row keeps a text body for search and snippets), so a failure leaves neither behind.
 */
async function storeDelivered(
	env: CloudflareEnv,
	input: InboundDelivery,
	parsed: ParsedEmail,
	row: { id: string; snippet: string; fromAddr: string; toAddr: string; threadId: string },
	placement: Placement,
	offloadHtml: boolean,
): Promise<boolean> {
	const db = getDb(env);
	const { target, external } = input;
	const { spamAnalysis } = placement;
	const offload = offloadHtml ? planHtmlBodyOffload(row.id, parsed) : null;
	try {
		if (offload) await putOffloadedHtmlBody(env, offload);
		const insert = db
			.insert(messages)
			.values({
				id: row.id,
				userId: target.userId,
				mailboxId: target.mailboxId,
				folderId: placement.folderId,
				direction: "inbound",
				providerMessageId: parsed.messageId,
				fromAddr: row.fromAddr,
				toAddr: row.toAddr,
				ccAddr: parsed.ccAddr,
				subject: parsed.subject,
				snippet: row.snippet,
				// Text derived from offloaded HTML is capped like a text part.
				textBody: offload ? boundTextBody(offload.textBody) : parsed.text,
				htmlBody: offload ? null : parsed.html,
				rawR2Key: input.rawR2Key,
				status: placement.status,
				threadId: row.threadId,
				inReplyTo: parsed.inReplyTo,
				references: parsed.references.length ? parsed.references.join(" ") : null,
				...(external ? { read: external.read, starred: external.starred } : {}),
				spamScore: spamAnalysis?.score ?? null,
				spamVerdict: spamAnalysis?.verdict ?? null,
				spamSignals: spamAnalysis ? JSON.stringify(spamAnalysis.signals) : null,
				spamAnalyzedAt: spamAnalysis ? new Date() : null,
				spamAnalysisError: placement.spamAnalysisError,
			})
			.onConflictDoNothing()
			.returning({ id: messages.id });
		// The row id comes from the raw key, so a concurrent attempt that already stored it wrote the same body object.
		const [rows] = offload ? await db.batch([insert, recordOffloadedHtmlBody(db, row.id, offload)]) : [await insert];
		if (!rows.length) return false;
		if (external)
			await db
				.update(messageExternalAccounts)
				.set({ externalAccountId: external.accountId })
				.where(eq(messageExternalAccounts.id, row.id));

		// `inboundAttachmentLimitReason` already checked them, without counting attached messages.
		await storeMessageAttachments(env, row.id, parsed.attachments, { validate: false });
		if (spamAnalysis) await observeReputation(env, target.mailboxId, row.id, parsed, spamAnalysis);
		return true;
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, row.id));
		if (offload) await env.BUCKET.delete(offload.key).catch(() => undefined);
		throw error;
	}
}

async function observeReputation(
	env: CloudflareEnv,
	mailboxId: string,
	messageId: string,
	parsed: ParsedEmail,
	spamAnalysis: SpamAnalysis,
): Promise<void> {
	try {
		await recordReputationObservation(env, mailboxId, getReputationKeys(parsed, spamAnalysis.fingerprint));
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

/** Gravatar learns who mailed us, so a sender filed away or still undecided is not looked up (upstream #220). */
function mayLookUpAvatar(placement: Placement): boolean {
	return !placement.awaiting && !["spam", "trash", SCREENING_STATUS].includes(placement.status);
}

function contactDisplayName(contact: ContactRow | null): ContactDisplayName | null {
	return contact?.displayName ? { displayName: contact.displayName, source: contact.source } : null;
}

/**
 * The `message.inbound` webhook. A consumer acting on the From of spam or trash would be fooled by it, so those are
 * not sent (upstream Mailflare #224); held mail still is, as docs/screener.md promises.
 */
async function dispatchInboundWebhook(
	env: CloudflareEnv,
	input: InboundDelivery,
	parsed: ParsedEmail,
	message: { messageId: string; fromAddr: string; threadId: string },
	placement: Placement,
): Promise<void> {
	if (placement.status === "spam" || placement.status === "trash") return;
	const { external } = input;
	await dispatchWebhooks(env, input.target.userId, "message.inbound", {
		messageId: message.messageId,
		from: message.fromAddr,
		to: input.to,
		cc: parsed.ccAddr ?? undefined,
		subject: parsed.subject,
		threadId: message.threadId,
		spamScore: placement.spamAnalysis?.score,
		spamVerdict: placement.spamAnalysis?.verdict,
		...(external ? { source: "external", accountId: external.accountId } : {}),
	});
}

/**
 * The delivery half of the inbound pipeline, shared by mail Kite receives and mail a connected account syncs: attachment
 * limits, mailbox rules, the spam filter, the Screener, the contact, the thread, the row and its attachments,
 * reputation, the notification, webhooks and automatic reading.
 */
export async function deliverInboundMessage(env: CloudflareEnv, input: InboundDelivery): Promise<DeliveryOutcome> {
	const { target, external } = input;
	const delivery = input.external ? `account ${input.external.accountId}` : input.to;
	let parsed: ParsedEmail;
	try {
		parsed = await parseRawMime(input.raw);
	} catch (error) {
		// Any other parse error is thrown, so the queue retries it with the raw object intact.
		if (!(error instanceof MimeLimitError)) throw error;
		// Over the limits the same way every time: a queue retry would only repeat the work.
		console.warn(`Inbound message over the MIME limits for ${delivery}: ${error.message}`);
		await env.BUCKET.delete(input.rawR2Key);
		return { delivered: false, reason: "unparseable", detail: error.message };
	}
	const offloadHtml = await canOffloadHtmlBodies(env);
	parsed = boundParsedEmail(parsed, { offloadHtml });
	const attachmentLimitReason = inboundAttachmentLimitReason(parsed.attachments);
	if (attachmentLimitReason) {
		// A synced message names its account, never the external address.
		console.warn(`Inbound attachment limit reached for ${delivery}: ${attachmentLimitReason}`);
		await env.BUCKET.delete(input.rawR2Key);
		return { delivered: false, reason: "attachment_limit", detail: attachmentLimitReason };
	}
	const duplicate = external ? await duplicateOf(env, target.mailboxId, external.accountId, parsed.messageId) : null;
	if (duplicate) {
		await env.BUCKET.delete(input.rawR2Key);
		return { delivered: false, reason: "duplicate", duplicateOf: duplicate };
	}
	const messageId = await inboundMessageId(input.rawR2Key);
	const snippet = buildSnippet(parsed.text, parsed.html);
	// Keep the whole To header so reply-all can address everyone; rules and
	// webhooks still see the envelope recipient the message was delivered to.
	const toAddr = parsed.toAddr ?? input.to;
	const fromAddr = parsed.fromAddr ?? input.from;
	const placement = await placeMessage(env, input, parsed, { id: messageId, snippet, fromAddr });
	const { status, folderId, spamAnalysis, spamAnalysisError } = placement;
	// Best effort: the mail matters more than its sender's contact row.
	const contact = await upsertContactFromAddress(env, {
		userId: target.userId,
		address: fromAddr,
		source: "inbound",
		lookupAvatar: mayLookUpAvatar(placement),
	}).catch((error) => {
		console.error(`Contact upsert failed for ${messageId}`, error);
		return null;
	});
	const threadId = await deliveryThreadId(env, input, parsed, fromAddr);
	const row = { id: messageId, snippet, fromAddr, toAddr, threadId };
	if (!(await storeDelivered(env, input, parsed, row, placement, offloadHtml)))
		return { delivered: false, reason: "stored" };

	// Mail from a sender waiting in the Screener gets no auto-reply and no notification.
	if (!placement.awaiting)
		await announceDelivery(env, {
			target,
			messageId,
			status,
			deliveredAddress: input.deliveredAddress,
			fromAddr,
			fromName: getSenderDisplayName(fromAddr, contactDisplayName(contact)),
			parsed,
			headers: input.headers,
			external,
		});
	await dispatchInboundWebhook(env, input, parsed, { messageId, fromAddr, threadId }, placement);
	// Approving the sender schedules this message later (src/lib/screener/service.ts).
	if (placement.awaiting) return { delivered: true, messageId };
	try {
		await scheduleAgentWork(env, {
			mailboxId: target.mailboxId,
			sourceMessageId: messageId,
			ownerUserId: target.userId,
			sender: fromAddr,
			headers: input.headers,
			status,
			folderId,
			spamVerdict: spamAnalysis?.verdict,
			spamAnalysisError,
		});
	} catch (error) {
		console.error("Agent work scheduling failed", error);
	}
	return { delivered: true, messageId };
}

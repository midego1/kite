import { and, desc, eq, inArray, lte, notExists } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, outboundJobs, users } from "@/db/schema";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { STUCK_SENDING_AFTER_MS } from "@/lib/messages/send-state-utils";
import { isJobClaimed } from "@/lib/email/job-claim";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { assertWithinSendLimits } from "@/lib/email/send-limits";
import { getEmailAddressList, joinEmailAddressList, splitEmailAddressList } from "@/lib/email/address";
import { formatMessageIdHeader, normalizeMessageId, parseMessageIdList } from "@/lib/email/threading";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { loadMessageAttachmentContents, storeMessageAttachments, validateAttachments } from "@/lib/email/attachments";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { getOutboundAttachmentMaxMb } from "@/lib/email/attachment-policy";
import { getOutboundProviderConfig, sendThroughProvider } from "@/lib/email/outbound-provider";
import { prepareCloudflareAttachments } from "@/lib/email/cloud-attachment-utils";
import { runPostDeliveryStep } from "@/lib/email/post-delivery-utils";
import { supersedeOlderReplies } from "@/lib/agent/auto-read/suggestion-lifecycle";
import { approveSentRecipients } from "@/lib/screener/release";
import { recordMetric } from "@/lib/metrics.mjs";
import { isNodeRuntime } from "@/lib/runtime";
import { assertWithinProviderLimit } from "@/lib/external-accounts/submit-utils";
import { recordConnectedSend, requeueAfterRefusal, submissionFor } from "@/lib/email/send-connected";

export type SendEmailInput = {
	userId: string;
	from: string;
	/** One header-style list or an array; each entry may carry a display name. */
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	/** Message-ID of the message being replied to, with or without angle brackets. */
	inReplyTo?: string | null;
	/** References chain, as a header string or a list of Message-IDs. */
	references?: string | string[] | null;
	/** Conversation to file the sent copy under; defaults to its own Message-ID. */
	threadId?: string | null;
	mailboxId: string;
	attachments?: AttachmentContent[];
	/** Future delivery time. Values at or before the current time send immediately. */
	scheduledAt?: string | Date;
	publicOrigin?: string;
	/** Caller-chosen id for the stored message, so a retried caller can find the row it already wrote. */
	messageId?: string;
	/** Lets From be the user's connected account (spec §7.3): the signed-in composer only, never keys or automations. */
	connectedAccounts?: boolean;
};

/** What an outbound job stores: the send as it was authorized, with the connected account it goes through. */
type OutboundJobPayload = SendEmailInput & { externalAccountId?: string | null };

const MAX_RECIPIENTS = 50;
const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;

type PreparedDelivery = {
	input: SendEmailInput;
	messageId: string;
	jobId: string;
	from: string;
	mailboxId: string;
	to: string[];
	cc: string[];
	bcc: string[];
	headers: Record<string, string>;
	attachments: AttachmentContent[];
	/** The connected account the message goes out through, or null for the From domain's provider. */
	externalAccountId: string | null;
	/** Which try this is; only a send through an account is tried again (after a 4xx). */
	attempt: number;
};

function toRecipientList(value: string | string[] | undefined): string[] {
	const entries = Array.isArray(value) ? value : splitEmailAddressList(value);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const entry of entries) {
		const [address] = getEmailAddressList(entry);
		if (!address || seen.has(address)) continue;
		seen.add(address);
		result.push(entry.trim());
	}
	return result;
}

function chooseMessageId(input: SendEmailInput): string {
	return input.messageId ?? newId("msg");
}

export async function sendEmail(
	env: CloudflareEnv,
	input: SendEmailInput,
): Promise<{ messageId: string; scheduled?: boolean; retrying?: boolean }> {
	const db = getDb(env);
	const sender = await getAuthorizedSenderAddress(env, input);
	await assertWithinSendLimits(env, input.userId);
	const attachments = input.attachments ?? [];
	validateAttachments(attachments);
	const maxAttachmentMb = await getOutboundAttachmentMaxMb(env);
	const maxAttachmentBytes = maxAttachmentMb * 1_000_000;
	if (
		attachments.some((attachment) => attachment.content.byteLength > maxAttachmentBytes) ||
		attachments.reduce((total, attachment) => total + attachment.content.byteLength, 0) > maxAttachmentBytes
	) {
		throw new Error(`Attachments exceed the administrator's ${maxAttachmentMb} MB outgoing limit`);
	}
	if (input.subject.length > 998) throw new Error("Subject exceeds Cloudflare's 998-character limit");
	// A provider's own limit counts the encoded message, so a send through an account is refused before it is queued.
	assertWithinProviderLimit(sender.sendLimit, input, attachments);

	const to = toRecipientList(input.to);
	const cc = toRecipientList(input.cc);
	const bcc = toRecipientList(input.bcc);
	if (to.length === 0) throw new Error("At least one recipient is required");
	if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
		throw new Error(`A message can have at most ${MAX_RECIPIENTS} recipients`);
	}
	for (const address of [...to, ...cc, ...bcc]) {
		await upsertContactFromAddress(env, { userId: input.userId, address, source: "outbound" });
	}

	const inReplyTo = normalizeMessageId(input.inReplyTo);
	const references = Array.isArray(input.references)
		? input.references.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id)
		: parseMessageIdList(input.references);
	const headers: Record<string, string> = { ...input.headers };
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	if (references.length > 0) headers.References = formatMessageIdHeader(references);
	if (
		new TextEncoder().encode(
			Object.entries(headers)
				.map(([name, value]) => `${name}: ${value}\r\n`)
				.join(""),
		).byteLength >
		16 * 1024
	) {
		throw new Error("Headers exceed Cloudflare's 16 KB limit");
	}

	const messageId = chooseMessageId(input);
	const requestedSchedule = input.scheduledAt ? new Date(input.scheduledAt) : null;
	const scheduledAt = requestedSchedule && requestedSchedule.getTime() > Date.now() ? requestedSchedule : null;
	const snippet = buildSnippet(input.text ?? null, input.html ?? null);
	const toAddr = joinEmailAddressList(to);

	await db.insert(messages).values({
		id: messageId,
		userId: input.userId,
		mailboxId: sender.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr,
		ccAddr: cc.length ? joinEmailAddressList(cc) : null,
		bccAddr: bcc.length ? joinEmailAddressList(bcc) : null,
		subject: input.subject,
		snippet,
		textBody: input.text ?? null,
		htmlBody: input.html ?? null,
		status: "queued",
		read: true,
		threadId: input.threadId ?? null,
		inReplyTo,
		references: references.length ? references.join(" ") : null,
	});
	try {
		const stored = await storeMessageAttachments(env, messageId, attachments);
		stored.forEach((attachment, index) => {
			attachments[index].storageId = attachment.id;
		});
	} catch (error) {
		await db.delete(messages).where(eq(messages.id, messageId));
		throw error;
	}

	const jobId = newId("job");
	await db.insert(outboundJobs).values({
		id: jobId,
		userId: input.userId,
		messageId,
		// An immediate send is claimed up front so cancelQueuedSend can never undo it mid-delivery.
		status: scheduledAt ? "queued" : "sending",
		payload: JSON.stringify({
			...input,
			from: sender.fromAddr,
			to,
			cc,
			bcc,
			mailboxId: sender.mailboxId,
			externalAccountId: sender.externalAccountId,
			attachments: attachments.map(({ content: _content, ...attachment }) => attachment),
		}),
		scheduledAt,
	});

	const delivery: PreparedDelivery = {
		input: { ...input, attachments: undefined },
		messageId,
		jobId,
		from: sender.fromAddr,
		mailboxId: sender.mailboxId,
		to,
		cc,
		bcc,
		headers,
		attachments,
		externalAccountId: sender.externalAccountId,
		attempt: 1,
	};
	if (scheduledAt) {
		await enqueueScheduledDelivery(env, delivery, scheduledAt);
		return { messageId, scheduled: true };
	}

	return { messageId, ...(await deliverOrThrow(env, delivery)) };
}

/** An immediate send whose claim was taken back before the provider call was not delivered: say so. */
async function deliverOrThrow(env: CloudflareEnv, delivery: PreparedDelivery): Promise<{ retrying?: true }> {
	const outcome = await deliverEmail(env, delivery);
	if (outcome === "taken_back") throw new Error("The send was taken back before it was delivered");
	return outcome === "retrying" ? { retrying: true } : {};
}

/**
 * Delivers a claimed send. Resolves to `taken_back` when the send was taken back before the provider call, so
 * nothing was delivered; `sent` once the provider accepted it, even if it had been taken back by then; `retrying`
 * when a connected account's server asked to try later and the job was queued again.
 */
async function deliverEmail(
	env: CloudflareEnv,
	delivery: PreparedDelivery,
): Promise<"sent" | "taken_back" | "retrying"> {
	const { input, messageId, jobId, from, mailboxId, to, cc, bcc, headers, attachments } = delivery;
	const db = getDb(env);
	const toAddr = joinEmailAddressList(to);
	let response: Awaited<ReturnType<typeof sendThroughProvider>>;
	let providerName = "";
	const started = Date.now();
	const record = (outcome: "sent" | "failed") =>
		recordMetric(env.METRICS, {
			event: "send",
			service: isNodeRuntime(env) ? "node" : "kite",
			name: providerName,
			outcome,
			durationMs: Date.now() - started,
			attempts: to.length + cc.length + bcc.length,
			version: env.CF_VERSION_METADATA?.id ?? "",
		});
	try {
		const provider = await getOutboundProviderConfig(env, from, submissionFor(delivery, input.userId));
		providerName = provider.provider;
		// Cloudflare's 5 MiB cap forces big files into download links; Resend takes
		// the attachments directly (the admin's outgoing limit still applies).
		const prepared =
			provider.provider === "cloudflare"
				? await prepareCloudflareAttachments(env, attachments, {
						subject: input.subject,
						html: input.html,
						text: input.text,
						headers,
						publicOrigin: input.publicOrigin,
					})
				: { attachments, html: input.html, text: input.text };
		if (prepared.text !== input.text || prepared.html !== input.html) {
			await db
				.update(messages)
				.set({ textBody: prepared.text ?? null, htmlBody: prepared.html ?? null })
				.where(and(eq(messages.id, messageId), eq(messages.status, "queued")));
		}
		// Just before the provider call: a send taken back (moved to Drafts after it stalled) is not delivered.
		if (!(await isJobClaimed(db, jobId))) {
			console.warn(`Outbound job ${jobId} for ${messageId} is no longer claimed; not delivering`);
			return "taken_back";
		}
		response = await sendThroughProvider(
			env,
			provider,
			{
				from,
				to,
				cc,
				bcc,
				subject: input.subject,
				headers,
				html: prepared.html,
				text: prepared.text,
				attachments: prepared.attachments.map((attachment) => ({
					filename: attachment.filename,
					type: attachment.type,
					content: attachment.content,
					disposition: attachment.disposition === "inline" && attachment.contentId ? "inline" : "attachment",
					contentId: attachment.contentId,
				})),
			},
			jobId,
		);
	} catch (err) {
		record("failed");
		const error = err instanceof Error ? err.message : "Send failed";
		// Only a 4xx from a connected account's server is tried again; anything that may have been delivered never is.
		if (await requeueAfterRefusal(env, delivery, err)) return "retrying";
		// Only the worker that still holds the send may mark it failed: after a stuck recovery or a cancel the
		// message is a draft again and a late failure must not touch it.
		const [failedMessage] = await db
			.update(messages)
			.set({ status: "failed" })
			.where(and(eq(messages.id, messageId), eq(messages.status, "queued")))
			.returning({ id: messages.id });
		await db
			.update(outboundJobs)
			.set({ status: "failed", error, updatedAt: new Date() })
			.where(and(eq(outboundJobs.id, jobId), eq(outboundJobs.status, "sending")));
		if (failedMessage) {
			await runPostDeliveryStep(`message.failed webhook for ${messageId}`, () =>
				dispatchWebhooks(env, input.userId, "message.failed", { messageId, error }),
			);
		}
		throw err;
	}

	record("sent");
	// The provider has accepted the message from here on. Nothing below may mark it
	// failed or rethrow, or a retry would deliver it a second time.
	let markedSent = false;
	const statusWritten = await runPostDeliveryStep(`sent status for ${messageId}`, async () => {
		// A fresh message starts its own conversation; Cloudflare's Message-ID is what
		// any reply will name in In-Reply-To, so key the thread by it. Only a message still queued becomes
		// sent: one moved back to Drafts after a stuck recovery stays the draft it is.
		const updated = await db
			.update(messages)
			.set({
				status: "sent",
				providerMessageId: response.messageId,
				threadId: input.threadId ?? normalizeMessageId(response.messageId) ?? messageId,
				// A send through a connected account keeps the exact bytes that went out (spec §7.3).
				...(response.rawR2Key ? { rawR2Key: response.rawR2Key } : {}),
			})
			.where(and(eq(messages.id, messageId), eq(messages.status, "queued")))
			.returning({ id: messages.id });
		markedSent = updated.length > 0;
	});
	// Late only when the write ran and matched nothing; a write that failed (a transient database error) says
	// nothing about the message, so the normal steps below still run.
	if (statusWritten && !markedSent) {
		// The mail went out, but the send had been taken back: keep a trace and leave the draft alone.
		console.warn(`Outbound job ${jobId} for ${messageId} was delivered after it was taken back`);
		await runPostDeliveryStep(`audit log for late delivery of ${messageId}`, () =>
			createAuditLog(env, {
				actorUserId: input.userId,
				mailboxId,
				messageId,
				action: "email.send",
				metadata: { to: toAddr, subject: input.subject, lateAfterRecovery: true },
			}),
		);
		return "sent";
	}
	await recordConnectedSend(env, delivery, response);
	await runPostDeliveryStep(`agent reply suggestions for ${messageId}`, () => supersedeOlderReplies(env, messageId));
	await runPostDeliveryStep(`screener approvals for ${messageId}`, () =>
		approveSentRecipients(env, mailboxId, input.userId, [...to, ...cc, ...bcc]),
	);
	await runPostDeliveryStep(`sent job status for ${jobId}`, () =>
		db
			.update(outboundJobs)
			.set({ status: "sent", updatedAt: new Date() })
			.where(and(eq(outboundJobs.id, jobId), eq(outboundJobs.status, "sending"))),
	);
	await runPostDeliveryStep(`message.outbound webhook for ${messageId}`, () =>
		dispatchWebhooks(env, input.userId, "message.outbound", {
			messageId,
			providerMessageId: response.messageId,
			to: toAddr,
			cc: cc.length ? joinEmailAddressList(cc) : undefined,
		}),
	);
	await runPostDeliveryStep(`audit log for ${messageId}`, () =>
		createAuditLog(env, {
			actorUserId: input.userId,
			mailboxId,
			messageId,
			action: "email.send",
			metadata: {
				to: toAddr,
				cc: cc.length ? joinEmailAddressList(cc) : undefined,
				subject: input.subject,
				...(delivery.externalAccountId ? { externalAccountId: delivery.externalAccountId } : {}),
			},
		}),
	);
	return "sent";
}

export type OutboundQueueMessage = {
	kind: "email.scheduled";
	jobId: string;
	messageId: string;
	scheduledAt: string;
	/** The try a send through a connected account is on; 1 when absent. */
	attempt?: number;
};

async function enqueueScheduledDelivery(
	env: CloudflareEnv,
	delivery: PreparedDelivery,
	scheduledAt: Date,
): Promise<void> {
	const delaySeconds = Math.min(
		MAX_QUEUE_DELAY_SECONDS,
		Math.max(1, Math.ceil((scheduledAt.getTime() - Date.now()) / 1000)),
	);
	await env.OUTBOUND_QUEUE.send(
		{
			kind: "email.scheduled",
			jobId: delivery.jobId,
			messageId: delivery.messageId,
			scheduledAt: scheduledAt.toISOString(),
			...(delivery.attempt > 1 ? { attempt: delivery.attempt } : {}),
		},
		{ delaySeconds },
	);
}

export async function processOutboundQueue(env: CloudflareEnv, payload: OutboundQueueMessage): Promise<void> {
	const db = getDb(env);
	const [job] = await db
		.select({ status: outboundJobs.status, payload: outboundJobs.payload })
		.from(outboundJobs)
		.where(eq(outboundJobs.id, payload.jobId))
		.limit(1);
	if (!job || job.status !== "queued") return;
	const scheduledAt = new Date(payload.scheduledAt);
	const input = JSON.parse(job.payload) as OutboundJobPayload;
	const to = toRecipientList(input.to);
	const cc = toRecipientList(input.cc);
	const bcc = toRecipientList(input.bcc);
	const inReplyTo = normalizeMessageId(input.inReplyTo);
	const references = Array.isArray(input.references)
		? input.references.map((id) => normalizeMessageId(id)).filter((id): id is string => !!id)
		: parseMessageIdList(input.references);
	const headers: Record<string, string> = { ...input.headers };
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	if (references.length > 0) headers.References = formatMessageIdHeader(references);
	const delivery: PreparedDelivery = {
		input,
		messageId: payload.messageId,
		jobId: payload.jobId,
		from: input.from,
		mailboxId: input.mailboxId,
		to,
		cc,
		bcc,
		headers,
		attachments: [],
		externalAccountId: input.externalAccountId ?? null,
		attempt: Math.max(1, Math.floor(Number(payload.attempt) || 1)),
	};
	if (scheduledAt.getTime() > Date.now()) {
		await enqueueScheduledDelivery(env, delivery, scheduledAt);
		return;
	}
	delivery.attachments = await loadMessageAttachmentContents(env, payload.messageId);
	// Claiming the job is the single gate shared with cancelQueuedSend: whichever
	// conditional update wins decides whether the message goes out or is undone.
	const [claimed] = await db
		.update(outboundJobs)
		.set({ status: "sending", updatedAt: new Date() })
		.where(and(eq(outboundJobs.id, payload.jobId), eq(outboundJobs.status, "queued")))
		.returning({ id: outboundJobs.id });
	if (!claimed) return;
	await deliverEmail(env, delivery);
}

export type CancelQueuedSendResult = { ok: true; draftId: string } | { ok: false; reason: "not_found" | "too_late" };

/**
 * Take back a message still waiting in the outbound queue and turn it into a draft again. A message whose
 * send failed is taken back the same way, to be edited and sent again, and so is one whose delivery has been
 * claimed for longer than `STUCK_SENDING_AFTER_MS` (nothing retries it; its job is marked failed). Only the
 * author can, and only while they still have send or manage access to the mailbox. The job and the message
 * change in one batch, so a cancelled job can never leave a queued message behind, or the other way round.
 */
export async function cancelQueuedSend(
	env: CloudflareEnv,
	userId: string,
	messageId: string,
): Promise<CancelQueuedSendResult> {
	const db = getDb(env);
	const [message] = await db
		.select({ id: messages.id, status: messages.status, mailboxId: messages.mailboxId })
		.from(messages)
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.userId, userId),
				eq(messages.direction, "outbound"),
				inArray(messages.status, ["queued", "failed"]),
			),
		)
		.limit(1);
	if (!message?.mailboxId) return { ok: false, reason: "not_found" };
	const [author] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
	const access = author ? await getMailboxAccessLevel(db, author, message.mailboxId) : null;
	if (!access || !(access.canManage || access.canSendAs || access.canSendOnBehalf)) {
		return { ok: false, reason: "not_found" };
	}

	const stuckBefore = new Date(Date.now() - STUCK_SENDING_AFTER_MS);
	let takeBackJob = db
		.update(outboundJobs)
		.set({ status: "cancelled", updatedAt: new Date() })
		.where(and(eq(outboundJobs.messageId, messageId), eq(outboundJobs.status, "queued")));
	if (message.status === "queued") {
		const [job] = await db
			.select({ status: outboundJobs.status, updatedAt: outboundJobs.updatedAt })
			.from(outboundJobs)
			.where(eq(outboundJobs.messageId, messageId))
			.orderBy(desc(outboundJobs.createdAt))
			.limit(1);
		if (job?.status === "sending" && job.updatedAt <= stuckBefore) {
			takeBackJob = db
				.update(outboundJobs)
				.set({ status: "failed", error: "Moved to Drafts after the send stalled", updatedAt: new Date() })
				.where(
					and(
						eq(outboundJobs.messageId, messageId),
						eq(outboundJobs.status, "sending"),
						lte(outboundJobs.updatedAt, stuckBefore),
					),
				);
		} else if (job?.status !== "queued") {
			return { ok: false, reason: "too_late" };
		}
	}
	// The message follows only when no job of it is left waiting or being delivered, so whichever side lost the
	// race against delivery changes nothing.
	const toDraft = db
		.update(messages)
		.set({ status: "draft" })
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.status, message.status),
				notExists(
					db
						.select({ id: outboundJobs.id })
						.from(outboundJobs)
						.where(and(eq(outboundJobs.messageId, messageId), inArray(outboundJobs.status, ["queued", "sending"]))),
				),
			),
		);
	await db.batch([takeBackJob, toDraft]);

	const [after] = await db
		.select({ status: messages.status })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	return after?.status === "draft" ? { ok: true, draftId: messageId } : { ok: false, reason: "too_late" };
}

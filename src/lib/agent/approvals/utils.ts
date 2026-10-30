import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { agentDraftMetadata, agentSendApprovals, contacts, messageAttachments, messages } from "@/db/schema";
import { getEmailAddressList } from "@/lib/email/address";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { loadMessageAttachmentContents } from "@/lib/email/attachments";
import { sendEmail } from "@/lib/email/send";
import { runPostDeliveryStep } from "@/lib/email/post-delivery-utils";
import { recordSentAgentDraft } from "@/lib/agent/auto-read/sent-draft";
import { newId } from "@/lib/ids";
import type { SessionUser } from "@/lib/auth/types";
import type { AgentSendSnapshot } from "./types";
import { DRAFT_CHANGED_ERROR, canonicalSnapshotJson } from "./snapshot-utils";

async function sha256(value: ArrayBuffer | string) {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function currentDraft(env: CloudflareEnv, user: SessionUser, draftId: string) {
	const db = getDb(env);
	const [draft] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.id, draftId), eq(messages.userId, user.id), eq(messages.status, "draft")))
		.limit(1);
	if (!draft?.mailboxId) throw new Error("Draft not found");
	const [metadata] = await db.select().from(agentDraftMetadata).where(eq(agentDraftMetadata.draftId, draftId)).limit(1);
	if (!metadata) throw new Error("Agent draft not found");
	await getAuthorizedSenderAddress(env, { userId: user.id, mailboxId: draft.mailboxId, from: draft.fromAddr });
	return { draft, metadata };
}

async function snapshot(
	env: CloudflareEnv,
	draft: typeof messages.$inferSelect,
	scheduledAt: Date | null,
): Promise<{ payload: AgentSendSnapshot; hash: string }> {
	const db = getDb(env);
	const rows = await db.select().from(messageAttachments).where(eq(messageAttachments.messageId, draft.id));
	const attachments: AgentSendSnapshot["attachments"] = [];
	for (const row of rows) {
		const object = await env.BUCKET.get(row.r2Key);
		if (!object) throw new Error("Draft attachment missing");
		attachments.push({
			id: row.id,
			filename: row.filename,
			size: row.size,
			digest: await sha256(await object.arrayBuffer()),
		});
	}
	const payload: AgentSendSnapshot = {
		from: draft.fromAddr,
		to: draft.toAddr,
		cc: draft.ccAddr,
		bcc: draft.bccAddr,
		subject: draft.subject ?? "",
		text: draft.textBody,
		html: draft.htmlBody,
		inReplyTo: draft.inReplyTo,
		references: draft.references,
		threadId: draft.threadId,
		mailboxId: draft.mailboxId!,
		scheduledAt: scheduledAt?.toISOString() ?? null,
		attachments,
	};
	if (!payload.to.trim() || !payload.subject.trim() || !(payload.text?.trim() || payload.html?.trim()))
		throw new Error("Draft is incomplete");
	return { payload, hash: await sha256(canonicalSnapshotJson(payload)) };
}

/** Contact sources that mean the user chose the address: saved by hand, or written to before. */
const FAMILIAR_CONTACT_SOURCES = ["outbound", "manual"] as const;

/**
 * The recipients of a reviewed draft the user has never written to or saved as a contact: where an instruction
 * hidden in incoming mail would send private text (upstream Mailflare #225). Lower-cased, in header order.
 * @public Test-only: exported for tests; the review requests below are its callers.
 */
export async function unfamiliarRecipients(
	env: CloudflareEnv,
	userId: string,
	snapshot: Pick<AgentSendSnapshot, "to" | "cc" | "bcc">,
): Promise<string[]> {
	const addresses = getEmailAddressList([snapshot.to, snapshot.cc, snapshot.bcc].filter(Boolean).join(", "));
	if (addresses.length === 0) return [];
	const known = await getDb(env)
		.select({ email: contacts.email })
		.from(contacts)
		.where(
			and(
				eq(contacts.userId, userId),
				inArray(contacts.email, addresses),
				inArray(contacts.source, [...FAMILIAR_CONTACT_SOURCES]),
			),
		);
	const familiar = new Set(known.map((row) => row.email));
	return addresses.filter((address) => !familiar.has(address));
}

export async function requestAgentSend(
	env: CloudflareEnv,
	user: SessionUser,
	draftId: string,
	expectedRevision: number,
	requestKeyId?: string,
) {
	const { draft, metadata } = await currentDraft(env, user, draftId);
	if (metadata.revision !== expectedRevision) throw new Error("Draft changed; reopen it for review");
	if (metadata.scheduledAt && metadata.scheduledAt.getTime() <= Date.now())
		throw new Error("Scheduled time has passed; update the draft before review");
	const [existing] = await getDb(env)
		.select({ id: agentSendApprovals.id })
		.from(agentSendApprovals)
		.where(
			and(eq(agentSendApprovals.draftId, draftId), inArray(agentSendApprovals.status, ["claimed", "sent", "unknown"])),
		)
		.limit(1);
	if (existing) throw new Error("This draft has a delivery already in progress or awaiting reconciliation");
	const { payload, hash } = await snapshot(env, draft, metadata.scheduledAt);
	const id = newId("approval");
	const expiresAt = new Date(Date.now() + 15 * 60_000);
	await getDb(env)
		.insert(agentSendApprovals)
		.values({
			id,
			draftId,
			mailboxId: draft.mailboxId!,
			userId: user.id,
			requestKeyId: requestKeyId ?? null,
			revision: expectedRevision,
			payloadHash: hash,
			expiresAt,
		});
	return {
		approvalId: id,
		status: "pending_approval",
		expiresAt,
		snapshot: payload,
		unfamiliarRecipients: await unfamiliarRecipients(env, user.id, payload),
		reviewUrl: `/agent/review/${id}`,
	};
}

export async function getAgentSendRequest(env: CloudflareEnv, user: SessionUser, approvalId: string) {
	const [approval] = await getDb(env)
		.select()
		.from(agentSendApprovals)
		.where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.userId, user.id)))
		.limit(1);
	if (!approval) throw new Error("Approval not found");
	let current: AgentSendSnapshot | null = null;
	let stale = false;
	if (approval.status === "pending") {
		try {
			const { draft, metadata } = await currentDraft(env, user, approval.draftId);
			const read = await snapshot(env, draft, metadata.scheduledAt);
			stale =
				metadata.revision !== approval.revision ||
				read.hash !== approval.payloadHash ||
				!!(metadata.scheduledAt && metadata.scheduledAt.getTime() <= Date.now());
			if (!stale) current = read.payload;
		} catch {
			stale = true;
		}
	}
	return {
		approvalId,
		status: approval.status,
		draftId: approval.draftId,
		messageId: approval.messageId,
		expiresAt: approval.expiresAt,
		snapshot: current,
		stale,
		unfamiliarRecipients: current ? await unfamiliarRecipients(env, user.id, current) : [],
	};
}

export async function confirmAgentSend(
	env: CloudflareEnv,
	user: SessionUser,
	approvalId: string,
	publicOrigin?: string,
) {
	const db = getDb(env);
	const [approval] = await db
		.select()
		.from(agentSendApprovals)
		.where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.userId, user.id)))
		.limit(1);
	if (!approval) throw new Error("Approval not found");
	if (approval.status !== "pending") return { status: approval.status, messageId: approval.messageId };
	if (approval.expiresAt < new Date()) {
		await db.update(agentSendApprovals).set({ status: "expired" }).where(eq(agentSendApprovals.id, approvalId));
		throw new Error("Approval expired");
	}
	const { draft, metadata } = await currentDraft(env, user, approval.draftId);
	const current = await snapshot(env, draft, metadata.scheduledAt);
	if (metadata.revision !== approval.revision || current.hash !== approval.payloadHash)
		throw new Error(DRAFT_CHANGED_ERROR);
	if (metadata.scheduledAt && metadata.scheduledAt.getTime() <= Date.now())
		throw new Error("Scheduled time has passed; update the draft before confirming");
	const claimed = await db
		.update(agentSendApprovals)
		.set({ status: "claimed", claimedAt: new Date() })
		.where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.status, "pending")))
		.returning({ id: agentSendApprovals.id });
	if (!claimed.length) return getAgentSendRequest(env, user, approvalId);
	try {
		const result = await sendEmail(env, {
			userId: user.id,
			mailboxId: draft.mailboxId!,
			from: draft.fromAddr,
			to: draft.toAddr,
			cc: draft.ccAddr || undefined,
			bcc: draft.bccAddr || undefined,
			subject: draft.subject || "",
			text: draft.textBody || undefined,
			html: draft.htmlBody || undefined,
			inReplyTo: draft.inReplyTo,
			references: draft.references,
			threadId: draft.threadId,
			attachments: await loadMessageAttachmentContents(env, draft.id),
			scheduledAt: metadata.scheduledAt ?? undefined,
			publicOrigin,
		});
		await db
			.update(agentSendApprovals)
			.set({ status: "sent", messageId: result.messageId })
			.where(eq(agentSendApprovals.id, approvalId));
		await db
			.update(messages)
			.set({ status: "trash" })
			.where(and(eq(messages.id, draft.id), eq(messages.status, "draft")));
		await runPostDeliveryStep(`agent draft action for ${draft.id}`, () =>
			recordSentAgentDraft(env, { mailboxId: draft.mailboxId!, draftId: draft.id, sentMessageId: result.messageId }),
		);
		return { status: "sent", messageId: result.messageId, scheduled: !!result.scheduled };
	} catch (error) {
		await db.update(agentSendApprovals).set({ status: "unknown" }).where(eq(agentSendApprovals.id, approvalId));
		throw new Error(`Delivery outcome needs review: ${error instanceof Error ? error.message : "provider error"}`);
	}
}

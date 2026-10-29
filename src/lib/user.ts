import { eq, desc, and } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, domains, mailboxes } from "@/db/schema";
import { selectRow } from "@/lib/db/pending-columns";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { DRAFT_STATUS, isDraftMoveRefused, isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import { isSendPending } from "@/lib/messages/send-state-utils";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import type { SessionUser } from "@/lib/auth/types";
import { applySpamFeedbackWithReceipt } from "@/lib/spam/feedback";

export async function listMessagesForUser(
	env: CloudflareEnv,
	userId: string,
	options?: { direction?: "inbound" | "outbound"; limit?: number },
) {
	const db = getDb(env);
	const limit = options?.limit ?? 50;
	const conditions = [eq(messages.userId, userId)];
	if (options?.direction) {
		conditions.push(eq(messages.direction, options.direction));
	}
	return db
		.select()
		.from(messages)
		.where(and(...conditions))
		.orderBy(desc(messages.createdAt))
		.limit(limit);
}

export async function listMailboxesForUser(env: CloudflareEnv, userId: string) {
	const db = getDb(env);
	return db.select().from(mailboxes).where(eq(mailboxes.userId, userId));
}

export async function userHasMailboxes(env: CloudflareEnv, userId: string): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(and(eq(mailboxes.userId, userId), eq(mailboxes.disabled, false)))
		.limit(1);
	return !!row;
}

export async function userHasAccessibleMailboxes(env: CloudflareEnv, user: SessionUser): Promise<boolean> {
	const db = getDb(env);
	const ids = await listAccessibleMailboxIds(db, user);
	return ids.length > 0;
}

export async function hasPrimaryDomain(env: CloudflareEnv): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db.select({ id: domains.id }).from(domains).limit(1);
	return !!row;
}

export async function getPrimaryDomain(env: CloudflareEnv) {
	const db = getDb(env);
	return (await selectRow(db, domains)) ?? null;
}

export async function getMailboxForUser(env: CloudflareEnv, userId: string, mailboxId: string) {
	const db = getDb(env);
	const [row] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.userId, userId)))
		.limit(1);
	return row ?? null;
}

export async function markMessageAsRead(env: CloudflareEnv, userId: string, messageId: string) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message || message.userId !== userId) return false;
	await db.update(messages).set({ read: true }).where(eq(messages.id, messageId));
	return true;
}

export async function markMessageAsReadForUser(env: CloudflareEnv, user: SessionUser, messageId: string) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId || isHiddenDraft(message, user.id)) return false;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return false;
	await db.update(messages).set({ read: true }).where(eq(messages.id, messageId));
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: message.mailboxId,
		messageId,
		action: "email.read",
	});
	return true;
}

export async function updateMessageStatusForUser(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	status: string,
	/** Told the receipt of the spam or "Not spam" training this move made, so its undo can take exactly that back. */
	onReceipt?: (messageId: string, receiptId: string) => void,
) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId || isHiddenDraft(message, user.id)) return false;
	// A draft is private (only its author gets here): Trash deletes it outright, whatever the author's access to
	// the mailbox, as the drafts API does, and no other move takes it out of Drafts or makes a draft.
	if (message.status === DRAFT_STATUS && status === "trash") {
		await deleteMessageWithObjects(env, db, message.id, message.rawR2Key);
		return true;
	}
	if (isDraftMoveRefused(message.status, status)) return false;
	// A message still in the outbound queue goes out wherever it is filed; it can only be cancelled first.
	if (isSendPending(message.status)) return false;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canManage) return false;
	const classification = status === "spam" ? "spam" : status === "received" && message.status === "spam" ? "ham" : null;
	if (classification) {
		const result = await applySpamFeedbackWithReceipt(env, user, messageId, classification);
		if (result?.receiptId) onReceipt?.(messageId, result.receiptId);
		return result !== null;
	}
	await db.update(messages).set({ status }).where(eq(messages.id, messageId));
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: message.mailboxId,
		messageId,
		action: "email.delete",
		metadata: { status },
	});
	return true;
}

export async function updateMessageStatus(env: CloudflareEnv, userId: string, messageId: string, status: string) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message || message.userId !== userId) return false;
	await db.update(messages).set({ status }).where(eq(messages.id, messageId));
	return true;
}

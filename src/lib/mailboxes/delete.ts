import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { getDb } from "@/db";
import { domains, mailboxes, messageAttachments, messages } from "@/db/schema";
import type { MailboxDeletionResult, MailboxPurgeMessage } from "./delete-types";
import {
	MAILBOX_PURGE_BATCH_SIZE,
	MAILBOX_PURGE_QUEUE_BUDGET_MS,
	MAILBOX_PURGE_REQUEST_BUDGET_MS,
	R2_DELETE_BATCH_SIZE,
	chunk,
	selectDeletableRawKeys,
} from "./delete-utils";

async function deleteObjects(env: CloudflareEnv, keys: string[]) {
	for (const part of chunk(keys, R2_DELETE_BATCH_SIZE)) {
		try {
			await env.BUCKET.delete(part);
		} catch (error) {
			console.error(`Mailbox purge: could not delete ${part.length} stored object(s)`, error);
		}
	}
}

/**
 * Removes one batch of a mailbox's messages with their attachment rows and
 * the R2 objects behind them. Rows go first: if R2 fails afterwards the cost
 * is an orphaned object, never a message whose content is missing.
 */
async function purgeMessageBatch(env: CloudflareEnv, db: AppDatabase, mailboxId: string): Promise<number> {
	const batch = await db
		.select({ id: messages.id, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(eq(messages.mailboxId, mailboxId))
		.limit(MAILBOX_PURGE_BATCH_SIZE);
	if (batch.length === 0) return 0;

	const ids = batch.map((row) => row.id);
	const attachmentKeys = (
		await db
			.select({ r2Key: messageAttachments.r2Key })
			.from(messageAttachments)
			.where(inArray(messageAttachments.messageId, ids))
	).map((row) => row.r2Key);
	const rawKeys = [...new Set(batch.map((row) => row.rawR2Key).filter((key): key is string => !!key))];
	const keptRawKeys = rawKeys.length
		? (
				await db
					.select({ rawR2Key: messages.rawR2Key })
					.from(messages)
					.where(
						and(inArray(messages.rawR2Key, rawKeys), or(isNull(messages.mailboxId), ne(messages.mailboxId, mailboxId))),
					)
			).map((row) => row.rawR2Key as string)
		: [];

	// Attachment rows, shared links, spam feedback and assistant rows cascade from the message.
	await db.delete(messages).where(inArray(messages.id, ids));
	await deleteObjects(env, [...attachmentKeys, ...selectDeletableRawKeys(rawKeys, keptRawKeys)]);
	return batch.length;
}

async function finalizeMailboxDeletion(env: CloudflareEnv, db: AppDatabase, mailboxId: string) {
	const [mailbox] = await db
		.select({ avatarKey: mailboxes.avatarKey })
		.from(mailboxes)
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	// Folders, aliases, sharing, spam statistics and assistant settings cascade from the mailbox.
	await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
	await env.DB.prepare("DELETE FROM jmap_mailbox_revisions WHERE mailbox_id = ?")
		.bind(mailboxId)
		.run()
		.catch(() => undefined);
	if (mailbox?.avatarKey) await deleteObjects(env, [mailbox.avatarKey]);
}

/** A removed domain's row goes once its last mailbox has drained. */
async function deleteDomainIfEmpty(db: AppDatabase, domainId: string) {
	const [remaining] = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(eq(mailboxes.domainId, domainId))
		.limit(1);
	if (!remaining) await db.delete(domains).where(eq(domains.id, domainId));
}

async function purgeMailbox(
	env: CloudflareEnv,
	mailboxId: string,
	budgetMs: number,
	domainId?: string,
): Promise<MailboxDeletionResult> {
	const db = getDb(env);
	const deadline = Date.now() + budgetMs;
	let deletedMessages = 0;
	while (Date.now() < deadline) {
		const deleted = await purgeMessageBatch(env, db, mailboxId);
		deletedMessages += deleted;
		if (deleted < MAILBOX_PURGE_BATCH_SIZE) {
			await finalizeMailboxDeletion(env, db, mailboxId);
			if (domainId) await deleteDomainIfEmpty(db, domainId);
			return { completed: true, deletedMessages };
		}
	}
	await env.OUTBOUND_QUEUE.send({
		kind: "mailbox.purge",
		mailboxId,
		...(domainId ? { domainId } : {}),
	} satisfies MailboxPurgeMessage);
	return { completed: false, deletedMessages };
}

/**
 * Deletes a mailbox together with its messages, attachments and stored
 * objects. The mailbox is disabled first, which hides it everywhere and stops
 * new deliveries; whatever does not fit in this request finishes on the queue.
 */
export async function deleteMailboxWithContents(env: CloudflareEnv, mailboxId: string): Promise<MailboxDeletionResult> {
	await getDb(env).update(mailboxes).set({ disabled: true }).where(eq(mailboxes.id, mailboxId));
	return purgeMailbox(env, mailboxId, MAILBOX_PURGE_REQUEST_BUDGET_MS);
}

export async function processMailboxPurge(env: CloudflareEnv, payload: MailboxPurgeMessage): Promise<void> {
	const [mailbox] = await getDb(env)
		.select({ disabled: mailboxes.disabled })
		.from(mailboxes)
		.where(eq(mailboxes.id, payload.mailboxId))
		.limit(1);
	// Re-enabling the mailbox while it drains cancels the deletion of what is left.
	if (!mailbox?.disabled) return;
	await purgeMailbox(env, payload.mailboxId, MAILBOX_PURGE_QUEUE_BUDGET_MS, payload.domainId);
}

/**
 * Deletes a domain's mailboxes the same way as deleteMailboxWithContents
 * (deleting the domain row directly would cascade to the mailboxes and leave
 * their messages behind), then the domain itself, possibly from the queue.
 */
export async function deleteDomainWithMailboxes(env: CloudflareEnv, domainId: string): Promise<MailboxDeletionResult> {
	const db = getDb(env);
	const rows = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.domainId, domainId));
	if (rows.length) await db.update(mailboxes).set({ disabled: true }).where(eq(mailboxes.domainId, domainId));
	const deadline = Date.now() + MAILBOX_PURGE_REQUEST_BUDGET_MS;
	let completed = true;
	let deletedMessages = 0;
	for (const row of rows) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			await env.OUTBOUND_QUEUE.send({
				kind: "mailbox.purge",
				mailboxId: row.id,
				domainId,
			} satisfies MailboxPurgeMessage);
			completed = false;
			continue;
		}
		const result = await purgeMailbox(env, row.id, remaining, domainId);
		deletedMessages += result.deletedMessages;
		if (!result.completed) completed = false;
	}
	if (completed) await db.delete(domains).where(eq(domains.id, domainId));
	return { completed, deletedMessages };
}

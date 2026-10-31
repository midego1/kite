import { and, eq, gt, isNull, lte, notInArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb } from "@/db";
import { mailboxes, messageAttachments, messages, sharedAttachmentLinks, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";

export const SHARED_ATTACHMENT_LINK_DAYS = 30;

export async function getOrCreateSharedAttachmentUrl(
	env: CloudflareEnv,
	attachmentId: string,
	publicOrigin?: string,
): Promise<string> {
	const origin = env.APP_URL?.trim() || publicOrigin;
	if (!origin) throw new Error("Set APP_URL before sending large attachments as download links");
	const url = new URL(origin);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
	) {
		throw new Error("A public HTTPS APP_URL is required for large attachment links");
	}
	const db = getDb(env);
	const now = new Date();
	await db
		.delete(sharedAttachmentLinks)
		.where(and(eq(sharedAttachmentLinks.attachmentId, attachmentId), lte(sharedAttachmentLinks.expiresAt, now)));
	const id = newId("share");
	await db
		.insert(sharedAttachmentLinks)
		.values({
			id,
			attachmentId,
			expiresAt: new Date(now.getTime() + SHARED_ATTACHMENT_LINK_DAYS * 24 * 60 * 60_000),
		})
		.onConflictDoNothing();
	const [link] = await db
		.select({ id: sharedAttachmentLinks.id })
		.from(sharedAttachmentLinks)
		.where(eq(sharedAttachmentLinks.attachmentId, attachmentId))
		.limit(1);
	if (!link) throw new Error("Could not create a large attachment link");
	return new URL(`/api/shared-files/${encodeURIComponent(link.id)}`, url).toString();
}

/** Message states in which a public link stops working: the file was thrown away, judged spam or is still held. */
const CLOSED_STATUSES = ["trash", "spam", SCREENING_STATUS];

/**
 * The file a public shared-file link serves, or null. Besides expiry, a link dies while its message is in trash,
 * spam or the Screener, or while its mailbox, the message's owner or the mailbox's owner is disabled, so a link
 * in mail already sent cannot outlive a deletion or a suspended account. Adapted from upstream Mailflare #222.
 */
export async function findSharedFile(env: CloudflareEnv, linkId: string, now = new Date()) {
	const messageOwner = alias(users, "message_owner");
	const mailboxOwner = alias(users, "mailbox_owner");
	const [file] = await getDb(env)
		.select({
			r2Key: messageAttachments.r2Key,
			filename: messageAttachments.filename,
			size: messageAttachments.size,
		})
		.from(sharedAttachmentLinks)
		.innerJoin(messageAttachments, eq(sharedAttachmentLinks.attachmentId, messageAttachments.id))
		.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
		.innerJoin(messageOwner, eq(messages.userId, messageOwner.id))
		.leftJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
		.leftJoin(mailboxOwner, eq(mailboxes.userId, mailboxOwner.id))
		.where(
			and(
				eq(sharedAttachmentLinks.id, linkId),
				gt(sharedAttachmentLinks.expiresAt, now),
				notInArray(messages.status, CLOSED_STATUSES),
				eq(messageOwner.disabled, false),
				or(isNull(messages.mailboxId), and(eq(mailboxes.disabled, false), eq(mailboxOwner.disabled, false))),
			),
		)
		.limit(1);
	return file ?? null;
}

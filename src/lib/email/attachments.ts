import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { insertRow } from "@/lib/db/pending-columns";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import type { SessionUser } from "@/lib/auth/types";
import { attachmentObjectKey, sanitizeFilename } from "./attachment-name-utils";
import { ATTACHMENT_ROW_COLUMNS, openAttachment, readAttachmentBytes } from "./attachment-storage";
import { attachmentObjectKeys } from "./attachment-storage-utils";
import type { AttachmentRow } from "./attachment-storage-types";
import type { AttachmentContent, AttachmentMetadata, StoredAttachment } from "./attachment-types";

export const MAX_ATTACHMENT_SIZE = 25_000_000;
export const MAX_TOTAL_ATTACHMENT_SIZE = 25_000_000;
export const MAX_ATTACHMENT_COUNT = 10;

export function decodeBase64Content(content: string): ArrayBuffer {
	const binary = atob(content.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
}

export function normalizeAttachmentContent(
	content: ArrayBuffer | Uint8Array | string,
	encoding?: "base64" | "utf8",
): ArrayBuffer {
	if (content instanceof ArrayBuffer) return content;
	if (content instanceof Uint8Array) {
		return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
	}
	if (encoding === "base64") return decodeBase64Content(content);
	return new TextEncoder().encode(content).buffer;
}

export function validateAttachments(attachments: AttachmentContent[]): void {
	if (attachments.length > MAX_ATTACHMENT_COUNT) {
		throw new Error(`A message can include at most ${MAX_ATTACHMENT_COUNT} attachments`);
	}

	let totalSize = 0;
	for (const attachment of attachments) {
		const size = attachment.content.byteLength;
		if (size > MAX_ATTACHMENT_SIZE) {
			throw new Error(`${attachment.filename} exceeds the 25 MB attachment limit`);
		}
		totalSize += size;
	}

	if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
		throw new Error("Attachments exceed the 25 MB total limit");
	}
}

export async function storeMessageAttachments(
	env: CloudflareEnv,
	messageId: string,
	attachments: AttachmentContent[],
	options?: { validate?: boolean },
): Promise<StoredAttachment[]> {
	if (options?.validate !== false) validateAttachments(attachments);
	const db = getDb(env);
	const stored: StoredAttachment[] = [];

	try {
		for (const attachment of attachments) {
			const id = newId("att");
			const filename = sanitizeFilename(attachment.filename);
			const r2Key = attachmentObjectKey(messageId, id);
			const disposition = attachment.disposition ?? "attachment";

			await env.BUCKET.put(r2Key, attachment.content, {
				httpMetadata: { contentType: attachment.type },
				customMetadata: { filename, messageId },
			});
			stored.push({
				id,
				messageId,
				filename,
				type: attachment.type,
				size: attachment.content.byteLength,
				disposition,
				contentId: attachment.contentId ?? null,
				r2Key,
			});
			await insertRow(db, messageAttachments, {
				id,
				messageId,
				filename,
				contentType: attachment.type,
				size: attachment.content.byteLength,
				disposition,
				contentId: attachment.contentId ?? null,
				r2Key,
			});
		}
	} catch (error) {
		await Promise.all(stored.map((attachment) => env.BUCKET.delete(attachment.r2Key)));
		throw error;
	}

	return stored;
}

/**
 * Duplicate a message's attachments onto another message (a forward draft).
 * R2 keys are unique per row, so the objects are copied rather than shared,
 * which keeps deleting the draft from touching the original.
 */
export async function copyMessageAttachments(
	env: CloudflareEnv,
	fromMessageId: string,
	toMessageId: string,
): Promise<AttachmentMetadata[]> {
	const db = getDb(env);
	const rows = await db
		.select(ATTACHMENT_ROW_COLUMNS)
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, fromMessageId));
	const copied: AttachmentMetadata[] = [];
	for (const row of rows) {
		const content = await readAttachmentBytes(env, row);
		if (!content) continue;
		const id = newId("att");
		const r2Key = attachmentObjectKey(toMessageId, id);
		// Rows stored before names were sanitised keep theirs; the copy gets a clean one.
		const filename = sanitizeFilename(row.filename);
		await env.BUCKET.put(r2Key, content, {
			httpMetadata: { contentType: row.contentType },
			customMetadata: { filename, messageId: toMessageId },
		});
		await insertRow(db, messageAttachments, {
			id,
			messageId: toMessageId,
			filename,
			contentType: row.contentType,
			size: row.size,
			disposition: row.disposition,
			contentId: row.contentId,
			r2Key,
		});
		copied.push({
			id,
			messageId: toMessageId,
			filename,
			type: row.contentType,
			size: row.size,
			disposition: row.disposition as "attachment" | "inline",
			contentId: row.contentId,
		});
	}
	return copied;
}

/** Attachments with their bytes, for handing a draft's files to the send path. */
export async function loadMessageAttachmentContents(
	env: CloudflareEnv,
	messageId: string,
): Promise<AttachmentContent[]> {
	const db = getDb(env);
	const rows = await db
		.select(ATTACHMENT_ROW_COLUMNS)
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, messageId));
	const result: AttachmentContent[] = [];
	for (const row of rows) {
		const content = await readAttachmentBytes(env, row);
		if (!content) continue;
		result.push({
			storageId: row.id,
			filename: row.filename,
			type: row.contentType,
			content,
			disposition: row.disposition as "attachment" | "inline",
			contentId: row.contentId,
		});
	}
	return result;
}

/** Remove one attachment (row and object). Returns false when it is not on that message. */
export async function deleteMessageAttachment(
	env: CloudflareEnv,
	messageId: string,
	attachmentId: string,
): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db
		.select({ r2Key: messageAttachments.r2Key })
		.from(messageAttachments)
		.where(and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.messageId, messageId)))
		.limit(1);
	if (!row) return false;
	await db.delete(messageAttachments).where(eq(messageAttachments.id, attachmentId));
	await Promise.all(attachmentObjectKeys([row]).map((key) => env.BUCKET.delete(key)));
	return true;
}

/** Remove every attachment object of a message; the rows cascade with the message row. */
export async function deleteMessageAttachmentObjects(env: CloudflareEnv, messageId: string): Promise<void> {
	const db = getDb(env);
	const rows = await db
		.select({ r2Key: messageAttachments.r2Key })
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, messageId));
	await Promise.all(attachmentObjectKeys(rows).map((key) => env.BUCKET.delete(key)));
}

export async function listMessageAttachments(env: CloudflareEnv, messageId: string): Promise<AttachmentMetadata[]> {
	const db = getDb(env);
	const rows = await db
		.select(ATTACHMENT_ROW_COLUMNS)
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, messageId));

	return rows.map((attachment) => ({
		id: attachment.id,
		messageId: attachment.messageId,
		filename: attachment.filename,
		type: attachment.contentType,
		size: attachment.size,
		disposition: attachment.disposition as "attachment" | "inline",
		contentId: attachment.contentId,
	}));
}

/** The attachment row when the user may read its message, by the rule every attachment reader shares; else null. */
export async function findAttachmentForUser(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	attachmentId: string,
): Promise<AttachmentRow | null> {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message || isHiddenDraft(message, user.id)) return null;

	if (message.mailboxId) {
		const access = await getMailboxAccessLevel(db, user, message.mailboxId);
		if (!access?.canRead) return null;
	} else if (message.userId !== user.id) {
		return null;
	}

	const [attachment] = await db
		.select(ATTACHMENT_ROW_COLUMNS)
		.from(messageAttachments)
		.where(and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.messageId, messageId)))
		.limit(1);
	return attachment ?? null;
}

/** The attachment row and its opened content when the user may read the message; null otherwise or when not stored. */
export async function getAttachmentForUser(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	attachmentId: string,
) {
	const attachment = await findAttachmentForUser(env, user, messageId, attachmentId);
	const file = attachment ? await openAttachment(env, attachment) : null;
	return attachment && file ? { attachment, file } : null;
}

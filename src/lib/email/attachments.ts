import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { queryInChunks } from "@/db/chunk-utils";
import { newId } from "@/lib/ids";
import { sha256Hex } from "@/lib/aws/sigv4";
import { insertRow } from "@/lib/db/pending-columns";
import { createLogger } from "@/lib/logger.mjs";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import type { SessionUser } from "@/lib/auth/types";
import { attachmentObjectKey, sanitizeFilename } from "./attachment-name-utils";
import {
	ATTACHMENT_ROW_COLUMNS,
	deleteUnreferencedObjects,
	openAttachment,
	readAttachmentBytes,
	shareAttachmentObject,
	shareAttachmentObjectByDigest,
} from "./attachment-storage";
import {
	ATTACHMENT_OBJECT_ROWS_SQL,
	attachmentObjectKeys,
	isAttachmentSharingEnabled,
	isRawAttachmentKey,
} from "./attachment-storage-utils";
import type { AttachmentRow, SharedAttachmentRow } from "./attachment-storage-types";
import type { AttachmentContent, AttachmentMetadata, StoredAttachment } from "./attachment-types";

const log = createLogger("attachments");

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

/**
 * Attachments this isolate read from a stored 'object' row, mapped to that row's id. Only server code that loaded a row
 * it may read adds to it (`storedAttachmentContent`), and a request body cannot reach it, so a client-supplied
 * `storageId` never makes a send share another row's object.
 */
const storedSources = new WeakMap<AttachmentContent, string>();

/**
 * An attachment's bytes read from `row`, remembered as coming from it so storing it again (a send from a draft, the
 * assistant attaching a file) shares the row's object instead of writing the bytes again.
 */
export function storedAttachmentContent(
	row: Pick<AttachmentRow, "id" | "r2Key" | "filename" | "contentType" | "disposition" | "contentId">,
	content: ArrayBuffer,
): AttachmentContent {
	const attachment: AttachmentContent = {
		storageId: row.id,
		filename: row.filename,
		type: row.contentType,
		content,
		disposition: row.disposition,
		contentId: row.contentId,
	};
	if (!isRawAttachmentKey(row.r2Key)) storedSources.set(attachment, row.id);
	return attachment;
}

/** Writes `content` as a new object of its own and its row; the key is unique to the row, so nobody else names it. */
async function writeAttachmentObject(
	env: CloudflareEnv,
	row: SharedAttachmentRow,
	content: ArrayBuffer,
	written: string[],
	sha256?: string,
): Promise<string> {
	const r2Key = attachmentObjectKey(row.messageId, row.id);
	await env.BUCKET.put(r2Key, content, {
		httpMetadata: { contentType: row.contentType },
		customMetadata: { filename: row.filename, messageId: row.messageId },
	});
	written.push(r2Key);
	await insertRow(getDb(env), messageAttachments, {
		...row,
		size: content.byteLength,
		r2Key,
		...(sha256 ? { sha256 } : {}),
	});
	return r2Key;
}

/** Undoes a store that failed part way: its rows first, then the objects it wrote itself, never a shared one. */
async function rollBackStoredAttachments(env: CloudflareEnv, ids: string[], written: string[]): Promise<void> {
	try {
		if (ids.length) await getDb(env).delete(messageAttachments).where(inArray(messageAttachments.id, ids));
	} catch (error) {
		log.error("attachment.rollback_failed", { count: ids.length, error });
	}
	await deleteUnreferencedObjects(env, { attachmentKeys: written });
}

export async function storeMessageAttachments(
	env: CloudflareEnv,
	messageId: string,
	attachments: AttachmentContent[],
	options?: { validate?: boolean },
): Promise<StoredAttachment[]> {
	if (options?.validate !== false) validateAttachments(attachments);
	const stored: StoredAttachment[] = [];
	const ids: string[] = [];
	const written: string[] = [];
	const sharing = isAttachmentSharingEnabled(env.ATTACHMENT_SHARING);

	try {
		for (const attachment of attachments) {
			const row: SharedAttachmentRow = {
				id: newId("att"),
				messageId,
				filename: sanitizeFilename(attachment.filename),
				contentType: attachment.type,
				disposition: attachment.disposition ?? "attachment",
				contentId: attachment.contentId ?? null,
			};
			ids.push(row.id);
			// A file read from a stored row (a draft being sent) names that row's object; the bytes are written only
			// when the source has gone meanwhile or keys cannot be shared yet.
			const source = sharing ? storedSources.get(attachment) : undefined;
			const shared = source ? await shareAttachmentObject(env, row, source) : null;
			const r2Key = shared?.r2Key ?? (await writeAttachmentObject(env, row, attachment.content, written));
			stored.push({
				id: row.id,
				messageId,
				filename: row.filename,
				type: row.contentType,
				size: shared?.size ?? attachment.content.byteLength,
				disposition: row.disposition,
				contentId: row.contentId,
				r2Key,
			});
		}
	} catch (error) {
		await rollBackStoredAttachments(env, ids, written);
		throw error;
	}

	return stored;
}

/**
 * A forwarded 'raw' row has no object to share: its bytes are decoded once and stored as an object, or name one
 * with the same bytes that the same user already has (`sha256`, `size`).
 */
async function copyRawAttachment(
	env: CloudflareEnv,
	source: AttachmentRow,
	row: SharedAttachmentRow,
	written: string[],
): Promise<number | null> {
	const content = await readAttachmentBytes(env, source);
	if (!content) return null;
	const sha256 = await sha256Hex(content);
	const shared = isAttachmentSharingEnabled(env.ATTACHMENT_SHARING)
		? await shareAttachmentObjectByDigest(env, row, { sha256, size: content.byteLength })
		: null;
	if (shared) return shared.size;
	await writeAttachmentObject(env, row, content, written, sha256);
	return content.byteLength;
}

/**
 * A forwarded 'object' row: its object is shared, or copied when keys cannot be shared yet (before 0088) or
 * `ATTACHMENT_SHARING` is off.
 */
async function copyObjectAttachment(
	env: CloudflareEnv,
	source: AttachmentRow,
	row: SharedAttachmentRow,
	written: string[],
): Promise<number | null> {
	const shared = isAttachmentSharingEnabled(env.ATTACHMENT_SHARING)
		? await shareAttachmentObject(env, row, source.id)
		: null;
	if (shared) return shared.size;
	const content = await readAttachmentBytes(env, source);
	if (!content) return null;
	await writeAttachmentObject(env, row, content, written);
	return content.byteLength;
}

/**
 * Puts a message's attachments on another message (a forward draft). An 'object' row's object is shared rather than
 * copied (`docs/specs/attachments-once.md` §5.3); deleting the draft keeps it, because the original still names it.
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
	const ids: string[] = [];
	const written: string[] = [];
	try {
		for (const source of rows) {
			const row: SharedAttachmentRow = {
				id: newId("att"),
				messageId: toMessageId,
				// Rows stored before names were sanitised keep theirs; the copy gets a clean one.
				filename: sanitizeFilename(source.filename),
				contentType: source.contentType,
				disposition: source.disposition,
				contentId: source.contentId,
			};
			ids.push(row.id);
			const size = isRawAttachmentKey(source.r2Key)
				? await copyRawAttachment(env, source, row, written)
				: await copyObjectAttachment(env, source, row, written);
			if (size === null) continue;
			copied.push({
				id: row.id,
				messageId: toMessageId,
				filename: row.filename,
				type: row.contentType,
				size,
				disposition: row.disposition,
				contentId: row.contentId,
			});
		}
	} catch (error) {
		// A forward that fails part way leaves the draft without any of the copies, as a failed store does.
		await rollBackStoredAttachments(env, ids, written);
		throw error;
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
		if (content) result.push(storedAttachmentContent(row, content));
	}
	return result;
}

/**
 * Removes one attachment from a message: the row, then its object unless another row (the sent copy of a draft, the
 * message a draft forwards) still names it. A 'raw' row is refused, since its bytes are part of the message itself;
 * drafts never have one. Returns false when no such row is on that message.
 */
export async function deleteMessageAttachment(
	env: CloudflareEnv,
	messageId: string,
	attachmentId: string,
): Promise<boolean> {
	const deleted = await getDb(env)
		.delete(messageAttachments)
		.where(
			and(
				eq(messageAttachments.id, attachmentId),
				eq(messageAttachments.messageId, messageId),
				sql.raw(ATTACHMENT_OBJECT_ROWS_SQL),
			),
		)
		.returning({ r2Key: messageAttachments.r2Key });
	if (deleted.length === 0) return false;
	await deleteUnreferencedObjects(env, { attachmentKeys: attachmentObjectKeys(deleted) });
	return true;
}

/** The object keys of a message's attachment rows, read before the message (and with it the rows) is deleted. */
export async function messageAttachmentKeys(env: CloudflareEnv, messageIds: readonly string[]): Promise<string[]> {
	const db = getDb(env);
	const rows = await queryInChunks(messageIds, (chunk) =>
		db
			.select({ r2Key: messageAttachments.r2Key })
			.from(messageAttachments)
			.where(inArray(messageAttachments.messageId, chunk)),
	);
	return attachmentObjectKeys(rows);
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

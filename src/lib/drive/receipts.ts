import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { driveItems } from "@/db/schema/drive";
import type { SessionUser } from "@/lib/auth/types";
import { buildReceiptHtmlDocument } from "@/lib/email/receipt-html-export-utils";
import { buildReceiptPdfDocument } from "@/lib/email/receipt-pdf-utils";
import { getContactNameFromAddress } from "@/lib/contacts/utils";
import { getAttachmentForUser } from "@/lib/email/attachments";
import { assessStoredAttachment } from "@/lib/email/attachment-risk-store";
import { loadMessageBody, MessageBodyUnavailableError } from "@/lib/email/bodies";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { buildTextPdf } from "@/lib/pdf/text-pdf-utils";
import { sizedBody } from "./attachments";
import { getQuotaLimit, reserveDriveFile } from "./quota";
import { driveObjectKey, normalizeDriveName } from "./name-utils";
import { newDriveStore } from "./objects";
import type { DriveRow } from "./types";

export type ReceiptSkipReason = "not_found" | "forbidden" | "nothing_available";

export type FileMessageReceiptsResult =
	| {
			filed: true;
			emlFileId: string | null;
			htmlFileId: string | null;
			pdfFileId: string | null;
			attachmentFileId: string | null;
	  }
	| { filed: false; skipped: ReceiptSkipReason };

/** Thrown for anything a retry can fix on its own (quota, a transient read error): a caller that lets this
 * propagate (`fileOneReceipt`) leaves its claim `pending` rather than recording a permanent skip. Already-written
 * files are not lost: `findExistingItem` below makes every write in this module idempotent by name, so a retry
 * resumes rather than duplicating what already landed. */
class ReceiptFilingTransientError extends Error {}

/** An existing, non-trashed item of this owner, parent and name, if any: the single lookup every create in this
 * module checks first, so calling the same write twice (a retry after a crash, two runs racing on an unclaimed
 * row) reuses what is already there instead of creating a duplicate. */
async function findExistingItem(
	db: ReturnType<typeof getDb>,
	ownerId: string,
	parentId: string | null,
	kind: "folder" | "file",
	name: string,
): Promise<string | null> {
	const [existing] = await db
		.select({ id: driveItems.id })
		.from(driveItems)
		.where(
			and(
				eq(driveItems.ownerId, ownerId),
				eq(driveItems.kind, kind),
				eq(driveItems.name, name),
				isNull(driveItems.trashedAt),
				parentId === null ? isNull(driveItems.parentId) : eq(driveItems.parentId, parentId),
			),
		)
		.orderBy(asc(driveItems.createdAt), asc(driveItems.id))
		.limit(1);
	return existing?.id ?? null;
}

/** One folder segment of `Money Watch/Receipts/<year>`, found under its parent or created there. A concurrent
 * caller that loses the create races re-reads and keeps the older row (`findExistingItem` orders by `createdAt`,
 * then `id`), so two callers racing on the same name never leave two folders behind. */
async function ensureFolder(
	db: ReturnType<typeof getDb>,
	ownerId: string,
	parentId: string | null,
	name: string,
): Promise<string> {
	const existing = await findExistingItem(db, ownerId, parentId, "folder", name);
	if (existing) return existing;
	const now = new Date();
	const row: DriveRow = {
		id: newId("drv"),
		ownerId,
		parentId,
		kind: "folder",
		name,
		size: 0,
		contentType: "application/octet-stream",
		storeId: null,
		objectKey: null,
		status: "ready",
		uploadId: null,
		uploadPartSize: null,
		uploadFingerprint: null,
		uploadExpiresAt: null,
		sourceAttachmentId: null,
		trashedAt: null,
		createdAt: now,
		updatedAt: now,
	};
	try {
		await db.insert(driveItems).values(row);
	} catch {
		// A concurrent call created it first; re-read and merge rather than add a second row with the same name.
		const raced = await findExistingItem(db, ownerId, parentId, "folder", name);
		if (raced) return raced;
		throw new Error("Could not create or find the receipts folder");
	}
	// Even without an insert conflict, a concurrent caller may have committed a same-named folder a moment earlier
	// or later; re-reading and keeping the oldest, deleting a newly-created loser, keeps exactly one canonical row.
	const winner = await findExistingItem(db, ownerId, parentId, "folder", name);
	if (winner && winner !== row.id) {
		await db.delete(driveItems).where(eq(driveItems.id, row.id));
		return winner;
	}
	return row.id;
}

/** Finds or creates every segment of a folder path under the owner's Drive root, in order. */
export async function ensureFolderPath(env: CloudflareEnv, ownerId: string, segments: string[]): Promise<string> {
	const db = getDb(env);
	let parentId: string | null = null;
	for (const segment of segments) {
		const name = normalizeDriveName(segment) ?? segment;
		parentId = await ensureFolder(db, ownerId, parentId, name);
	}
	if (parentId === null) throw new Error("A receipts folder path needs at least one segment");
	return parentId;
}

type GeneratedFile = {
	ownerId: string;
	parentId: string;
	name: string;
	contentType: string;
	bytes: Uint8Array | ArrayBuffer;
};

/** Writes generated bytes (not an existing attachment's stream) as a new Drive file, reusing an existing file of
 * the same name first (a retry of an earlier, partially-successful attempt), then reserving quota. Throws
 * `ReceiptFilingTransientError` when quota is full, rather than returning null, so a caller that does not catch
 * it leaves the row retryable instead of recording a permanent skip. */
async function writeGeneratedDriveFile(env: CloudflareEnv, file: GeneratedFile): Promise<string> {
	const db = getDb(env);
	const name = normalizeDriveName(file.name) ?? file.name;
	const existing = await findExistingItem(db, file.ownerId, file.parentId, "file", name);
	if (existing) return existing;
	const body = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
	const store = await newDriveStore(env);
	const id = newId("drv");
	const now = new Date();
	const reserved: Parameters<typeof reserveDriveFile>[1] = {
		id,
		ownerId: file.ownerId,
		parentId: file.parentId,
		name,
		size: body.byteLength,
		contentType: file.contentType,
		storeId: store.id,
		objectKey: driveObjectKey(id),
		uploadPartSize: null,
		uploadFingerprint: null,
		uploadExpiresAt: null,
		sourceAttachmentId: null,
		now,
	};
	if (!(await reserveDriveFile(env, reserved, await getQuotaLimit(env, file.ownerId)))) {
		throw new ReceiptFilingTransientError("quota_exceeded");
	}
	try {
		await store.bucket.put(reserved.objectKey, body, { httpMetadata: { contentType: file.contentType } });
		await db.update(driveItems).set({ status: "ready", updatedAt: new Date() }).where(eq(driveItems.id, id));
	} catch (error) {
		await db.delete(driveItems).where(eq(driveItems.id, id));
		throw error;
	}
	return id;
}

/** `name` with the original attachment's extension, so the copy still opens as a PDF (or whatever it is) outside Kite. */
function withOriginalExtension(name: string, originalFilename: string | null): string {
	const extension = originalFilename?.match(/\.[a-z0-9]{1,8}$/i)?.[0];
	return extension && !name.toLowerCase().endsWith(extension.toLowerCase()) ? `${name}${extension}` : name;
}

/** The outcome of one attachment copy attempt: a real file, an intentional and permanent skip (not readable or
 * flagged risky, neither of which a retry changes), or a transient quota failure. */
type AttachmentCopyOutcome = { id: string } | { skipped: true };

/** Copies a readable attachment into the folder, as a reference-free independent file, reusing an existing copy
 * of the same name first. `skipped: true` means "never copy this one" (not found, forbidden, flagged); a quota
 * failure throws `ReceiptFilingTransientError` instead, so it is retried rather than treated the same way. */
async function copyAttachmentIntoFolder(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	attachmentId: string,
	parentId: string,
	name: string,
): Promise<AttachmentCopyOutcome> {
	const source = await getAttachmentForUser(env, user, messageId, attachmentId);
	if (!source) return { skipped: true };
	const risk = await assessStoredAttachment(env, source.attachment);
	if (risk.level !== "ok") {
		await source.file.body.cancel().catch(() => undefined);
		return { skipped: true };
	}
	const db = getDb(env);
	const finalName = withOriginalExtension(
		normalizeDriveName(name) ?? source.attachment.filename ?? "Receipt",
		source.attachment.filename,
	);
	const existing = await findExistingItem(db, user.id, parentId, "file", finalName);
	if (existing) {
		await source.file.body.cancel().catch(() => undefined);
		return { id: existing };
	}
	const store = await newDriveStore(env);
	const id = newId("drv");
	const now = new Date();
	const size = source.file.size;
	const reserved: Parameters<typeof reserveDriveFile>[1] = {
		id,
		ownerId: user.id,
		parentId,
		name: finalName,
		size,
		contentType: source.attachment.contentType,
		storeId: store.id,
		objectKey: driveObjectKey(id),
		uploadPartSize: null,
		uploadFingerprint: null,
		uploadExpiresAt: null,
		sourceAttachmentId: attachmentId,
		now,
	};
	if (!(await reserveDriveFile(env, reserved, await getQuotaLimit(env, user.id)))) {
		await source.file.body.cancel().catch(() => undefined);
		throw new ReceiptFilingTransientError("quota_exceeded");
	}
	try {
		await store.bucket.put(reserved.objectKey, sizedBody(source.file.body, size), {
			httpMetadata: { contentType: reserved.contentType },
		});
		await db.update(driveItems).set({ status: "ready", updatedAt: new Date() }).where(eq(driveItems.id, id));
	} catch (error) {
		await db.delete(driveItems).where(eq(driveItems.id, id));
		throw error;
	}
	return { id };
}

function senderName(from: string): string | null {
	return getContactNameFromAddress(from);
}

function senderAddress(from: string): string {
	const match = from.match(/<([^>]+)>/);
	return (match ? match[1] : from).trim();
}

type ReceiptHeader = { fromName: string | null; fromAddress: string; subject: string | null; dateText: string };
type ReceiptBody = { htmlBody: string | null; textBody?: string | null } | null;

/** The raw mail as `.eml`, when one was ever stored for this message; `null` otherwise, or when it is gone. */
async function writeEmlCopy(
	env: CloudflareEnv,
	message: { rawR2Key: string | null },
	folderId: string,
	ownerId: string,
	baseName: string,
): Promise<string | null> {
	if (!message.rawR2Key) return null;
	const object = await env.BUCKET.get(message.rawR2Key);
	if (!object) return null;
	const raw = await object.arrayBuffer();
	return writeGeneratedDriveFile(env, {
		ownerId,
		parentId: folderId,
		name: `${baseName}.eml`,
		contentType: "message/rfc822",
		bytes: raw,
	});
}

/** The self-contained HTML and the PDF copies, from whatever body could be read; either is attempted only while
 * there is something in `bodyRow` to build it from. */
async function writeHtmlAndPdfCopies(
	env: CloudflareEnv,
	header: ReceiptHeader,
	bodyRow: ReceiptBody,
	folderId: string,
	ownerId: string,
	baseName: string,
): Promise<{ htmlFileId: string | null; pdfFileId: string | null }> {
	let htmlFileId: string | null = null;
	let pdfFileId: string | null = null;
	if (bodyRow?.htmlBody) {
		const html = buildReceiptHtmlDocument(header, bodyRow.htmlBody);
		htmlFileId = await writeGeneratedDriveFile(env, {
			ownerId,
			parentId: folderId,
			name: `${baseName}.html`,
			contentType: "text/html; charset=utf-8",
			bytes: new TextEncoder().encode(html),
		});
	}
	if (bodyRow?.htmlBody || bodyRow?.textBody) {
		const pdf = buildTextPdf(buildReceiptPdfDocument(header, bodyRow.textBody ?? null, bodyRow.htmlBody));
		pdfFileId = await writeGeneratedDriveFile(env, {
			ownerId,
			parentId: folderId,
			name: `${baseName}.pdf`,
			contentType: "application/pdf",
			bytes: pdf.bytes,
		});
	}
	return { htmlFileId, pdfFileId };
}

/** The body for the HTML/PDF copies, or `null` while there is none to read: a read failure other than the body
 * being genuinely unreadable right now (transient; the caller leaves the row retryable for it) propagates. */
async function readReceiptBody(
	env: CloudflareEnv,
	message: Parameters<typeof loadMessageBody>[1],
): Promise<ReceiptBody> {
	try {
		return await loadMessageBody(env, message, { strict: true });
	} catch (error) {
		if (error instanceof MessageBodyUnavailableError) return null;
		throw error;
	}
}

/**
 * "Keep receipts" (docs/specs/money-watch.md "Keep receipts"): files the mail of one finance row (its raw `.eml`,
 * a self-contained readable HTML copy, a readable PDF copy and its receipt attachment, when it has one) into the
 * owner's Drive under `folderSegments` (`["Money Watch", "Receipts", "<year>"]`). Runs as the owner: a message or
 * attachment the owner can no longer read answers `not_found`/`forbidden` rather than copying anything.
 *
 * Every write here is idempotent by name (`findExistingItem`), so calling this twice for the same `baseName` never
 * duplicates a file a previous attempt already wrote; only the pieces still missing are attempted again. A piece
 * that cannot succeed right now because of quota, or because its body could not be read, throws
 * `ReceiptFilingTransientError` (quota) or lets `MessageBodyUnavailableError` propagate (a transient R2 read
 * failure) instead of silently finishing the row with pieces missing: the caller (`fileOneReceipt`) leaves such a
 * row `pending` and retries it later, when the already-written pieces are reused and only the rest is attempted.
 * `filed: false` is reserved for a row with truly nothing to file (the message or attachment is gone, or there was
 * never a raw copy, a body or an attachment to begin with), which no retry can change.
 */
export async function fileMessageReceipts(
	env: CloudflareEnv,
	input: {
		ownerId: string;
		ownerRole: string;
		messageId: string;
		attachmentId: string | null;
		folderSegments: string[];
		baseName: string;
	},
): Promise<FileMessageReceiptsResult> {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, input.messageId)).limit(1);
	if (!message?.mailboxId) return { filed: false, skipped: "not_found" };
	const user = { id: input.ownerId, role: input.ownerRole } as SessionUser;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return { filed: false, skipped: "forbidden" };

	const folderId = await ensureFolderPath(env, input.ownerId, input.folderSegments);
	const header: ReceiptHeader = {
		fromName: senderName(message.fromAddr),
		fromAddress: senderAddress(message.fromAddr),
		subject: message.subject,
		dateText: message.createdAt.toISOString(),
	};

	// A body read failure (an offloaded object R2 cannot serve right now) is transient: left uncaught by
	// `readReceiptBody`, it propagates past this function so the caller leaves the claim pending and retries rather
	// than losing the eml below (already durably written, and reused rather than duplicated on that retry).
	const [emlFileId, bodyRow] = await Promise.all([
		writeEmlCopy(env, message, folderId, input.ownerId, input.baseName),
		readReceiptBody(env, message),
	]);
	const { htmlFileId, pdfFileId } = await writeHtmlAndPdfCopies(
		env,
		header,
		bodyRow,
		folderId,
		input.ownerId,
		input.baseName,
	);

	let attachmentFileId: string | null = null;
	if (input.attachmentId) {
		const outcome = await copyAttachmentIntoFolder(
			env,
			user,
			input.messageId,
			input.attachmentId,
			folderId,
			`${input.baseName} receipt`,
		);
		if ("id" in outcome) attachmentFileId = outcome.id;
	}

	// Nothing landed: whether or not something was attempted (an attachment that turned out flagged or unreadable,
	// say), there is nothing left here for a retry to find either, so this is a permanent skip either way.
	if (!emlFileId && !htmlFileId && !pdfFileId && !attachmentFileId)
		return { filed: false, skipped: "nothing_available" };
	return { filed: true, emlFileId, htmlFileId, pdfFileId, attachmentFileId };
}

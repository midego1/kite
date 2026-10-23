import { and, desc, eq, isNull, lt, notInArray, or } from "drizzle-orm";
import { getDb } from "@/db";
import { inJsonArray } from "@/db/chunk-utils";
import { messageAttachments, messages } from "@/db/schema";
import { driveItems } from "@/db/schema/drive";
import { getAttachmentForUser } from "@/lib/email/attachments";
import { newId } from "@/lib/ids";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import { driveTypesCondition } from "./categories";
import type { DriveCategory } from "./category-names-utils";
import { toDriveItemDtos } from "./dto";
import { fail, notFound, ok } from "./errors";
import { editableFolder } from "./items";
import { DRIVE_PAGE_SIZE, nextDriveCursor, type DriveCursor } from "./list-utils";
import { driveObjectKey, normalizeDriveName } from "./name-utils";
import { newDriveStore } from "./objects";
import { getQuotaLimit, reserveDriveFile } from "./quota";
import { QUOTA_ERROR } from "./quota-utils";
import { normalizeUploadContentType } from "./upload-utils";
import type { DriveAnswer, DriveItemDto } from "./types";

function senderName(from: string): string {
	const named = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/)?.[1];
	return (named ?? from).trim();
}

/**
 * `GET /api/drive/attachments`: files attached to mail the user can read, received or sent, newest first.
 * Inline images, drafts, trash and spam are left out; the attachment's own id is the item id.
 */
export async function listDriveAttachments(
	env: CloudflareEnv,
	user: SessionUser,
	types: DriveCategory[],
	cursor: DriveCursor | null,
): Promise<DriveAnswer> {
	const db = getDb(env);
	const mailboxIds = (await listAccessibleMailboxes(db, user)).map((mailbox) => mailbox.id);
	const scope = or(
		and(isNull(messages.mailboxId), eq(messages.userId, user.id)),
		inJsonArray(messages.mailboxId, mailboxIds),
	);
	const at = cursor ? new Date(cursor.at * 1000) : null;
	const rows = await db
		.select({
			attachment: messageAttachments,
			messageId: messages.id,
			mailboxId: messages.mailboxId,
			subject: messages.subject,
			from: messages.fromAddr,
			direction: messages.direction,
			date: messages.createdAt,
		})
		.from(messageAttachments)
		.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
		.where(
			and(
				scope,
				eq(messageAttachments.disposition, "attachment"),
				notInArray(messages.status, ["draft", "trash", "spam", SCREENING_STATUS]),
				types.length
					? driveTypesCondition(types, {
							contentType: messageAttachments.contentType,
							name: messageAttachments.filename,
						})
					: undefined,
				at && cursor
					? or(lt(messages.createdAt, at), and(eq(messages.createdAt, at), lt(messageAttachments.id, cursor.id)))
					: undefined,
			),
		)
		.orderBy(desc(messages.createdAt), desc(messageAttachments.id))
		.limit(DRIVE_PAGE_SIZE);
	const items: DriveItemDto[] = rows.map((row) => ({
		id: row.attachment.id,
		kind: "file",
		name: row.attachment.filename,
		size: row.attachment.size,
		contentType: row.attachment.contentType,
		parentId: null,
		ownerId: "",
		ownerName: senderName(row.from),
		role: "view",
		shared: false,
		trashedAt: null,
		updatedAt: row.date.toISOString(),
		source: {
			messageId: row.messageId,
			mailboxId: row.mailboxId,
			subject: row.subject ?? "",
			direction: row.direction,
		},
	}));
	const nextCursor = nextDriveCursor(rows, DRIVE_PAGE_SIZE, (row) => ({
		at: Math.floor(row.date.getTime() / 1000),
		id: row.attachment.id,
	}));
	return ok({ items, nextCursor });
}

/** The attachment and its object when the user may read it, by the same rule as the mail attachment route. */
export async function readableAttachment(env: CloudflareEnv, user: SessionUser, attachmentId: string) {
	const [row] = await getDb(env)
		.select({ messageId: messageAttachments.messageId })
		.from(messageAttachments)
		.where(eq(messageAttachments.id, attachmentId))
		.limit(1);
	return row ? getAttachmentForUser(env, user, row.messageId, attachmentId) : null;
}

/** R2 needs a known length to store a stream; the file bucket takes any stream. */
function sizedBody(body: ReadableStream, size: number): ReadableStream {
	const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream }).FixedLengthStream;
	if (!Fixed) return body;
	const { readable, writable } = new Fixed(size);
	void body.pipeTo(writable).catch(() => undefined);
	return readable;
}

/**
 * `POST /api/drive/attachments/[id]/save` `{ parentId, name? }`: copies a readable attachment into a Drive
 * folder the user can edit, as an independent file counted against the folder owner's quota.
 */
export async function saveAttachmentToDrive(
	env: CloudflareEnv,
	user: SessionUser,
	attachmentId: string,
	body: unknown,
): Promise<DriveAnswer> {
	const value = (body ?? {}) as { parentId?: unknown; name?: unknown };
	if (value.parentId !== undefined && value.parentId !== null && typeof value.parentId !== "string")
		return fail(400, "Invalid folder");
	const db = getDb(env);
	const parentId = (value.parentId as string | null | undefined) || null;
	// The folder is checked before the attachment is opened, so a refusal never leaves its stream unread.
	const ownerId = parentId ? (await editableFolder(db, user.id, parentId)).folder.ownerId : user.id;
	const source = await readableAttachment(env, user, attachmentId);
	if (!source) return notFound();
	const store = await newDriveStore(env);
	const id = newId("drv");
	const now = new Date();
	const size = source.object.size ?? source.attachment.size;
	const file = {
		id,
		ownerId,
		parentId,
		name: normalizeDriveName(value.name ?? source.attachment.filename) ?? "Attachment",
		size,
		contentType: normalizeUploadContentType(source.attachment.contentType),
		storeId: store.id,
		objectKey: driveObjectKey(id),
		uploadPartSize: null,
		uploadFingerprint: null,
		uploadExpiresAt: null,
		sourceAttachmentId: attachmentId,
		now,
	};
	if (!(await reserveDriveFile(env, file, await getQuotaLimit(env, ownerId)))) {
		await source.object.body.cancel().catch(() => undefined);
		return fail(413, QUOTA_ERROR);
	}
	try {
		await store.bucket.put(file.objectKey, sizedBody(source.object.body, size), {
			httpMetadata: { contentType: file.contentType },
		});
		await db.update(driveItems).set({ status: "ready", updatedAt: new Date() }).where(eq(driveItems.id, id));
	} catch (error) {
		await db.delete(driveItems).where(eq(driveItems.id, id));
		throw error;
	}
	const [row] = await db.select().from(driveItems).where(eq(driveItems.id, id)).limit(1);
	const [item] = await toDriveItemDtos(db, [row], () => (ownerId === user.id ? "owner" : "edit"));
	return ok({ item }, 201);
}

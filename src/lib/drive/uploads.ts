import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems, driveUploadParts } from "@/db/schema/drive";
import { newId } from "@/lib/ids";
import { getDriveItem, getDriveRole } from "./access";
import { toDriveItemDtos } from "./dto";
import { fail, notFound, ok } from "./errors";
import { editableFolder } from "./items";
import { canEditDrive, driveObjectKey, normalizeDriveName } from "./name-utils";
import { bucketOfItem, multipartOf, newDriveStore, storeOfItem } from "./objects";
import { countUploadsInProgress, getQuotaLimit, reserveDriveFile } from "./quota";
import { QUOTA_ERROR } from "./quota-utils";
import {
	DRIVE_DIRECT_PART_BYTES,
	DRIVE_MAX_UPLOADS_IN_PROGRESS,
	DRIVE_PART_URL_SECONDS,
	DRIVE_PROXIED_PART_BYTES,
	DRIVE_UPLOAD_RESUME_MS,
	expectedPartSize,
	parsePartEtag,
	parsePartNumbers,
	parseUploadRequest,
	partCount,
	partsComplete,
	type UploadRequest,
} from "./upload-utils";
import type { DriveAnswer, DriveRow, DriveUser } from "./types";

type Db = ReturnType<typeof getDb>;

/** The same file picked again (same owner, folder, name, size and fingerprint) continues its upload. */
async function findResumable(db: Db, ownerId: string, name: string, request: UploadRequest): Promise<DriveRow | null> {
	if (!request.fingerprint || request.size === 0) return null;
	const [row] = await db
		.select()
		.from(driveItems)
		.where(
			and(
				eq(driveItems.ownerId, ownerId),
				request.parentId ? eq(driveItems.parentId, request.parentId) : isNull(driveItems.parentId),
				eq(driveItems.name, name),
				eq(driveItems.size, request.size),
				eq(driveItems.uploadFingerprint, request.fingerprint),
				eq(driveItems.status, "uploading"),
				gt(driveItems.uploadExpiresAt, new Date()),
			),
		)
		.limit(1);
	return row?.uploadId && row.uploadPartSize ? row : null;
}

async function recordedParts(db: Db, itemId: string) {
	return db
		.select({ partNumber: driveUploadParts.partNumber, etag: driveUploadParts.etag, size: driveUploadParts.size })
		.from(driveUploadParts)
		.where(eq(driveUploadParts.itemId, itemId))
		.orderBy(asc(driveUploadParts.partNumber));
}

type UploadMode = "direct" | "proxied";

/** Direct when the file's store can sign part URLs, so the browser sends the parts to it without Kite. */
async function uploadMode(env: CloudflareEnv, row: Pick<DriveRow, "storeId">): Promise<UploadMode> {
	return (await storeOfItem(env, row))?.signer ? "direct" : "proxied";
}

function uploadAnswer(row: DriveRow, uploaded: number[], resumed: boolean, mode: UploadMode): DriveAnswer {
	const partSize = row.uploadPartSize ?? DRIVE_PROXIED_PART_BYTES;
	return ok({ id: row.id, mode, partSize, parts: partCount(row.size, partSize), uploaded, resumed });
}

/** Turns a reserved row into a stored file and answers with it. */
async function finishRow(env: CloudflareEnv, user: DriveUser, row: DriveRow, size: number): Promise<DriveAnswer> {
	const db = getDb(env);
	const done = {
		size,
		status: "ready" as const,
		uploadId: null,
		uploadPartSize: null,
		uploadFingerprint: null,
		uploadExpiresAt: null,
		updatedAt: new Date(),
	};
	await db.update(driveItems).set(done).where(eq(driveItems.id, row.id));
	await db.delete(driveUploadParts).where(eq(driveUploadParts.itemId, row.id));
	const [item] = await toDriveItemDtos(db, [{ ...row, ...done }], () => (row.ownerId === user.id ? "owner" : "edit"));
	return ok({ item, complete: true });
}

/**
 * `POST /api/drive/uploads`. Reserves the quota and the row in one statement, then opens a multipart
 * upload. Uploads into a folder shared with edit rights count against the folder's owner.
 */
export async function startUpload(env: CloudflareEnv, user: DriveUser, body: unknown): Promise<DriveAnswer> {
	const store = await newDriveStore(env);
	const partSize = store.signer ? DRIVE_DIRECT_PART_BYTES : DRIVE_PROXIED_PART_BYTES;
	const request = parseUploadRequest(body, partSize);
	if ("error" in request) return fail(400, request.error);
	const db = getDb(env);
	const name = normalizeDriveName(request.name) ?? "Untitled";
	const ownerId = request.parentId ? (await editableFolder(db, user.id, request.parentId)).folder.ownerId : user.id;
	const resumable = await findResumable(db, ownerId, name, request);
	if (resumable)
		return uploadAnswer(
			resumable,
			(await recordedParts(db, resumable.id)).map((part) => part.partNumber),
			true,
			await uploadMode(env, resumable),
		);
	if ((await countUploadsInProgress(env, ownerId)) >= DRIVE_MAX_UPLOADS_IN_PROGRESS)
		return fail(429, "Too many uploads in progress; finish or cancel some first");
	const id = newId("drv");
	const now = new Date();
	const reserved = {
		id,
		ownerId,
		parentId: request.parentId,
		name,
		size: request.size,
		contentType: request.contentType,
		storeId: store.id,
		objectKey: driveObjectKey(id),
		uploadPartSize: request.size ? partSize : null,
		uploadFingerprint: request.fingerprint || null,
		uploadExpiresAt: new Date(now.getTime() + DRIVE_UPLOAD_RESUME_MS),
		sourceAttachmentId: null,
		now,
	};
	if (!(await reserveDriveFile(env, reserved, await getQuotaLimit(env, ownerId)))) return fail(413, QUOTA_ERROR);
	const row = (await getDriveItem(db, id))!;
	try {
		// Multipart uploads need at least one part, so an empty file is simply stored.
		if (request.size === 0) {
			await store.bucket.put(reserved.objectKey, new Uint8Array(0), {
				httpMetadata: { contentType: request.contentType },
			});
			return await finishRow(env, user, row, 0);
		}
		const upload = await multipartOf(store.bucket).create(reserved.objectKey, {
			httpMetadata: { contentType: request.contentType },
		});
		await db.update(driveItems).set({ uploadId: upload.uploadId }).where(eq(driveItems.id, id));
		return uploadAnswer({ ...row, uploadId: upload.uploadId }, [], false, store.signer ? "direct" : "proxied");
	} catch (error) {
		await db.delete(driveItems).where(eq(driveItems.id, id));
		throw error;
	}
}

/** An upload in progress the user may write to, or null. */
async function loadUpload(env: CloudflareEnv, user: DriveUser, id: string): Promise<DriveRow | null> {
	const db = getDb(env);
	const item = await getDriveItem(db, id);
	if (!item || item.status !== "uploading" || !item.uploadId || !item.objectKey) return null;
	if (item.uploadExpiresAt && item.uploadExpiresAt.getTime() <= Date.now()) return null;
	const { role } = await getDriveRole(db, user.id, item, { allowUploading: true });
	return canEditDrive(role) ? item : null;
}

async function multipartFor(env: CloudflareEnv, item: DriveRow) {
	const bucket = await bucketOfItem(env, item);
	return bucket ? multipartOf(bucket).resume(item.objectKey!, item.uploadId!) : null;
}

/**
 * `PUT /api/drive/uploads/[id]/parts/[n]`: the raw bytes of one part, streamed into the store. Every part
 * except the last must be exactly full size, and the declared length must match.
 */
export async function putUploadPart(
	env: CloudflareEnv,
	user: DriveUser,
	id: string,
	partNumber: number,
	request: Request,
): Promise<DriveAnswer> {
	const item = await loadUpload(env, user, id);
	const upload = item ? await multipartFor(env, item) : null;
	if (!item || !upload) return fail(404, "Upload not found");
	const expected = expectedPartSize(item.size, item.uploadPartSize ?? DRIVE_PROXIED_PART_BYTES, partNumber);
	if (expected === null) return fail(400, "Invalid part number");
	if (request.headers.get("content-type")?.startsWith("application/json")) {
		if ((await uploadMode(env, item)) !== "direct") return fail(409, "Send this upload's parts to Kite");
		// A direct upload reports the ETag the store gave the browser; completing checks it (InvalidPart).
		const etag = parsePartEtag(await request.json().catch(() => null));
		if (!etag) return fail(400, "Invalid part ETag");
		return recordPart(env, item.id, partNumber, etag, expected);
	}
	if (!request.body || Number(request.headers.get("content-length")) !== expected)
		return fail(400, "Invalid part size");
	const part = await upload.uploadPart(partNumber, request.body);
	return recordPart(env, item.id, partNumber, part.etag, expected);
}

async function recordPart(env: CloudflareEnv, itemId: string, partNumber: number, etag: string, size: number) {
	await getDb(env)
		.insert(driveUploadParts)
		.values({ itemId, partNumber, etag, size })
		.onConflictDoUpdate({
			target: [driveUploadParts.itemId, driveUploadParts.partNumber],
			set: { etag, size },
		});
	return ok({ partNumber, etag });
}

/**
 * `POST /api/drive/uploads/[id]/part-urls` `{ partNumbers }`: signed UploadPart URLs (15 minutes, at most 20),
 * each with the part's exact length signed in, so a part can never be larger than the reservation allows.
 */
export async function presignUploadParts(
	env: CloudflareEnv,
	user: DriveUser,
	id: string,
	body: unknown,
): Promise<DriveAnswer> {
	const item = await loadUpload(env, user, id);
	const signer = item ? (await storeOfItem(env, item))?.signer : undefined;
	if (!item) return fail(404, "Upload not found");
	if (!signer) return fail(409, "This upload goes through Kite; send the parts to Kite instead");
	const partSize = item.uploadPartSize ?? DRIVE_PROXIED_PART_BYTES;
	const partNumbers = parsePartNumbers(body, partCount(item.size, partSize));
	if (!partNumbers) return fail(400, "Ask for 1 to 20 part numbers of this upload");
	const urls = await Promise.all(
		partNumbers.map(async (partNumber) => ({
			partNumber,
			url: await signer.presignUploadPart(item.objectKey!, item.uploadId!, partNumber, {
				expiresIn: DRIVE_PART_URL_SECONDS,
				contentLength: expectedPartSize(item.size, partSize, partNumber)!,
			}),
		})),
	);
	return ok({ urls, expiresIn: DRIVE_PART_URL_SECONDS });
}

/** Removes an upload's row (its parts cascade) and what was sent. */
async function discardUpload(env: CloudflareEnv, item: DriveRow): Promise<void> {
	await (await multipartFor(env, item))?.abort().catch(() => undefined);
	await getDb(env).delete(driveItems).where(eq(driveItems.id, item.id));
}

/** `POST /api/drive/uploads/[id]/complete`: joins the recorded parts and checks the stored size. */
export async function completeUpload(env: CloudflareEnv, user: DriveUser, id: string): Promise<DriveAnswer> {
	const item = await loadUpload(env, user, id);
	const upload = item ? await multipartFor(env, item) : null;
	if (!item || !upload) return fail(404, "Upload not found");
	const parts = await recordedParts(getDb(env), item.id);
	const total = partCount(item.size, item.uploadPartSize ?? DRIVE_PROXIED_PART_BYTES);
	if (
		!partsComplete(
			parts.map((part) => part.partNumber),
			total,
		)
	)
		return fail(409, "Some parts are missing");
	let size: number;
	try {
		size = (await upload.complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag })))).size;
	} catch {
		return fail(409, "Could not complete the upload; send the parts again");
	}
	if (size !== item.size) {
		await (await bucketOfItem(env, item))?.delete(item.objectKey!);
		await getDb(env).delete(driveItems).where(eq(driveItems.id, item.id));
		return fail(409, "The uploaded file does not match its declared size");
	}
	return finishRow(env, user, item, size);
}

/** `DELETE /api/drive/uploads/[id]`: cancels the upload and frees its reservation. */
export async function abortUpload(env: CloudflareEnv, user: DriveUser, id: string): Promise<DriveAnswer> {
	const item = await loadUpload(env, user, id);
	if (!item) return notFound();
	await discardUpload(env, item);
	return ok({ ok: true });
}

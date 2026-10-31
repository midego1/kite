import { getDb } from "@/db";
import { attachmentDownloadGate, servesInline } from "@/lib/email/attachment-risk-store";
import { getInlineContentType } from "@/lib/http/content-type-utils";
import type { SessionUser } from "@/lib/auth/types";
import { getDriveItem, getDriveRole } from "./access";
import { readableAttachment } from "./attachments";
import { browserSigner, bucketOfItem, storeOfItem } from "./objects";
import { driveContentHeaders, driveEtag, requestedRange } from "./range-utils";
import type { DriveRow } from "./types";

const notStored = () =>
	Response.json(
		{ error: "The file's contents are not in storage. It may come from a backup restored without its files." },
		{ status: 404, headers: { "Cache-Control": "no-store" } },
	);

/**
 * Streams a stored file, same-origin, with `Range` and `If-Range` support for seeking and resumed downloads.
 * Inline only when asked for and the type is safe to render; otherwise an attachment.
 */
export async function streamDriveFile(
	env: CloudflareEnv,
	request: Request,
	item: DriveRow,
	download: boolean,
): Promise<Response> {
	if (item.kind !== "file" || item.status !== "ready" || !item.objectKey)
		return Response.json({ error: "Not found" }, { status: 404 });
	const headers = driveContentHeaders(item, !download);
	const etag = driveEtag(item);
	const range = requestedRange(request, etag, item.size);
	if (range === "invalid") {
		headers.set("Content-Range", `bytes */${item.size}`);
		return new Response(null, { status: 416, headers });
	}
	const bucket = await bucketOfItem(env, item);
	const object = range
		? await bucket?.get(item.objectKey, { range: { offset: range.start, length: range.end - range.start + 1 } })
		: await bucket?.get(item.objectKey);
	if (!object) return notStored();
	const body = request.method === "HEAD" ? null : object.body;
	if (!range) {
		headers.set("Content-Length", String(item.size));
		return new Response(body, { headers });
	}
	headers.set("Content-Range", `bytes ${range.start}-${range.end}/${item.size}`);
	headers.set("Content-Length", String(range.end - range.start + 1));
	return new Response(body, { status: 206, headers });
}

/** Streams a mail attachment the caller was already checked against, with the same safe headers. */
function streamAttachment(
	attachment: { id: string; filename: string; contentType: string; size: number; createdAt?: Date },
	object: { body: ReadableStream; size?: number },
	download: boolean,
): Response {
	const headers = driveContentHeaders(
		{ ...attachment, name: attachment.filename, updatedAt: attachment.createdAt ?? new Date(0) },
		!download,
	);
	headers.set("Content-Length", String(object.size ?? attachment.size));
	headers.delete("Accept-Ranges");
	return new Response(object.body, { headers });
}

const notFoundResponse = () => Response.json({ error: "Not found" }, { status: 404 });

/**
 * `GET /api/drive/files/[id]/content?disposition=`: a file the user can see; the owner may also open it
 * from the trash. Anything else answers the same 404.
 */
export async function userFileResponse(
	env: CloudflareEnv,
	user: Pick<SessionUser, "id">,
	request: Request,
	id: string,
): Promise<Response> {
	const db = getDb(env);
	const item = await getDriveItem(db, id);
	if (!item || item.kind !== "file") return notFoundResponse();
	const { role } = await getDriveRole(db, user.id, item, { allowTrashed: item.ownerId === user.id });
	if (!role) return notFoundResponse();
	const download = new URL(request.url).searchParams.get("disposition") === "attachment";
	if (download && request.method === "GET" && !request.headers.has("range")) {
		const redirect = await presignedDownload(env, item);
		if (redirect) return redirect;
	}
	return streamDriveFile(env, request, item, download);
}

/**
 * Downloads from this size on go straight to a store that can sign URLs, so the bytes skip the Worker.
 * @public Exercised by the unit tests.
 */
export const DRIVE_PRESIGNED_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const PRESIGNED_DOWNLOAD_SECONDS = 5 * 60;

/**
 * A 302 to a 5-minute signed GET that forces `attachment` and `application/octet-stream`, so the store never
 * renders the file. Public links never use this: they always stream through Kite.
 */
async function presignedDownload(env: CloudflareEnv, item: DriveRow): Promise<Response | null> {
	if (item.status !== "ready" || !item.objectKey || item.size < DRIVE_PRESIGNED_DOWNLOAD_BYTES) return null;
	const signer = browserSigner(env, await storeOfItem(env, item));
	if (!signer) return null;
	const url = await signer.presignGet(item.objectKey, {
		expiresIn: PRESIGNED_DOWNLOAD_SECONDS,
		filename: item.name,
		disposition: "attachment",
		contentType: "application/octet-stream",
	});
	return new Response(null, {
		status: 302,
		headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
	});
}

/**
 * `GET /api/drive/attachments/[id]/content`: by the same access rule and download gate (`?risk=1`, `?acknowledge=1`)
 * as the mail attachment route.
 */
export async function attachmentResponse(
	env: CloudflareEnv,
	user: SessionUser,
	request: Request,
	id: string,
): Promise<Response> {
	const source = await readableAttachment(env, user, id);
	if (!source) return notFoundResponse();
	const download = new URL(request.url).searchParams.get("disposition") === "attachment";
	const inline = servesInline(
		source.attachment,
		!download && getInlineContentType(source.attachment.contentType) !== null,
	);
	const refused = await attachmentDownloadGate(env, request, source.attachment, source.file, inline);
	if (refused) return refused;
	// A flagged name declared as an image still downloads as an attachment.
	return streamAttachment(
		{ ...source.attachment, createdAt: source.attachment.createdAt ?? undefined },
		source.file,
		!inline,
	);
}

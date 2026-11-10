import type { SessionUser } from "@/lib/auth/types";
import { createLogger } from "@/lib/logger.mjs";
import { attachmentRiskRefusal, readableAttachment, sizedBody } from "./attachments";
import { withMountUploadSlot } from "./mount-uploads";
import { answerDrive, DriveRefusal, fail, notFound, ok } from "./errors";
import { normalizeDriveName } from "./name-utils";
import { driveContentHeaders } from "./range-utils";
import type { DriveAnswer, DriveUser } from "./types";
import { normalizeUploadContentType } from "./upload-utils";
import { timedBody, WebdavError, type WebdavClient } from "./webdav-client";
import { joinMountPath, mountPathName, normalizeMountPath, type MountPath } from "./webdav-path-utils";
import {
	mountCredentials,
	ownedMount,
	recordMountStatus,
	toMountDto,
	webdavClient,
	type DriveMountRow,
} from "./mounts";
import {
	parseMountMove,
	parseMountUpload,
	sortMountItems,
	toMountItemDto,
	WEBDAV_MAX_UPLOAD_BYTES,
	webdavFailure,
} from "./mount-utils";

const log = createLogger("drive");

/**
 * Runs one operation on the caller's own linked folder: a refused password marks the folder (so Drive asks for
 * it again) and a success clears that mark. Errors become answers with Kite's own wording.
 */
async function withMount(
	env: CloudflareEnv,
	user: DriveUser,
	id: string,
	run: (client: WebdavClient, row: DriveMountRow) => Promise<DriveAnswer>,
): Promise<DriveAnswer> {
	const row = await ownedMount(env, user, id);
	const client = webdavClient(env, await mountCredentials(env, row));
	try {
		const answer = await run(client, row);
		await recordMountStatus(env, row, false);
		return answer;
	} catch (error) {
		if (!(error instanceof WebdavError)) throw error;
		if (error.kind === "auth") await recordMountStatus(env, row, true, error.message);
		log.warn("drive.mount_request_failed", { mountId: row.id, kind: error.kind, status: error.status ?? null });
		return webdavFailure(error);
	}
}

function pathParam(value: unknown): MountPath {
	const path = normalizeMountPath(value ?? "/");
	if (!path) throw new DriveRefusal(400, "Invalid path");
	return path;
}

/** `GET /api/drive/mounts/[id]/items?path=`: the folder at `path` (Depth 1), folders first. */
export async function listMountItems(env: CloudflareEnv, user: DriveUser, id: string, path: unknown) {
	const folder = pathParam(path);
	return withMount(env, user, id, async (client, row) => {
		const items = sortMountItems((await client.list(folder)).map(toMountItemDto));
		return ok({ mount: toMountDto({ ...row, status: "ok", lastError: null }), path: folder, items });
	});
}

/** `POST /api/drive/mounts/[id]/folders` `{ parent, name }`: MKCOL. */
export async function createMountFolder(env: CloudflareEnv, user: DriveUser, id: string, body: unknown) {
	const value = (body ?? {}) as { parent?: unknown; name?: unknown };
	const parent = pathParam(value.parent);
	const name = normalizeDriveName(value.name);
	if (!name) return fail(400, "Enter a name");
	return withMount(env, user, id, async (client) => {
		const path = joinMountPath(parent, name);
		await client.mkcol(path);
		return ok({ item: { path, name, kind: "folder", size: 0, contentType: null, updatedAt: null } }, 201);
	});
}

/** `PATCH /api/drive/mounts/[id]/items` `{ path, name?, parent? }`: MOVE, never over an existing item. */
export async function moveMountItem(env: CloudflareEnv, user: DriveUser, id: string, body: unknown) {
	const move = parseMountMove(body);
	if ("error" in move) return fail(400, move.error);
	return withMount(env, user, id, async (client) => {
		const item = await client.stat(move.from);
		await client.move(move.from, move.to, item.kind === "folder");
		return ok({ item: toMountItemDto({ ...item, path: move.to }) });
	});
}

/** `DELETE /api/drive/mounts/[id]/items?path=`: deletes on the server, at once; there is no Kite trash for it. */
export async function deleteMountItem(env: CloudflareEnv, user: DriveUser, id: string, path: unknown) {
	const target = pathParam(path);
	if (target === "/") return fail(400, "The linked folder itself cannot be deleted; unlink it instead");
	return withMount(env, user, id, async (client) => {
		const item = await client.stat(target);
		await client.delete(target, item.kind === "folder");
		return ok({ ok: true });
	});
}

const json = (answer: DriveAnswer) =>
	Response.json(answer.body, { status: answer.status, headers: { "Cache-Control": "no-store" } });

/**
 * `GET /api/drive/mounts/[id]/content?path=&disposition=`: streams a file from the server with Range passed
 * through. The same safe headers as a Drive file: inline only for types safe to render, otherwise an attachment.
 */
export async function mountFileResponse(
	env: CloudflareEnv,
	user: DriveUser,
	request: Request,
	id: string,
): Promise<Response> {
	const url = new URL(request.url);
	const file: { upstream?: Response; name?: string } = {};
	const answer = await answerDrive(env, () =>
		withMount(env, user, id, async (client) => {
			const path = pathParam(url.searchParams.get("path"));
			if (path === "/") return notFound();
			file.name = mountPathName(path);
			file.upstream = await client.get(path, {
				range: request.headers.get("range"),
				ifRange: request.headers.get("if-range"),
			});
			return ok({});
		}),
	);
	if (!file.upstream) return json(answer);
	return proxiedFile(
		file.upstream,
		file.name ?? "file",
		url.searchParams.get("disposition") === "attachment",
		request.method,
	);
}

function proxiedFile(upstream: Response, name: string, download: boolean, method: string): Response {
	const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
	const headers = driveContentHeaders({ id: "webdav", name, contentType, size: 0, updatedAt: new Date(0) }, !download);
	const etag = upstream.headers.get("etag");
	if (etag) headers.set("ETag", etag);
	else headers.delete("ETag");
	// Kite asks for identity; a server that compresses anyway has its body decoded by the runtime, and then its
	// stated length no longer matches the bytes passed on.
	const encoding = upstream.headers.get("content-encoding")?.trim().toLowerCase();
	const decoded = !!encoding && encoding !== "identity";
	for (const header of decoded ? ["last-modified"] : ["content-length", "content-range", "last-modified"]) {
		const value = upstream.headers.get(header);
		if (value) headers.set(header, value);
	}
	if (upstream.headers.get("accept-ranges") !== "bytes" && upstream.status !== 206) headers.delete("Accept-Ranges");
	const body = method === "HEAD" || !upstream.body ? null : timedBody(upstream.body);
	if (!body) void upstream.body?.cancel().catch(() => undefined);
	return new Response(body, { status: upstream.status, headers });
}

/** `PUT /api/drive/mounts/[id]/content?parent=&name=`: the request body is streamed to the server. */
export async function uploadMountFile(
	env: CloudflareEnv,
	user: DriveUser,
	request: Request,
	id: string,
): Promise<DriveAnswer> {
	const upload = parseMountUpload(new URL(request.url), request.headers);
	if ("error" in upload) {
		await request.body?.cancel().catch(() => undefined);
		return fail(upload.status, upload.error);
	}
	const answer = await withMountUploadSlot(env, user.id, upload.size, () =>
		withMount(env, user, id, async (client) => {
			const body = request.body ? sizedBody(request.body, upload.size) : new Uint8Array();
			await client.put(upload.path, body, upload.size, upload.contentType);
			return ok({ item: newFile(upload.path, upload.size, upload.contentType) }, 201);
		}),
	);
	if (answer.status >= 400) await request.body?.cancel().catch(() => undefined);
	return answer;
}

const newFile = (path: MountPath, size: number, contentType: string) => ({
	path,
	name: mountPathName(path),
	kind: "file" as const,
	size,
	contentType,
	updatedAt: new Date().toISOString(),
});

/**
 * `POST /api/drive/attachments/[id]/save` `{ mountId, path, acknowledge? }`: copies a readable attachment into a
 * folder of the caller's linked folder, under the same risk gate as Save to Drive. It never replaces a file.
 */
export async function saveAttachmentToMount(
	env: CloudflareEnv,
	user: SessionUser,
	attachmentId: string,
	body: unknown,
): Promise<DriveAnswer> {
	const value = (body ?? {}) as { mountId?: unknown; path?: unknown; name?: unknown; acknowledge?: unknown };
	if (typeof value.mountId !== "string" || !value.mountId) return fail(400, "Invalid folder");
	const folder = pathParam(value.path);
	// The folder and its credentials are checked before the attachment is opened, so a refusal leaves no stream open.
	const row = await ownedMount(env, user, value.mountId);
	await mountCredentials(env, row);
	const source = await readableAttachment(env, user, attachmentId);
	if (!source) return notFound();
	const refused = await attachmentRiskRefusal(env, source, value.acknowledge === true);
	if (refused) return refused;
	const size = source.file.size;
	if (size > WEBDAV_MAX_UPLOAD_BYTES) {
		await source.file.body.cancel().catch(() => undefined);
		return fail(413, "Files larger than 100 MB cannot be saved to a linked folder yet");
	}
	const name = normalizeDriveName(value.name ?? source.attachment.filename) ?? "Attachment";
	const contentType = normalizeUploadContentType(source.attachment.contentType);
	const answer = await withMountUploadSlot(env, user.id, size, () =>
		withMount(env, user, row.id, async (client) => {
			const path = joinMountPath(folder, name);
			await client.put(path, sizedBody(source.file.body, size), size, contentType);
			return ok({ item: newFile(path, size, contentType) }, 201);
		}),
	);
	if (answer.status >= 400) await source.file.body.cancel().catch(() => undefined);
	return answer;
}

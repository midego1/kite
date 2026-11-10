import type { WebdavError, WebdavErrorKind, WebdavItem } from "./webdav-client";
import {
	isWithinMountPath,
	joinMountPath,
	mountPathName,
	normalizeMountPath,
	parentMountPath,
	parseWebdavUrl,
	type MountPath,
} from "./webdav-path-utils";
import { normalizeDriveName } from "./name-utils";
import { normalizeUploadContentType } from "./upload-utils";
import type { DriveAnswer, DriveMountItemDto as MountItemDto } from "./types";

export type MountCredentials = { label: string; url: URL; username: string; password: string };

/**
 * The largest file a linked folder takes in one upload: the Worker's request body limit on the smaller
 * Cloudflare plans. Bigger files would need Nextcloud's chunked upload, which is not built yet.
 */
export const WEBDAV_MAX_UPLOAD_BYTES = 100_000_000;

const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** @public Exercised by the unit tests. A label from the address when none is given: the folder's last segment, else the host. */
export function labelFromUrl(url: URL): string {
	const segments = url.pathname.split("/").filter(Boolean);
	let last = segments.at(-1) ?? "";
	try {
		last = decodeURIComponent(last);
	} catch {
		// An undecodable segment is used as it is.
	}
	return normalizeDriveName(last) ?? url.hostname;
}

type Saved = { label: string; baseUrl: string; username: string; password: string | null };

function parseUsername(value: unknown, saved: string | undefined): string | { error: string } {
	const username = typeof value === "string" ? value.trim() : (saved ?? "");
	if (!username) return { error: "Enter the username" };
	if (username.length > MAX_USERNAME_LENGTH || CONTROL.test(username)) return { error: "The username is not valid" };
	return username;
}

/**
 * The typed password, else the saved one on an edit that keeps the address and username. A saved password is never
 * sent anywhere else: after a change of address or username it must be typed again.
 */
function parsePassword(value: unknown, saved: string | null | undefined, reuse: boolean): string | { error: string } {
	const typed = typeof value === "string" ? value : "";
	if (!typed && saved && !reuse) return { error: "Enter the app password again for the new address or username" };
	const password = typed || saved || "";
	if (!password) return { error: "Enter the app password" };
	if (password.length > MAX_PASSWORD_LENGTH || CONTROL.test(password))
		return { error: "The app password is not valid; paste only the password itself" };
	return password;
}

/**
 * The fields of the link form, or the first problem with them. With `saved` (an edit), missing fields keep their
 * saved values, and an empty password keeps the saved one only while the address and username stay the same.
 */
export function parseMountCredentials(body: unknown, saved: Saved | null): MountCredentials | { error: string } {
	if (!body || typeof body !== "object") return { error: "Invalid request" };
	const value = body as Record<string, unknown>;
	const { url, error } = parseWebdavUrl(value.url ?? saved?.baseUrl);
	if (!url) return { error };
	const username = parseUsername(value.username, saved?.username);
	if (typeof username !== "string") return username;
	const sameTarget = !!saved && url.href === saved.baseUrl && username === saved.username;
	const password = parsePassword(value.password, saved?.password, sameTarget);
	if (typeof password !== "string") return password;
	const label =
		value.label === undefined || value.label === ""
			? (saved?.label ?? labelFromUrl(url))
			: normalizeDriveName(value.label);
	if (!label) return { error: "Enter a name for the folder" };
	return { label, url, username, password };
}

const FAILURES: Record<WebdavErrorKind, { status: number; code: string }> = {
	auth: { status: 502, code: "WEBDAV_AUTH" },
	forbidden: { status: 403, code: "WEBDAV_FORBIDDEN" },
	not_found: { status: 404, code: "WEBDAV_NOT_FOUND" },
	not_folder: { status: 400, code: "WEBDAV_NOT_FOLDER" },
	exists: { status: 409, code: "WEBDAV_EXISTS" },
	conflict: { status: 409, code: "WEBDAV_CONFLICT" },
	too_large: { status: 413, code: "WEBDAV_TOO_LARGE" },
	insufficient_storage: { status: 507, code: "WEBDAV_INSUFFICIENT_STORAGE" },
	blocked: { status: 400, code: "WEBDAV_BLOCKED" },
	unreachable: { status: 502, code: "WEBDAV_UNREACHABLE" },
	timeout: { status: 504, code: "WEBDAV_TIMEOUT" },
	invalid_answer: { status: 502, code: "WEBDAV_INVALID_ANSWER" },
	server: { status: 502, code: "WEBDAV_SERVER" },
};

/** A WebDAV failure as a route answer. Messages are Kite's own; nothing the server sent is passed on. */
export function webdavFailure(error: Pick<WebdavError, "kind" | "message">): DriveAnswer {
	const { status, code } = FAILURES[error.kind];
	return { status, body: { error: error.message, code } };
}

export function toMountItemDto(item: WebdavItem): MountItemDto {
	return {
		path: item.path,
		name: mountPathName(item.path),
		kind: item.kind,
		size: item.size,
		contentType: item.contentType,
		updatedAt: item.updatedAt,
	};
}

/** Folders first, then by name, as the Drive listing sorts. */
export function sortMountItems(items: MountItemDto[]): MountItemDto[] {
	return [...items].sort(
		(a, b) =>
			(a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) ||
			a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
	);
}

export type MountUpload = { path: MountPath; name: string; size: number; contentType: string };

/**
 * `PUT …/content?parent=&name=`: the target of a streamed upload, from the query and the request's declared
 * length, which is required so the server gets a fixed-length body and the size limit is checked up front.
 */
export function parseMountUpload(url: URL, headers: Headers): MountUpload | { status: number; error: string } {
	const parent = normalizeMountPath(url.searchParams.get("parent") ?? "/");
	const name = normalizeDriveName(url.searchParams.get("name"));
	if (!parent || !name) return { status: 400, error: "Invalid file name or folder" };
	const length = headers.get("content-length");
	const size = length && /^\d{1,15}$/.test(length) ? Number(length) : NaN;
	if (!Number.isSafeInteger(size)) return { status: 411, error: "The upload needs a Content-Length" };
	if (size > WEBDAV_MAX_UPLOAD_BYTES)
		return { status: 413, error: "Files larger than 100 MB cannot be uploaded to a linked folder yet" };
	return {
		path: joinMountPath(parent, name),
		name,
		size,
		contentType: normalizeUploadContentType(headers.get("content-type")),
	};
}

export type MountMove = { from: MountPath; to: MountPath };

/** `PATCH …/items` `{ path, name?, parent? }`: rename (a new name), move (a new parent folder) or both. */
export function parseMountMove(body: unknown): MountMove | { error: string } {
	if (!body || typeof body !== "object") return { error: "Invalid request" };
	const value = body as Record<string, unknown>;
	const from = normalizeMountPath(value.path);
	if (!from || from === "/") return { error: "Invalid item" };
	const parent = value.parent === undefined ? parentMountPath(from) : normalizeMountPath(value.parent);
	const name = value.name === undefined ? mountPathName(from) : normalizeDriveName(value.name);
	if (!parent) return { error: "Invalid folder" };
	if (!name) return { error: "Enter a name" };
	const to = joinMountPath(parent, name);
	if (to === from) return { error: "Nothing to change" };
	if (isWithinMountPath(to, from)) return { error: "A folder cannot be moved into itself" };
	return { from, to };
}

import { hrefToMountPath, mountUrl, parentMountPath, type MountPath } from "./webdav-path-utils";
import { parseMultistatus, PROPFIND_BODY, WebdavXmlError, type DavEntry } from "./webdav-xml-utils";

/**
 * A WebDAV client over `fetch`, so it runs the same on Workers and Node. Every request (and every redirect it
 * follows) passes the address guard first; credentials go only to the linked folder's own origin; each request
 * has a deadline for its answer, and PROPFIND bodies are read up to a size cap before they are parsed.
 */

export type WebdavErrorKind =
	| "auth"
	| "forbidden"
	| "not_found"
	| "not_folder"
	| "exists"
	| "conflict"
	| "too_large"
	| "insufficient_storage"
	| "blocked"
	| "unreachable"
	| "timeout"
	| "invalid_answer"
	| "server";

export class WebdavError extends Error {
	constructor(
		readonly kind: WebdavErrorKind,
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

export type WebdavTarget = { url: URL; username: string; password: string };

export type WebdavDeps = {
	/** Checks an address before anything is sent to it; throws (any error) to refuse it. */
	guard: (url: URL) => Promise<void>;
	fetch?: typeof fetch;
	/** How long the server has to start answering. */
	timeoutMs?: number;
};

export type WebdavItem = {
	path: MountPath;
	kind: "file" | "folder";
	size: number;
	contentType: string | null;
	updatedAt: string | null;
	etag: string | null;
};

/** @public Exercised by the unit tests. */
export const WEBDAV_LIMITS = {
	timeoutMs: 20_000,
	maxRedirects: 3,
	maxPropfindBytes: 4 * 1024 * 1024,
	maxEntries: 5_000,
	/** An upload's body is sent before the answer can start, so its deadline also allows this many bytes a second. */
	minUploadBytesPerSecond: 256 * 1024,
};

const STATUS_MESSAGES: Partial<Record<WebdavErrorKind, string>> = {
	auth: "The server refused the username or app password",
	forbidden: "The server does not allow this",
	not_found: "This file or folder no longer exists on the server",
	exists: "An item with this name already exists there",
	conflict: "The folder it belongs in no longer exists on the server",
	too_large: "The server refused a file this large",
	insufficient_storage: "The server has no space left for this file",
};

/** The error for a status the operation did not expect. */
function statusError(status: number, overrides: Partial<Record<number, WebdavErrorKind>> = {}): WebdavError {
	const kind: WebdavErrorKind =
		overrides[status] ??
		(status === 401
			? "auth"
			: status === 403
				? "forbidden"
				: status === 404
					? "not_found"
					: status === 413
						? "too_large"
						: status === 507
							? "insufficient_storage"
							: "server");
	return new WebdavError(kind, STATUS_MESSAGES[kind] ?? `The server answered ${status}`, status);
}

function basicAuth(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

const isRedirect = (status: number) => [301, 302, 303, 307, 308].includes(status);

async function discard(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

/** Reads a body up to `max` bytes as text, refusing anything larger without buffering it. */
async function readCapped(response: Response, max: number): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) {
		await discard(response);
		throw new WebdavError("invalid_answer", "The server's answer is too large");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => undefined);
			throw new WebdavError("invalid_answer", "The server's answer is too large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

type RequestOptions = {
	headers?: Record<string, string>;
	body?: BodyInit | null;
	/** GET and PROPFIND only: a request with a streamed body cannot be sent twice. */
	followRedirects?: boolean;
	/** Keep the deadline while the body is read (PROPFIND), instead of clearing it once headers arrive. */
	deadlineCoversBody?: boolean;
	/** Replaces the client's deadline (an upload's grows with its size). */
	timeoutMs?: number;
};

export class WebdavClient {
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(
		private readonly target: WebdavTarget,
		private readonly deps: WebdavDeps,
	) {
		this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
		this.timeoutMs = deps.timeoutMs ?? WEBDAV_LIMITS.timeoutMs;
	}

	private async send(
		method: string,
		url: URL,
		options: RequestOptions,
	): Promise<{ response: Response; finish: () => void }> {
		let current = url;
		for (let hop = 0; ; hop++) {
			try {
				await this.deps.guard(current);
			} catch (error) {
				throw new WebdavError("blocked", error instanceof Error ? error.message : "This address is not allowed");
			}
			const sameOrigin = current.origin === this.target.url.origin;
			// Credentials never leave the linked folder's origin; a redirect elsewhere is followed only by GET.
			if (!sameOrigin && method !== "GET") throw new WebdavError("server", "The server redirected to another address");
			const { response, finish } = await this.fetchOnce(method, current, sameOrigin, options);
			const location = response.headers.get("location");
			if (!isRedirect(response.status) || !location || !options.followRedirects) {
				if (!options.deadlineCoversBody) finish();
				if (isRedirect(response.status)) {
					await discard(response);
					throw new WebdavError("server", "The server redirected the request");
				}
				return { response, finish };
			}
			finish();
			await discard(response);
			if (hop >= WEBDAV_LIMITS.maxRedirects) throw new WebdavError("server", "The server redirected too many times");
			try {
				current = new URL(location, current);
			} catch {
				throw new WebdavError("server", "The server redirected to an invalid address");
			}
			if (current.protocol !== "https:" && current.protocol !== "http:")
				throw new WebdavError("blocked", "The server redirected to an unsupported address");
		}
	}

	/** One request under its own deadline; `finish` clears the deadline (after the body, for PROPFIND). */
	private async fetchOnce(
		method: string,
		url: URL,
		sameOrigin: boolean,
		options: RequestOptions,
	): Promise<{ response: Response; finish: () => void }> {
		const headers: Record<string, string> = { "User-Agent": "Kite-WebDAV", ...options.headers };
		if (sameOrigin) headers.Authorization = basicAuth(this.target.username, this.target.password);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
		const finish = () => clearTimeout(timer);
		try {
			const response = await this.fetchImpl(url.href, {
				method,
				headers,
				body: options.body ?? null,
				redirect: "manual",
				signal: controller.signal,
				...(options.body instanceof ReadableStream ? { duplex: "half" } : {}),
			} as RequestInit);
			return { response, finish };
		} catch (error) {
			finish();
			if (controller.signal.aborted) throw new WebdavError("timeout", "The server did not answer in time");
			throw new WebdavError("unreachable", unreachableMessage(error));
		}
	}

	/** PROPFIND at `depth`, as entries with paths relative to the linked folder; foreign hrefs are dropped. */
	async propfind(path: MountPath, depth: 0 | 1): Promise<(DavEntry & { path: MountPath })[]> {
		// A listing asks for the folder form (`…/`); Depth 0 asks without, since some servers refuse a file with a
		// trailing slash, and a folder asked without one usually redirects to it on the same origin.
		const { response, finish } = await this.send("PROPFIND", mountUrl(this.target.url, path, depth === 1), {
			headers: { Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" },
			body: PROPFIND_BODY,
			followRedirects: true,
			deadlineCoversBody: true,
		});
		try {
			if (response.status !== 207) {
				await discard(response);
				throw statusError(response.status);
			}
			const text = await readCapped(response, WEBDAV_LIMITS.maxPropfindBytes);
			const entries = parseMultistatus(text);
			if (entries.length > WEBDAV_LIMITS.maxEntries + 1)
				throw new WebdavError("invalid_answer", `This folder has more than ${WEBDAV_LIMITS.maxEntries} items`);
			return entries.flatMap((entry) => {
				const entryPath = hrefToMountPath(entry.href, this.target.url);
				return entryPath ? [{ ...entry, path: entryPath }] : [];
			});
		} catch (error) {
			if (error instanceof WebdavXmlError)
				throw new WebdavError("invalid_answer", "The server's answer is not a WebDAV listing");
			if (error instanceof WebdavError) throw error;
			if (error instanceof Error && error.name === "AbortError")
				throw new WebdavError("timeout", "The server did not answer in time");
			throw new WebdavError("unreachable", "The server stopped answering");
		} finally {
			finish();
		}
	}

	/** The item at `path` (Depth 0). */
	async stat(path: MountPath): Promise<WebdavItem> {
		const entries = await this.propfind(path, 0);
		const self = entries.find((entry) => entry.path === path) ?? entries[0];
		if (!self) throw new WebdavError("invalid_answer", "The server's answer is not a WebDAV listing");
		return toItem({ ...self, path });
	}

	/** The items directly inside the folder at `path` (Depth 1), without the folder itself. */
	async list(path: MountPath): Promise<WebdavItem[]> {
		const entries = await this.propfind(path, 1);
		const self = entries.find((entry) => entry.path === path);
		if (self && !self.collection) throw new WebdavError("not_folder", "This is a file, not a folder");
		const children = new Map<MountPath, WebdavItem>();
		for (const entry of entries)
			if (entry.path !== path && parentMountPath(entry.path) === path && !children.has(entry.path))
				children.set(entry.path, toItem(entry));
		return [...children.values()];
	}

	/** GET, streamed; `range` and `ifRange` are passed through so seeking and resumed downloads work. */
	async get(path: MountPath, range: { range?: string | null; ifRange?: string | null } = {}): Promise<Response> {
		const headers: Record<string, string> = {};
		if (range.range) headers.Range = range.range;
		if (range.ifRange) headers["If-Range"] = range.ifRange;
		const { response } = await this.send("GET", mountUrl(this.target.url, path), { headers, followRedirects: true });
		if (response.status === 200 || response.status === 206 || response.status === 416) return response;
		await discard(response);
		throw statusError(response.status);
	}

	/** PUT a new file; it never replaces one (`If-None-Match: *`), so an upload cannot overwrite silently. */
	async put(path: MountPath, body: ReadableStream | Uint8Array, size: number, contentType: string): Promise<void> {
		const { response } = await this.send("PUT", mountUrl(this.target.url, path), {
			headers: { "Content-Type": contentType, "Content-Length": String(size), "If-None-Match": "*" },
			body: body as BodyInit,
			timeoutMs: this.timeoutMs + Math.ceil((size / WEBDAV_LIMITS.minUploadBytesPerSecond) * 1000),
		});
		await discard(response);
		if (response.status !== 201 && response.status !== 204 && response.status !== 200)
			throw statusError(response.status, { 412: "exists", 409: "conflict" });
	}

	async mkcol(path: MountPath): Promise<void> {
		const { response } = await this.send("MKCOL", mountUrl(this.target.url, path, true), {});
		await discard(response);
		if (response.status !== 201) throw statusError(response.status, { 405: "exists", 409: "conflict" });
	}

	/** MOVE without overwriting (`Overwrite: F`). */
	async move(from: MountPath, to: MountPath, folder: boolean): Promise<void> {
		const { response } = await this.send("MOVE", mountUrl(this.target.url, from, folder), {
			headers: { Destination: mountUrl(this.target.url, to, folder).href, Overwrite: "F" },
		});
		await discard(response);
		if (response.status !== 201 && response.status !== 204)
			throw statusError(response.status, { 412: "exists", 409: "conflict" });
	}

	async delete(path: MountPath, folder: boolean): Promise<void> {
		const { response } = await this.send("DELETE", mountUrl(this.target.url, path, folder), {});
		await discard(response);
		// 207 means some members could not be deleted.
		if (response.status !== 204 && response.status !== 200)
			throw response.status === 207
				? new WebdavError("server", "The server could not delete everything in this folder")
				: statusError(response.status);
	}
}

function toItem(entry: DavEntry & { path: MountPath }): WebdavItem {
	return {
		path: entry.path,
		kind: entry.collection ? "folder" : "file",
		size: entry.collection ? 0 : (entry.size ?? 0),
		contentType: entry.collection ? null : entry.contentType,
		updatedAt: entry.lastModified,
		etag: entry.etag,
	};
}

/** A plain reason without the address or anything else the runtime put in the error. */
function unreachableMessage(error: unknown): string {
	const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : "";
	if (/certificate|ssl|tls/i.test(text)) return "Could not make a secure connection to the server";
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(text)) return "Could not find the server";
	return "Could not reach the server";
}

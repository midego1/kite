import { authFetch, getAuthHeaders } from "@/lib/auth/client";
import type { DriveItemDto } from "@/lib/drive/types";
import { driveError } from "./drive-api";
import { uploadFingerprint } from "./drive-utils";

const PART_RETRIES = 3;
/** Part URLs are fetched a few at a time, just before use, so a slow upload never meets an expired one. */
const URLS_PER_BATCH = 4;

type UploadSession = {
	id?: string;
	mode?: "direct" | "proxied";
	partSize?: number;
	parts?: number;
	uploaded?: number[];
	resumed?: boolean;
	complete?: boolean;
	item?: DriveItemDto;
};

export class UploadCancelled extends Error {
	constructor() {
		super("Upload cancelled");
	}
}

type PartTarget = {
	url: string;
	/** Direct parts go to the store: no cookies and no Kite headers, so the CSRF token never leaves Kite. */
	direct: boolean;
};

// XMLHttpRequest rather than fetch, because only it reports upload progress.
function putPart(
	target: PartTarget,
	chunk: Blob,
	onBytes: (loaded: number) => void,
	signal: AbortSignal,
): Promise<string | null> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new UploadCancelled());
		const request = new XMLHttpRequest();
		const onAbort = () => request.abort();
		request.onloadend = () => signal.removeEventListener("abort", onAbort);
		request.open("PUT", target.url);
		if (target.direct) request.withCredentials = false;
		else
			getAuthHeaders({ "Content-Type": "application/octet-stream" }).forEach((value, name) =>
				request.setRequestHeader(name, value),
			);
		request.upload.onprogress = (event) => {
			if (event.lengthComputable) onBytes(event.loaded);
		};
		request.onload = () => {
			if (request.status >= 200 && request.status < 300)
				return resolve(target.direct ? request.getResponseHeader("ETag") : null);
			let message: string | undefined;
			try {
				message = (JSON.parse(request.responseText) as { error?: string }).error;
			} catch {
				// Not JSON; the status is all there is.
			}
			reject(new Error(message ?? `Upload failed (${request.status})`));
		};
		request.onerror = () => reject(new Error("Upload failed: network error"));
		request.onabort = () => reject(new UploadCancelled());
		signal.addEventListener("abort", onAbort, { once: true });
		request.send(chunk);
	});
}

async function startSession(file: File, parentId: string | null): Promise<UploadSession> {
	const response = await authFetch("/api/drive/uploads", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: file.name,
			size: file.size,
			contentType: file.type || "application/octet-stream",
			parentId,
			fingerprint: uploadFingerprint(file),
		}),
	});
	if (!response.ok) throw new Error(await driveError(response, "Could not start the upload"));
	return (await response.json()) as UploadSession;
}

async function sendPart(
	target: () => Promise<PartTarget>,
	chunk: Blob,
	onBytes: (loaded: number) => void,
	signal: AbortSignal,
) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await putPart(await target(), chunk, onBytes, signal);
		} catch (error) {
			if (error instanceof UploadCancelled || attempt >= PART_RETRIES) throw error;
		}
	}
}

const uploadPath = (id: string, suffix = "") => `/api/drive/uploads/${encodeURIComponent(id)}${suffix}`;

/** Signed URLs for the next few parts of a direct upload, fetched again when one has expired. */
function directTargets(id: string, pending: number[], signal: AbortSignal) {
	const urls = new Map<number, string>();
	return async (partNumber: number, retry: boolean): Promise<PartTarget> => {
		if (retry || !urls.has(partNumber)) {
			const start = pending.indexOf(partNumber);
			const partNumbers = pending.slice(start, start + URLS_PER_BATCH);
			const response = await authFetch(uploadPath(id, "/part-urls"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ partNumbers }),
				signal,
			});
			if (!response.ok) throw new Error(await driveError(response, "Could not prepare the upload"));
			for (const entry of ((await response.json()) as { urls: { partNumber: number; url: string }[] }).urls)
				urls.set(entry.partNumber, entry.url);
		}
		return { url: urls.get(partNumber)!, direct: true };
	};
}

async function reportEtag(id: string, partNumber: number, etag: string | null, signal: AbortSignal) {
	if (!etag) throw new Error("The store did not return the part's ETag; check its CORS rule");
	const response = await authFetch(uploadPath(id, `/parts/${partNumber}`), {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ etag }),
		signal,
	});
	if (!response.ok) throw new Error(await driveError(response, "Could not record the uploaded part"));
}

/**
 * Uploads a file in parts, then completes it. Proxied parts are raw request bodies to Kite; direct parts go to
 * the store with signed URLs, and Kite records the ETag each one returned. The server keeps the parts it
 * stored, so picking the same file again into the same folder after a reload continues where it stopped.
 * Aborting `signal` cancels the upload and discards what was sent.
 */
export async function uploadDriveFile(
	file: File,
	parentId: string | null,
	onProgress: (percent: number, resumed: boolean) => void,
	signal: AbortSignal,
): Promise<void> {
	const session = await startSession(file, parentId);
	if (session.complete) return;
	const { id, partSize, parts } = session as { id: string; partSize: number; parts: number };
	const direct = session.mode === "direct";
	const stored = new Set(session.uploaded ?? []);
	const resumed = !!session.resumed;
	const partBytes = (index: number) => Math.max(0, Math.min(partSize, file.size - index * partSize));
	let sent = [...stored].reduce((total, part) => total + partBytes(part - 1), 0);
	// Held at 99% until the server has assembled the parts.
	const report = (bytes: number) => onProgress(Math.min(99, Math.floor((bytes / file.size) * 100)), resumed);
	report(sent);
	const pending = Array.from({ length: parts }, (_, index) => index + 1).filter((part) => !stored.has(part));
	const signed = direct ? directTargets(id, pending, signal) : null;
	try {
		for (const partNumber of pending) {
			if (signal.aborted) throw new UploadCancelled();
			const chunk = file.slice((partNumber - 1) * partSize, partNumber * partSize);
			let attempt = 0;
			const target = async () =>
				signed ? signed(partNumber, attempt++ > 0) : { url: uploadPath(id, `/parts/${partNumber}`), direct: false };
			const etag = await sendPart(target, chunk, (loaded) => report(sent + loaded), signal);
			if (direct) await reportEtag(id, partNumber, etag, signal);
			sent += chunk.size;
			report(sent);
		}
		const finish = await authFetch(uploadPath(id, "/complete"), { method: "POST", signal });
		if (!finish.ok) throw new Error(await driveError(finish, "Could not finish the upload"));
	} catch (error) {
		if (signal.aborted) await authFetch(uploadPath(id), { method: "DELETE" }).catch(() => undefined);
		throw signal.aborted ? new UploadCancelled() : error;
	}
}

import { authFetch, getAuthHeaders } from "@/lib/auth/client";
import type { DriveItemDto } from "@/lib/drive/types";
import { driveError } from "./drive-api";
import { uploadFingerprint } from "./drive-utils";

const PART_RETRIES = 3;

type UploadSession = {
	id?: string;
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

// XMLHttpRequest rather than fetch, because only it reports upload progress.
function putPart(url: string, chunk: Blob, onBytes: (loaded: number) => void, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("PUT", url);
		getAuthHeaders({ "Content-Type": "application/octet-stream" }).forEach((value, name) =>
			request.setRequestHeader(name, value),
		);
		request.upload.onprogress = (event) => {
			if (event.lengthComputable) onBytes(event.loaded);
		};
		request.onload = () => {
			if (request.status >= 200 && request.status < 300) return resolve();
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
		signal.addEventListener("abort", () => request.abort(), { once: true });
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

async function sendPart(url: string, chunk: Blob, onBytes: (loaded: number) => void, signal: AbortSignal) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await putPart(url, chunk, onBytes, signal);
		} catch (error) {
			if (error instanceof UploadCancelled || attempt >= PART_RETRIES) throw error;
		}
	}
}

/**
 * Uploads a file in parts, each a raw request body, then completes it. The server keeps the parts it
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
	const stored = new Set(session.uploaded ?? []);
	const resumed = !!session.resumed;
	const partBytes = (index: number) => Math.max(0, Math.min(partSize, file.size - index * partSize));
	let sent = [...stored].reduce((total, part) => total + partBytes(part - 1), 0);
	// Held at 99% until the server has assembled the parts.
	const report = (bytes: number) => onProgress(Math.min(99, Math.floor((bytes / file.size) * 100)), resumed);
	report(sent);
	try {
		for (let index = 0; index < parts; index += 1) {
			if (stored.has(index + 1)) continue;
			const chunk = file.slice(index * partSize, (index + 1) * partSize);
			const url = `/api/drive/uploads/${encodeURIComponent(id)}/parts/${index + 1}`;
			await sendPart(url, chunk, (loaded) => report(sent + loaded), signal);
			sent += chunk.size;
			report(sent);
		}
		const finish = await authFetch(`/api/drive/uploads/${encodeURIComponent(id)}/complete`, { method: "POST", signal });
		if (!finish.ok) throw new Error(await driveError(finish, "Could not finish the upload"));
	} catch (error) {
		if (signal.aborted)
			await authFetch(`/api/drive/uploads/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
		throw signal.aborted ? new UploadCancelled() : error;
	}
}

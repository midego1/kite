import { driveContentHeaders } from "./range-utils";
import { timedBody } from "./webdav-client";

/**
 * The response for a file read from a linked folder: Kite's own content headers, the server's ETag, length, range and
 * date, and the body under the download deadlines (`timedBody`).
 */
export function proxiedFile(upstream: Response, name: string, download: boolean, method: string): Response {
	// Kite asks for identity; a server that compresses anyway has its body decoded by the runtime, and then its
	// stated length no longer matches the bytes passed on.
	const encoding = upstream.headers.get("content-encoding")?.trim().toLowerCase();
	const decoded = !!encoding && encoding !== "identity";
	if (decoded && upstream.status === 206) {
		// A decoded part of a compressed file has no byte range to name, and a 206 without Content-Range breaks the
		// protocol (RFC 9110 §15.3.7), so it is refused rather than passed on as if it were the requested bytes.
		void upstream.body?.cancel().catch(() => undefined);
		return Response.json(
			{ error: "The server sent a compressed part of the file, which cannot be passed on" },
			{ status: 502, headers: { "Cache-Control": "no-store" } },
		);
	}
	const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
	const headers = driveContentHeaders({ id: "webdav", name, contentType, size: 0, updatedAt: new Date(0) }, !download);
	const etag = upstream.headers.get("etag");
	if (etag) headers.set("ETag", etag);
	else headers.delete("ETag");
	for (const header of decoded ? ["last-modified"] : ["content-length", "content-range", "last-modified"]) {
		const value = upstream.headers.get(header);
		if (value) headers.set(header, value);
	}
	if (upstream.headers.get("accept-ranges") !== "bytes" && upstream.status !== 206) headers.delete("Accept-Ranges");
	const body = method === "HEAD" || !upstream.body ? null : timedBody(upstream.body);
	if (!body) void upstream.body?.cancel().catch(() => undefined);
	return new Response(body, { status: upstream.status, headers });
}

import { getContentDisposition } from "@/lib/http/content-disposition-utils";
import { getDownloadContentType, getInlineContentType } from "@/lib/http/content-type-utils";

export type ByteRange = { start: number; end: number };

/**
 * Parses a single `bytes=` range. Returns null when absent or unusable (a multi-range request is served
 * whole), "invalid" when it cannot be satisfied.
 *
 * @public Exercised by the bundled unit tests.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | "invalid" | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
	// An empty file has no satisfiable range, so it is served whole rather than answered with 416.
	if (!match || (match[1] === "" && match[2] === "") || size === 0) return null;
	let start: number;
	let end: number;
	if (match[1] === "") {
		const suffix = Number(match[2]);
		if (suffix === 0) return "invalid";
		start = Math.max(size - suffix, 0);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	}
	return start >= size || start > end ? "invalid" : { start, end };
}

/** Changes whenever the item's bytes may have: If-Range compares against it. */
export function driveEtag(item: { id: string; size: number; updatedAt: Date }): string {
	return `"${item.id}-${item.updatedAt.getTime().toString(36)}-${item.size.toString(36)}"`;
}

/**
 * The headers every Drive file response carries. Inline only for types the shared mail attachment rule
 * accepts, and then the parsed type, never the stored value; everything else downloads as an attachment.
 */
export function driveContentHeaders(
	item: { name: string; contentType: string; id: string; size: number; updatedAt: Date },
	wantInline: boolean,
): Headers {
	const safeType = getInlineContentType(item.contentType);
	const inlineType = wantInline ? safeType : null;
	const headers = new Headers();
	// HTML, SVG, XML and anything unparsable download as opaque bytes, even with nosniff and the sandbox.
	headers.set(
		"Content-Type",
		inlineType ?? (safeType ? getDownloadContentType(item.contentType) : "application/octet-stream"),
	);
	headers.set("Content-Disposition", getContentDisposition(item.name, !!inlineType));
	headers.set("Accept-Ranges", "bytes");
	headers.set("ETag", driveEtag(item));
	headers.set("X-Content-Type-Options", "nosniff");
	// Chrome's PDF viewer does not load under a sandbox or a restrictive default-src, and a PDF served
	// with nosniff cannot run script, so it only gets the framing rule.
	headers.set(
		"Content-Security-Policy",
		inlineType === "application/pdf"
			? "frame-ancestors 'self'"
			: "default-src 'none'; style-src 'unsafe-inline'; sandbox",
	);
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("Cache-Control", "private, no-store");
	return headers;
}

/** The range to serve: none when If-Range names another version, so a resumed download starts over. */
export function requestedRange(request: Request, etag: string, size: number): ByteRange | "invalid" | null {
	const ifRange = request.headers.get("If-Range");
	if (ifRange && ifRange !== etag) return null;
	return parseByteRange(request.headers.get("Range"), size);
}

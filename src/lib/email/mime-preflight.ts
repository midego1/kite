/**
 * Bounds for parsing a raw message. `mimePreflightReason` checks the structural ones with one linear pass over the
 * bytes before postal-mime decodes anything; postal-mime enforces the nesting depth and header size itself.
 * Adapted from Mailflare (hieunc229/mailflare#214, 8377967 and ac1deac).
 */
export const MIME_LIMITS = {
	/** The top-level header block; postal-mime's `maxHeadersSize` caps every part's too. */
	maxHeaderBytes: 64 * 1024,
	/** Lines starting with `--`: every MIME part costs a parser node. */
	maxBoundaryLines: 1_000,
	/** `Content-Type: message/rfc822` lines, at any depth. */
	maxNestedMessages: 20,
	maxNestingDepth: 20,
	/**
	 * Lines outside base64 bodies (headers, text and quoted-printable parts): postal-mime keeps memory per line there,
	 * so 262,144 lines of any length exhaust a 128 MB heap. Base64 lines are decoded in chunks and stay cheap, so a
	 * 25 MB attachment (about 340,000 lines) still parses.
	 */
	maxTextLines: 40_000,
} as const;

const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const DASH = 45;
/** How far into a header line a value is looked for: real Content-Type and Content-Transfer-Encoding lines are short. */
const VALUE_SCAN_BYTES = 256;

function startsWithAscii(bytes: Uint8Array, start: number, end: number, prefix: string): boolean {
	if (end - start < prefix.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if ((bytes[start + index] | 0x20) !== prefix.charCodeAt(index)) return false;
	}
	return true;
}

function lineContainsAscii(bytes: Uint8Array, start: number, end: number, needle: string): boolean {
	const limit = Math.min(end, start + VALUE_SCAN_BYTES) - needle.length;
	for (let index = start; index <= limit; index++) {
		let matched = true;
		for (let offset = 0; offset < needle.length; offset++) {
			if ((bytes[index + offset] | 0x20) !== needle.charCodeAt(offset)) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
	}
	return false;
}

/** What one header-like line declares: a nested message, or a base64 body for the part it heads. */
function headerLineKind(bytes: Uint8Array, start: number, end: number): "nested" | "base64" | null {
	if (startsWithAscii(bytes, start, end, "content-type:") && lineContainsAscii(bytes, start, end, "message/rfc822"))
		return "nested";
	if (
		startsWithAscii(bytes, start, end, "content-transfer-encoding:") &&
		lineContainsAscii(bytes, start, end, "base64")
	)
		return "base64";
	return null;
}

const isBoundaryLine = (bytes: Uint8Array, start: number, end: number) =>
	end - start > 2 && bytes[start] === DASH && bytes[start + 1] === DASH;

/**
 * Why a raw message is refused before parsing (a reason starting "Message rejected:", fit for a bounce), or null.
 * Rejects header floods, thousands of parts, deeply nested messages and line floods, all of which make postal-mime
 * burn CPU or memory far beyond the message's size.
 */
export function mimePreflightReason(raw: ArrayBuffer | Uint8Array): string | null {
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	let boundaryLines = 0;
	let nestedMessages = 0;
	let textLines = 0;
	let headerEnded = false;
	// The current part's header block and transfer encoding, to tell base64 body lines from everything else.
	let inPartHeaders = true;
	let partIsBase64 = false;

	for (let lineStart = 0; lineStart < bytes.length;) {
		let lineEnd = bytes.indexOf(NEWLINE, lineStart);
		if (lineEnd === -1) lineEnd = bytes.length;
		const contentEnd = lineEnd > lineStart && bytes[lineEnd - 1] === CARRIAGE_RETURN ? lineEnd - 1 : lineEnd;

		if (contentEnd === lineStart) {
			headerEnded = true;
			inPartHeaders = false;
		} else if (!headerEnded && lineEnd > MIME_LIMITS.maxHeaderBytes) {
			return "Message rejected: header block exceeds 64 KiB.";
		} else if (isBoundaryLine(bytes, lineStart, contentEnd)) {
			if (++boundaryLines > MIME_LIMITS.maxBoundaryLines) return "Message rejected: too many MIME parts.";
			inPartHeaders = true;
			partIsBase64 = false;
		} else {
			// Nested messages count anywhere: one starts a header block of its own after a blank line.
			const kind = headerLineKind(bytes, lineStart, contentEnd);
			if (kind === "nested" && ++nestedMessages > MIME_LIMITS.maxNestedMessages)
				return "Message rejected: too many nested messages.";
			if (kind === "base64" && inPartHeaders) partIsBase64 = true;
		}
		// Header lines count too: a stray `--x` line would otherwise keep every line after it uncounted.
		if ((inPartHeaders || !partIsBase64) && ++textLines > MIME_LIMITS.maxTextLines)
			return "Message rejected: malformed MIME structure (too many lines).";
		lineStart = lineEnd + 1;
	}
	return null;
}

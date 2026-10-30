/**
 * Bounds for parsing a raw message. `mimePreflightReason` checks the structural ones with one linear pass over the
 * bytes before postal-mime decodes anything; postal-mime enforces the nesting depth and header size itself. Nested
 * messages need no count of their own: `parseRawMime` keeps them as attachments, so postal-mime reads each as one
 * leaf part and never parses inside it. Adapted from Mailflare (hieunc229/mailflare#214, 8377967 and ac1deac).
 */
export const MIME_LIMITS = {
	/** The top-level header block; postal-mime's `maxHeadersSize` caps every part's too. */
	maxHeaderBytes: 64 * 1024,
	/** Boundary lines of declared multipart boundaries: every MIME part costs a parser node. */
	maxBoundaryLines: 1_000,
	/** Multipart levels. */
	maxNestingDepth: 20,
	/**
	 * Lines outside base64 bodies: postal-mime keeps about 1 KB of heap per line there (40,000 lines take about 40 MB,
	 * 262,144 exhaust a 128 MB heap), whether the part is a text body, a text attachment or a nested message, and a
	 * nested message is read as one such part even where its own parts are base64. Lines of a base64 part are decoded
	 * in chunks and stay cheap, so a 25 MB attachment (about 340,000 lines) still parses. Measurements and the false
	 * positives this leaves (a forwarded message with a large attachment): #245.
	 */
	maxTextLines: 40_000,
} as const;

const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const COLON = 58;
const DASH = 45;
const SPACE = 32;
const TAB = 9;
/** RFC 2046 allows 70 characters; anything much longer is not a boundary line worth decoding. */
const MAX_BOUNDARY_LINE_BYTES = 256;
/** Enough of a folded Content-Type or Content-Transfer-Encoding field to find its boundary or encoding. */
const MAX_FIELD_CHARS = 4096;

const latin1 = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

/**
 * The boundary a Content-Type field declares for postal-mime, or null. Only an unambiguous plain parameter counts
 * (one `boundary=`, no escapes): where this reading could differ from postal-mime's, declaring nothing only makes
 * the scan count more lines as text, never fewer.
 */
function declaredBoundary(field: string): string | null {
	if (!/^\s*multipart\//i.test(field) || (field.match(/boundary/gi)?.length ?? 0) !== 1) return null;
	const match = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]*)"|([^\s;"]+))/i.exec(field);
	const value = match?.[1] ?? match?.[2] ?? "";
	return value && !value.includes("\\") ? value : null;
}

/** One pass over the bytes, following the part structure postal-mime will see. */
class PreflightScan {
	private readonly boundaries = new Set<string>();
	private boundaryLines = 0;
	private textLines = 0;
	private topHeaderEnded = false;
	/** The current part: in its header block, and whether its body is base64. */
	private inHeaders = true;
	private base64 = false;
	/** The Content-Type or Content-Transfer-Encoding field being read, unfolded. */
	private field: { name: string; value: string } | null = null;
	private contentType = "";

	constructor(private readonly bytes: Uint8Array) {}

	run(): string | null {
		const { bytes } = this;
		for (let start = 0; start < bytes.length;) {
			let lineEnd = bytes.indexOf(NEWLINE, start);
			if (lineEnd === -1) lineEnd = bytes.length;
			const end = lineEnd > start && bytes[lineEnd - 1] === CARRIAGE_RETURN ? lineEnd - 1 : lineEnd;
			const reason = this.line(start, end, lineEnd);
			if (reason) return reason;
			start = lineEnd + 1;
		}
		return null;
	}

	private line(start: number, end: number, lineEnd: number): string | null {
		if (!this.topHeaderEnded && lineEnd > MIME_LIMITS.maxHeaderBytes)
			return "Message rejected: header block exceeds 64 KiB.";
		if (this.isBoundary(start, end)) {
			if (++this.boundaryLines > MIME_LIMITS.maxBoundaryLines) return "Message rejected: too many MIME parts.";
			this.startPart();
		} else if (this.inHeaders) {
			this.headerLine(start, end);
		}
		// Header lines count too, and so does every line of a part that is not base64.
		if ((this.inHeaders || !this.base64) && ++this.textLines > MIME_LIMITS.maxTextLines)
			return "Message rejected: malformed MIME structure (too many lines).";
		return null;
	}

	/** Whether the line opens or closes a part of a declared multipart, matched as postal-mime matches it. */
	private isBoundary(start: number, end: number): boolean {
		const { bytes } = this;
		if (!this.boundaries.size || end - start < 3 || end - start > MAX_BOUNDARY_LINE_BYTES) return false;
		if (bytes[start] !== DASH || bytes[start + 1] !== DASH) return false;
		let trimmed = end;
		while (trimmed > start + 2 && (bytes[trimmed - 1] === SPACE || bytes[trimmed - 1] === TAB)) trimmed--;
		const value = latin1(bytes, start + 2, trimmed);
		return this.boundaries.has(value) || (value.endsWith("--") && this.boundaries.has(value.slice(0, -2)));
	}

	private startPart() {
		this.inHeaders = true;
		this.base64 = false;
		this.field = null;
		this.contentType = "";
	}

	private headerLine(start: number, end: number) {
		const { bytes } = this;
		if (end === start) return this.endHeaders();
		if (bytes[start] === SPACE || bytes[start] === TAB) {
			if (this.field && this.field.value.length < MAX_FIELD_CHARS)
				this.field.value += latin1(bytes, start, Math.min(end, start + MAX_FIELD_CHARS));
			return;
		}
		this.flushField();
		const colon = bytes.subarray(start, Math.min(end, start + 64)).indexOf(COLON);
		if (colon <= 0) return;
		const name = latin1(bytes, start, start + colon)
			.trim()
			.toLowerCase();
		if (name !== "content-type" && name !== "content-transfer-encoding") return;
		const valueStart = start + colon + 1;
		this.field = { name, value: latin1(bytes, valueStart, Math.min(end, valueStart + MAX_FIELD_CHARS)) };
	}

	private flushField() {
		if (this.field?.name === "content-type") this.contentType = this.field.value;
		if (this.field?.name === "content-transfer-encoding") this.base64 = /^\s*base64\b/i.test(this.field.value);
		this.field = null;
	}

	/** postal-mime reads a part's headers when its header block ends; a multipart's boundary counts from then on. */
	private endHeaders() {
		this.flushField();
		const boundary = declaredBoundary(this.contentType);
		if (boundary) this.boundaries.add(boundary);
		this.topHeaderEnded = true;
		this.inHeaders = false;
	}
}

/**
 * Why a raw message is refused before parsing (a reason starting "Message rejected:", fit for a bounce), or null.
 * Rejects header floods, thousands of parts and line floods, all of which make postal-mime burn CPU or memory far
 * beyond the message's size.
 */
export function mimePreflightReason(raw: ArrayBuffer | Uint8Array): string | null {
	return new PreflightScan(raw instanceof Uint8Array ? raw : new Uint8Array(raw)).run();
}

/**
 * Bounds for parsing a raw message. `mimePreflightReason` checks the structural ones with one linear pass over the
 * bytes before postal-mime decodes anything; postal-mime enforces the nesting depth and header size itself. Nested
 * messages need no count of their own: `parseRawMime` keeps them as attachments, so postal-mime reads each as one
 * leaf part and never parses inside it. Adapted from Mailflare (hieunc229/mailflare#214, 8377967 and ac1deac).
 */
export const MIME_LIMITS = {
	/** A header block, the top-level one and every part's (postal-mime's `maxHeadersSize`). */
	maxHeaderBytes: 64 * 1024,
	/** Boundary lines of active multipart boundaries: every MIME part costs a parser node. */
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
const DASH = 45;
const SPACE = 32;
const TAB = 9;

// postal-mime decodes header lines as UTF-8 and encodes a boundary back the same way.
const utf8 = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/** postal-mime's `stripComments`: RFC 822 comments out, quoted strings and escapes kept. */
function stripComments(value: string): string {
	let result = "";
	let depth = 0;
	let escaped = false;
	let inQuote = false;
	for (const chr of value) {
		const keep = depth === 0;
		if (escaped || chr === "\\") {
			escaped = !escaped;
			if (keep) result += chr;
		} else if (chr === '"' && keep) {
			inQuote = !inQuote;
			result += chr;
		} else if (!inQuote && chr === "(") {
			depth++;
		} else if (!inQuote && chr === ")" && depth > 0) {
			depth--;
		} else if (keep) {
			result += chr;
		}
	}
	return result;
}

type StructuredHeader = { value: string; params: [string, string][] };

/**
 * postal-mime's `parseStructuredHeader`, keeping every parameter in order (postal-mime keeps the last of each name)
 * so a caller can see duplicates. Also read by the MIME part index (`mime-index-utils.ts`).
 */
export function parseStructuredHeader(input: string): StructuredHeader {
	const header: StructuredHeader = { value: "", params: [] };
	let key: string | null = null;
	let value = "";
	let inKey = false;
	let quoted = false;
	let escaped = false;
	const finish = () => {
		if (key === null) header.value = value.trim();
		else header.params.push([key, value.trim()]);
	};
	for (const chr of stripComments(input)) {
		if (inKey) {
			if (chr !== "=") value += chr;
			else [key, inKey, value] = [value.trim().toLowerCase(), false, ""];
		} else if (escaped || chr === "\\") {
			if (escaped) value += chr;
			escaped = !escaped;
		} else if (chr === '"') {
			quoted = !quoted;
		} else if (chr === ";" && !quoted) {
			finish();
			[inKey, value] = [true, ""];
		} else value += chr;
	}
	if (!inKey) finish();
	else if (value.trim()) header.params.push([value.trim().toLowerCase(), ""]);
	header.value = header.value.toLowerCase();
	return header;
}

type PartHeaders = { multipart: boolean; boundary: Uint8Array | null; base64: boolean; ambiguous: boolean };

/** The boundary of a multipart Content-Type, or `ambiguous` where this reading might not be postal-mime's. */
function multipartBoundary(contentType: string): Pick<PartHeaders, "boundary" | "ambiguous"> {
	if (contentType.includes("\\")) return { boundary: null, ambiguous: true };
	const params = parseStructuredHeader(contentType).params;
	const named = params.filter(([name]) => name === "boundary");
	// Duplicates and RFC 2231 forms (`boundary*`, `boundary*0`) are read differently by different parsers.
	if (named.length > 1 || params.some(([name]) => name !== "boundary" && name.includes("boundary")))
		return { boundary: null, ambiguous: true };
	const value = named[0]?.[1] ?? "";
	return { boundary: value ? encoder.encode(value) : null, ambiguous: false };
}

/**
 * What postal-mime's `processHeaders` makes of a header block: folded lines (any line but the first starting with
 * whitespace) join the one above, the last Content-Type and the first Content-Transfer-Encoding count.
 */
function describePart(lines: string[]): PartHeaders {
	const fields: string[] = [];
	for (const line of lines) {
		if (fields.length && /^\s/.test(line)) fields[fields.length - 1] += `\n${line}`;
		else fields.push(line);
	}
	let contentType: string | null = null;
	let encoding: string | null = null;
	for (const field of fields) {
		const normalized = field.replace(/\s+/g, " ");
		const colon = normalized.indexOf(":");
		const name = (colon < 0 ? normalized : normalized.slice(0, colon)).trim().toLowerCase();
		const value = colon < 0 ? "" : normalized.slice(colon + 1).trim();
		if (name === "content-type") contentType = value;
		if (name === "content-transfer-encoding") encoding ??= value;
	}
	const base64 = /base64/i.test((encoding ?? "8bit").toLowerCase().split(/[^\w-]/)[0] ?? "");
	if (contentType === null || !/^multipart\//i.test(parseStructuredHeader(contentType).value))
		return { multipart: false, base64, boundary: null, ambiguous: false };
	return { multipart: true, base64, ...multipartBoundary(contentType) };
}

/** Whether `bytes[start, end)` begins with `prefix`. Shared with the MIME part index (`mime-index-utils.ts`). */
export function bytesStartWith(bytes: Uint8Array, start: number, end: number, prefix: Uint8Array): boolean {
	if (end - start < prefix.length) return false;
	for (let index = 0; index < prefix.length; index++) if (bytes[start + index] !== prefix[index]) return false;
	return true;
}

/** Whether `bytes[start, end)` holds only spaces and tabs: transport padding after a boundary. */
export function onlyBlankBytes(bytes: Uint8Array, start: number, end: number): boolean {
	for (let index = start; index < end; index++) if (bytes[index] !== SPACE && bytes[index] !== TAB) return false;
	return true;
}

/** One pass over the bytes, following the parts postal-mime will see. */
class PreflightScan {
	/** The boundaries postal-mime matches at this point: one per open multipart, outermost first. */
	private readonly active: Uint8Array[] = [];
	private boundaryLines = 0;
	private textLines = 0;
	private topHeaderEnded = false;
	/** The current part's header block while it is read, then null. */
	private headerLines: string[] | null = [];
	private headerBytes = 0;
	/** The current line is in the body of a leaf whose first Content-Transfer-Encoding is base64. */
	private exempt = false;

	constructor(private readonly bytes: Uint8Array) {}

	run(): string | null {
		const { bytes } = this;
		for (let start = 0; start < bytes.length;) {
			let lineEnd = bytes.indexOf(NEWLINE, start);
			if (lineEnd === -1) lineEnd = bytes.length;
			// postal-mime drops every carriage return before the line feed.
			let end = lineEnd;
			while (end > start && bytes[end - 1] === CARRIAGE_RETURN) end--;
			const reason = this.line(start, end, lineEnd);
			if (reason) return reason;
			start = lineEnd + 1;
		}
		return null;
	}

	private line(start: number, end: number, lineEnd: number): string | null {
		if (!this.topHeaderEnded && lineEnd > MIME_LIMITS.maxHeaderBytes)
			return "Message rejected: header block exceeds 64 KiB.";
		const dashes = end - start >= 2 && this.bytes[start] === DASH && this.bytes[start + 1] === DASH;
		// Base64 has no `-`: a line starting with `--` ends the exemption, boundary or not.
		if (dashes) this.exempt = false;
		// postal-mime only matches a boundary on a line longer than `--`.
		const isBoundary = dashes && end - start > 2 && this.boundary(start, end);
		const reason = isBoundary ? this.countBoundary() : this.content(start, end);
		if (reason) return reason;
		if (!this.exempt && ++this.textLines > MIME_LIMITS.maxTextLines)
			return "Message rejected: malformed MIME structure (too many lines).";
		return null;
	}

	/** Matches the line against the active boundaries, innermost first, and moves to the part it opens or closes. */
	private boundary(start: number, end: number): boolean {
		for (let index = this.active.length - 1; index >= 0; index--) {
			const boundary = this.active[index];
			if (!this.startsWith(start + 2, end, boundary)) continue;
			let rest = start + 2 + boundary.length;
			const terminator = end - rest >= 2 && this.bytes[rest] === DASH && this.bytes[rest + 1] === DASH;
			if (terminator) rest += 2;
			if (!this.onlyBlanks(rest, end)) continue;
			// A closing boundary finishes its multipart and everything in it; an opening one, the parts inside it.
			this.active.length = terminator ? index : index + 1;
			this.headerLines = terminator ? null : [];
			this.headerBytes = 0;
			return true;
		}
		return false;
	}

	private countBoundary(): string | null {
		return ++this.boundaryLines > MIME_LIMITS.maxBoundaryLines ? "Message rejected: too many MIME parts." : null;
	}

	/** A line that is not a boundary: part of a header block, or of a body. */
	private content(start: number, end: number): string | null {
		if (!this.headerLines) return null;
		if (end === start) return this.endHeaders();
		this.headerBytes += end - start;
		if (this.headerBytes > MIME_LIMITS.maxHeaderBytes) return "Message rejected: header block exceeds 64 KiB.";
		this.headerLines.push(utf8.decode(this.bytes.subarray(start, end)));
		return null;
	}

	/** Where postal-mime reads the headers: a multipart's boundary is active from here, a base64 leaf exempt. */
	private endHeaders(): string | null {
		const part = describePart(this.headerLines ?? []);
		this.headerLines = null;
		this.topHeaderEnded = true;
		if (part.ambiguous) return "Message rejected: ambiguous MIME boundary.";
		if (part.boundary) this.active.push(part.boundary);
		this.exempt = !part.multipart && part.base64;
		return null;
	}

	private startsWith(start: number, end: number, prefix: Uint8Array): boolean {
		return bytesStartWith(this.bytes, start, end, prefix);
	}

	private onlyBlanks(start: number, end: number): boolean {
		return onlyBlankBytes(this.bytes, start, end);
	}
}

/**
 * Why a raw message is refused before parsing (a reason starting "Message rejected:", fit for a bounce), or null.
 * Rejects header floods, thousands of parts, line floods and boundaries postal-mime could read differently, all of
 * which make postal-mime burn CPU or memory far beyond the message's size or would let the scan miss lines it reads.
 */
export function mimePreflightReason(raw: ArrayBuffer | Uint8Array): string | null {
	return new PreflightScan(raw instanceof Uint8Array ? raw : new Uint8Array(raw)).run();
}

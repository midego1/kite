/**
 * Bounds for parsing a raw message. `mimePreflightReason` checks the structural ones with one linear pass over the
 * bytes before postal-mime decodes anything, reading the parts as postal-mime 4.2 reads them; postal-mime enforces
 * the same part and nesting caps and the total header size itself. Nested messages need no count of their own:
 * `parseRawMime` keeps them as attachments, so postal-mime reads each as one leaf part and never parses inside it.
 * Adapted from Mailflare (hieunc229/mailflare#214, 8377967 and ac1deac).
 */
export const MIME_LIMITS = {
	/** One header block, the top-level one or a part's. */
	maxHeaderBytes: 64 * 1024,
	/** All header blocks of a message together (postal-mime's `maxHeadersSize`, a line counting for at least 64 bytes). */
	maxTotalHeaderBytes: 2 * 1024 * 1024,
	/** MIME parts, the message itself included (postal-mime's `maxPartCount`): every part costs a parser node. */
	maxParts: 1_000,
	/** Multipart levels. */
	maxNestingDepth: 20,
	/**
	 * Line feeds in the decoded text of parts read as text (body parts and calendar parts, see `readsAsText`). postal-mime
	 * normalizes line endings there, about 64 bytes of heap per CRLF while it runs (2 million exhaust a 128 MB heap), and
	 * the text then goes through the sanitizer and the snippet: 150,000 lines of 78 ordinary characters, as text, HTML or
	 * both, fit a 64 MB heap, which leaves a Worker's 128 MB room for the raw message and its decoded parts. What other
	 * lines cost is bounded where they are read (`stored-html-utils.ts`, `reply-content-utils.ts`, `mime-body-utils.ts`). A base64 or
	 * quoted-printable text part counts after decoding: 18 MB of decoded CRLFs fit in a 25 MB message on far fewer raw
	 * lines. Every other part (attachments and attached messages, however many lines they have) is one range of the
	 * message to postal-mime 4.x and costs nothing per line. Measurements: #245.
	 */
	maxTextLines: 150_000,
} as const;

const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const DASH = 45;
const EQUALS = 61;
const ZERO = 48;
const LOWER_A = 97;
const CASE_BIT = 32;
const SPACE = 32;
const TAB = 9;
/** What postal-mime counts a header line as, at the least. */
const HEADER_LINE_MIN_COST = 64;

/**
 * Header lines as postal-mime decodes them: UTF-8 keeping a byte order mark (a line starting with one is no field),
 * windows-1252 when the line is not well formed UTF-8.
 */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const windows1252 = new TextDecoder("windows-1252");
const encoder = new TextEncoder();

export function decodeHeaderLine(line: Uint8Array): string {
	try {
		return utf8.decode(line);
	} catch {
		return windows1252.decode(line);
	}
}

/** The start of a header field: a name and a colon, or the `From ` of an mbox separator. */
const FIELD_START = /^(?:From |[!-9;-~]*[ \t]*:)/;

/** Whether a header block goes on after this line; any other line ends it, and is read again as the body's first. */
export function continuesHeaders(line: string): boolean {
	return line.startsWith(" ") || line.startsWith("\t") || FIELD_START.test(line);
}

/** postal-mime's `stripComments`: RFC 822 comments out, quoted strings and escapes kept. */
function stripComments(value: string): string {
	let result = "";
	let depth = 0;
	let escaped = false;
	let inQuote = false;
	let inParameterValue = false;
	let commentStart = -1;
	// Tracked, not read off `result`: reading a string that grows by appends flattens it each time.
	let endsWithBlank = false;
	// Inside a parameter value a parenthesis only opens a comment after whitespace: `name=a(1).pdf` keeps it.
	const opensComment = () => !inParameterValue || !result.length || endsWithBlank;
	const keep = (chr: string) => {
		if (depth > 0) return;
		result += chr;
		endsWithBlank = chr === " " || chr === "\t";
	};
	for (let index = 0; index < value.length; index++) {
		const chr = value.charAt(index);
		if (escaped) escaped = false;
		else if (chr === "\\") escaped = true;
		else if (chr === '"' && depth === 0) inQuote = !inQuote;
		else if (!inQuote && chr === "(" && opensComment()) {
			if (depth === 0) commentStart = index;
			depth++;
			continue;
		} else if (!inQuote && chr === ")" && depth > 0) {
			depth--;
			continue;
		} else if (!inQuote && depth === 0 && (chr === "=" || chr === ";")) inParameterValue = chr === "=";
		keep(chr);
	}
	if (depth === 0) return result;
	// An unbalanced `(` is no comment when a parameter follows it, and the header stands as it was written.
	return value.indexOf(";", commentStart) < 0 ? result : value;
}

type StructuredHeader = { value: string; params: [string, string][] };

/**
 * postal-mime's `parseStructuredHeader`, keeping every parameter in order (postal-mime keeps the first of each name)
 * so a caller can see duplicates.
 */
function parseStructuredHeader(input: string): StructuredHeader {
	const header: StructuredHeader = { value: "", params: [] };
	let key: string | null = null;
	let value = "";
	// Whitespace outside a quoted string, held back until a character of the value follows it.
	let pendingSpace = "";
	let inKey = false;
	let quoted = false;
	let quoteClosed = false;
	let escaped = false;
	const take = () => {
		const taken = value;
		[value, pendingSpace, quoteClosed] = ["", "", false];
		return taken;
	};
	const flushSpace = () => {
		if (value) value += pendingSpace;
		pendingSpace = "";
	};
	const addParam = (name: string, paramValue: string) => {
		if (name) header.params.push([name, paramValue]);
	};
	const finishValue = () => {
		const taken = take();
		if (key === null) header.value = taken;
		else addParam(key, taken);
	};
	const inValue = (chr: string) => {
		// Nothing behind a closed quoted string counts, up to the `;` that ends the parameter.
		if (quoteClosed && chr !== ";") {
			escaped = false;
			return;
		}
		if (escaped) {
			flushSpace();
			value += chr;
			escaped = false;
		} else if (quoted && chr === "\\") escaped = true;
		else if (quoted && chr === '"') [quoted, quoteClosed] = [false, true];
		else if (!quoted && chr === '"') {
			quoted = true;
			flushSpace();
		} else if (!quoted && chr === ";") {
			finishValue();
			inKey = true;
		} else if (!quoted && (chr === " " || chr === "\t")) pendingSpace += chr;
		else {
			flushSpace();
			value += chr;
		}
	};
	for (const chr of stripComments(input)) {
		if (!inKey) inValue(chr);
		else if (chr === "=") [key, inKey] = [take().trim().toLowerCase(), false];
		else if (chr === ";") addParam(take().trim().toLowerCase(), "");
		else value += chr;
	}
	if (inKey) addParam(take().trim().toLowerCase(), "");
	else finishValue();
	header.value = header.value.toLowerCase();
	return header;
}

/** What a header block says about its part, read as postal-mime's `processHeaders` reads it. */
export type PartFields = {
	/** The Content-Type field as written. */
	rawType: string;
	/** The Content-Type value and parameters. */
	type: StructuredHeader;
	/** The disposition type, up to the first whitespace, and the parameters. */
	disposition: StructuredHeader;
	/** The Content-Transfer-Encoding token, lowercased; empty for none. */
	transferEncoding: string;
	contentId: string | null;
	multipart: boolean;
};

/** SP and HTAB are the only padding around a field body: a raw UTF-8 header may carry other spaces as content. */
function trimFieldBody(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && (value[start] === " " || value[start] === "\t")) start++;
	while (end > start && (value[end - 1] === " " || value[end - 1] === "\t")) end--;
	return value.slice(start, end);
}

/** The fields of a header block, the first of each name, unfolded (a line starting with SP or HTAB joins the one above). */
function firstFields(lines: string[]): Map<string, string> {
	const fields: string[] = [];
	for (const line of lines) {
		if (fields.length && /^[ \t]/.test(line)) fields[fields.length - 1] += line;
		else fields.push(line);
	}
	const values = new Map<string, string>();
	for (const field of fields) {
		const colon = field.indexOf(":");
		const name = (colon < 0 ? field : field.slice(0, colon)).toLowerCase();
		if (values.has(name)) continue;
		values.set(name, colon < 0 ? "" : trimFieldBody(field.slice(colon + 1).replace(/[\r\n]+/g, " ")));
	}
	return values;
}

/** The boundary postal-mime matches: trailing whitespace trimmed, and nothing when it is empty or not ASCII. */
export function usableBoundary(value: string | null | undefined): string {
	const boundary = (value ?? "").trimEnd();
	return /[^\x00-\x7f]/.test(boundary) ? "" : boundary;
}

/** A header block, for a part whose Content-Type defaults to `defaultType` (`message/rfc822` in a digest). */
export function readPartFields(lines: string[], defaultType = "text/plain"): PartFields {
	const fields = firstFields(lines);
	const rawType = fields.get("content-type") ?? defaultType;
	const type = parseStructuredHeader(rawType);
	const disposition = parseStructuredHeader(fields.get("content-disposition") ?? "");
	const multipart = /^multipart\/./i.test(type.value);
	return {
		rawType,
		type,
		disposition: { ...disposition, value: disposition.value.split(/[ \t]/)[0] ?? "" },
		transferEncoding:
			stripComments(fields.get("content-transfer-encoding") ?? "8bit")
				.toLowerCase()
				.match(/^[ \t]*([\w-]+)/)?.[1] ?? "",
		contentId: fields.get("content-id") || null,
		multipart,
	};
}

type TextBody = "base64" | "quoted-printable" | "plain";

/** Where postal-mime decodes a part as text: an inline text body, or a calendar part however it is disposed. */
function readsAsText(type: string, disposition: string): boolean {
	if (type === "text/calendar" || type === "application/ics") return true;
	return disposition !== "attachment" && (type === "text/plain" || type === "text/html");
}

/** What the scan needs of a part: a multipart's boundary, or how a text body has to be counted. */
function describePart(
	lines: string[],
	defaultType: string,
): { boundary: Uint8Array | null; digest: boolean; text: TextBody | null; ambiguous: boolean } {
	const part = readPartFields(lines, defaultType);
	const none = { boundary: null, digest: false, text: null, ambiguous: false };
	if (part.multipart) {
		// Duplicates, RFC 2231 forms (`boundary*`, `boundary*0`) and escapes are read differently by different parsers.
		const { params } = part.type;
		const named = params.filter(([name]) => name === "boundary");
		if (
			part.rawType.includes("\\") ||
			named.length > 1 ||
			params.some(([name]) => name !== "boundary" && name.includes("boundary"))
		)
			return { ...none, ambiguous: true };
		const boundary = usableBoundary(named[0]?.[1]);
		if (boundary)
			return { ...none, boundary: encoder.encode(boundary), digest: part.type.value === "multipart/digest" };
	}
	if (!readsAsText(part.multipart ? "text/plain" : part.type.value, part.disposition.value)) return none;
	const encoding = part.transferEncoding;
	return { ...none, text: encoding === "base64" || encoding === "quoted-printable" ? encoding : "plain" };
}

/** Base64's alphabet as values, -1 elsewhere. Shared with the MIME part index (`mime-index-utils.ts`). */
export const BASE64_VALUES = (() => {
	const table = new Int8Array(256).fill(-1);
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	for (let index = 0; index < alphabet.length; index++) table[alphabet.charCodeAt(index)] = index;
	return table;
})();

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
	/** The multiparts postal-mime matches boundaries of at this point, outermost first. */
	private readonly active: { boundary: Uint8Array; digest: boolean }[] = [];
	parts = 1;
	textLines = 0;
	/** Header bytes of the whole message, counted as postal-mime counts them. */
	private totalHeaderBytes = 0;
	/** The current part's header block while it is read, then null. */
	private headerLines: string[] | null = [];
	private headerBytes = 0;
	/** How the current line counts, in the body of a part read as text; null in any other body. */
	private text: TextBody | null = null;
	/** The base64 characters of the current group, as postal-mime groups them. */
	private base64Bits = 0;
	private base64Count = 0;
	private reason: string | null = null;

	constructor(private readonly bytes: Uint8Array) {}

	run(): string | null {
		const { bytes } = this;
		for (let start = 0; start < bytes.length;) {
			let lineEnd = bytes.indexOf(NEWLINE, start);
			if (lineEnd === -1) lineEnd = bytes.length;
			// postal-mime drops every carriage return before the line feed.
			let end = lineEnd;
			while (end > start && bytes[end - 1] === CARRIAGE_RETURN) end--;
			this.line(start, end);
			if (this.reason) return this.reason;
			start = lineEnd + 1;
		}
		return null;
	}

	private line(start: number, end: number) {
		if (this.boundary(start, end)) return;
		if (!this.headerLines) this.body(start, end);
		else if (end === start) this.endHeaders();
		else this.headerLine(start, end);
	}

	private headerLine(start: number, end: number) {
		this.headerBytes += end - start;
		this.totalHeaderBytes += Math.max(end - start, HEADER_LINE_MIN_COST);
		if (this.headerBytes > MIME_LIMITS.maxHeaderBytes) {
			this.reason = "Message rejected: header block exceeds 64 KiB.";
			return;
		}
		if (this.totalHeaderBytes > MIME_LIMITS.maxTotalHeaderBytes) {
			this.reason = "Message rejected: header blocks exceed 2 MiB in total.";
			return;
		}
		const line = decodeHeaderLine(this.bytes.subarray(start, end));
		if (continuesHeaders(line)) this.headerLines?.push(line);
		else {
			// The headers ended above this line, so the boundary they declared can already match it.
			this.endHeaders();
			if (!this.reason) this.line(start, end);
		}
	}

	/** Matches the line against the active boundaries, outermost first, and moves to the part it opens or closes. */
	private boundary(start: number, end: number): boolean {
		// postal-mime only matches a boundary on a line longer than `--`.
		if (end - start <= 2 || this.bytes[start] !== DASH || this.bytes[start + 1] !== DASH) return false;
		for (let index = 0; index < this.active.length; index++) {
			const { boundary } = this.active[index];
			if (!bytesStartWith(this.bytes, start + 2, end, boundary)) continue;
			let rest = start + 2 + boundary.length;
			const terminator = end - rest >= 2 && this.bytes[rest] === DASH && this.bytes[rest + 1] === DASH;
			if (terminator) rest += 2;
			if (!onlyBlankBytes(this.bytes, rest, end)) continue;
			// A closing boundary finishes its multipart and everything in it; an opening one, the parts inside it.
			this.active.length = terminator ? index : index + 1;
			this.headerLines = terminator ? null : [];
			this.headerBytes = 0;
			this.text = null;
			if (!terminator) this.openPart();
			return true;
		}
		return false;
	}

	private openPart() {
		if (++this.parts > MIME_LIMITS.maxParts) this.reason = "Message rejected: too many MIME parts.";
		else if (this.active.length > MIME_LIMITS.maxNestingDepth)
			this.reason = `Message rejected: maximum MIME nesting depth of ${MIME_LIMITS.maxNestingDepth} levels exceeded.`;
	}

	/** Where postal-mime reads the headers: a multipart's boundary is active from here, a text body counted. */
	private endHeaders() {
		const parent = this.active[this.active.length - 1];
		const part = describePart(this.headerLines ?? [], parent?.digest ? "message/rfc822" : "text/plain");
		this.headerLines = null;
		this.text = part.text;
		[this.base64Bits, this.base64Count] = [0, 0];
		if (part.ambiguous) this.reason = "Message rejected: ambiguous MIME boundary.";
		if (part.boundary) this.active.push({ boundary: part.boundary, digest: part.digest });
	}

	/** Counts a body line by the line feeds it adds to decoded text. Bodies of any other part cost nothing per line. */
	private body(start: number, end: number) {
		if (this.text === "base64") this.base64Line(start, end);
		else if (this.text === "quoted-printable") this.quotedPrintableLine(start, end);
		else if (this.text) this.textLines++;
		if (this.textLines > MIME_LIMITS.maxTextLines)
			this.reason = "Message rejected: malformed MIME structure (too many lines).";
	}

	/** The line feeds a quoted-printable line decodes to: its `=0A` escapes, and its break unless it ends in a soft one. */
	private quotedPrintableLine(start: number, end: number) {
		const { bytes } = this;
		for (let index = start; index + 2 < end; index++)
			if (bytes[index] === EQUALS && bytes[index + 1] === ZERO && (bytes[index + 2] | CASE_BIT) === LOWER_A)
				this.textLines++;
		let last = end;
		while (last > start && (bytes[last - 1] === SPACE || bytes[last - 1] === TAB)) last--;
		if (last === start || bytes[last - 1] !== EQUALS) this.textLines++;
	}

	/** The line feeds a base64 line decodes to. As in postal-mime, `=` ends a group and the next one starts afresh. */
	private base64Line(start: number, end: number) {
		const { bytes } = this;
		for (let index = start; index < end; index++) {
			if (bytes[index] === EQUALS) {
				this.flushBase64Group();
				continue;
			}
			const value = BASE64_VALUES[bytes[index]];
			if (value < 0) continue;
			this.base64Bits = (this.base64Bits << 6) | value;
			if (++this.base64Count === 4) this.flushBase64Group();
		}
	}

	private flushBase64Group() {
		const bits = this.base64Bits << (6 * (4 - this.base64Count));
		// One character holds no whole byte, two hold one, three hold two.
		for (let byte = 0; byte < this.base64Count - 1; byte++)
			if (((bits >> (16 - 8 * byte)) & 0xff) === NEWLINE) this.textLines++;
		[this.base64Bits, this.base64Count] = [0, 0];
	}
}

/**
 * Why a raw message is refused before parsing (a reason starting "Message rejected:", fit for a bounce), or null.
 * Rejects header floods, thousands of parts, floods of decoded lines and boundaries readers could take differently, all
 * of which make postal-mime burn CPU or memory far beyond the message's size or read parts this scan cannot.
 */
export function mimePreflightReason(raw: ArrayBuffer | Uint8Array): string | null {
	return mimePreflightCounts(raw).reason;
}

/**
 * The scan's reading of a message: why it is refused, its parts and the line feeds of its decoded text.
 * @public `tests/mime-preflight.test.mjs` holds these against what postal-mime really does.
 */
export function mimePreflightCounts(raw: ArrayBuffer | Uint8Array) {
	const scan = new PreflightScan(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
	return { reason: scan.run(), parts: scan.parts, textLines: scan.textLines };
}

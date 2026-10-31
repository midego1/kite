import { bytesStartWith, MIME_LIMITS, onlyBlankBytes, parseStructuredHeader } from "./mime-preflight";
import type { MimeAttachmentMatches, MimePartIndex, MimeTransferEncoding } from "./mime-index-types";

/**
 * A byte-range index of a raw message's leaf parts, so an attachment can be served from the stored `.eml` instead of
 * a second, decoded copy (`docs/specs/attachments-once.md`). The scan follows postal-mime's reading of the structure
 * (line based, CR dropped before LF, boundaries matched innermost first, transport padding allowed after a delimiter)
 * but nothing trusts it: `matchAttachmentsToParts` only pairs an attachment with a part whose decoded bytes equal
 * what postal-mime produced, so a part the scan reads wrongly is simply left unmatched.
 */

/**
 * Multipart levels followed, the same bound postal-mime is given for inbound mail; a deeper multipart is read as one
 * leaf that matches nothing.
 */
const MIME_INDEX_MAX_DEPTH = MIME_LIMITS.maxNestingDepth;
/**
 * Leaf parts recorded; the scan stops after this many.
 * @public Exercised by the unit tests.
 */
export const MIME_INDEX_MAX_PARTS = 256;
/** A part's header block; a longer one stops the scan (postal-mime refuses it too). */
const MAX_HEADER_BYTES = MIME_LIMITS.maxHeaderBytes;

const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const DASH = 45;

const utf8 = new TextDecoder("utf-8");
const encoder = new TextEncoder();

type PartFields = Omit<MimePartIndex, "bodyOffset" | "bodyLength"> & { boundary: Uint8Array | null };

function decodePercent(value: string): Uint8Array {
	const bytes: number[] = [];
	for (let index = 0; index < value.length; index++) {
		const hex = value.charAt(index) === "%" ? value.slice(index + 1, index + 3) : "";
		if (/^[0-9a-f]{2}$/i.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			index += 2;
		} else bytes.push(...encoder.encode(value.charAt(index)));
	}
	return Uint8Array.from(bytes);
}

function decodeWithCharset(bytes: Uint8Array, charset: string): string {
	try {
		return new TextDecoder(charset || "utf-8").decode(bytes);
	} catch {
		return utf8.decode(bytes);
	}
}

/**
 * A parameter's value, also in its RFC 2231 forms: `name*=charset'lang'value` and the continuations `name*0`,
 * `name*1*`, …, joined in index order with the charset of the first segment.
 * @public Exercised by the unit tests.
 */
export function mimeParameter(params: [string, string][], name: string): string | null {
	const plain = params.filter(([key]) => key === name).at(-1);
	if (plain) return plain[1];
	const extended = params.filter(([key]) => key === `${name}*`).at(-1);
	const segments = params
		.map(([key, value]) => ({ match: key.match(/^(.+)\*(\d+)(\*?)$/), value }))
		.filter((entry) => entry.match?.[1] === name)
		.sort((a, b) => Number(a.match?.[2]) - Number(b.match?.[2]));
	const parts = extended ? [{ value: extended[1], encoded: true }] : [];
	for (const segment of extended ? [] : segments)
		parts.push({ value: segment.value, encoded: segment.match?.[3] === "*" });
	if (!parts.length) return null;
	const charset = parts[0].encoded ? (parts[0].value.match(/^([^']*)'[^']*'/)?.[1] ?? "") : "";
	let text = "";
	parts.forEach((part, index) => {
		if (!part.encoded) {
			text += part.value;
			return;
		}
		const value = index === 0 ? part.value.replace(/^[^']*'[^']*'/, "") : part.value;
		text += decodeWithCharset(decodePercent(value), charset);
	});
	return text;
}

function transferEncodingOf(value: string | null): MimeTransferEncoding | null {
	const token =
		(value ?? "")
			.trim()
			.toLowerCase()
			.split(/[^\w-]/)[0] ?? "";
	if (token === "base64") return "base64";
	return token === "" || token === "7bit" || token === "8bit" || token === "binary" ? "identity" : null;
}

/** What a header block says, read the way postal-mime's `processHeaders` does (folded lines join the one above). */
function describeHeaders(lines: string[]): PartFields {
	const fields: string[] = [];
	for (const line of lines) {
		if (fields.length && /^\s/.test(line)) fields[fields.length - 1] += `\n${line}`;
		else fields.push(line);
	}
	const values = new Map<string, string>();
	let encoding: string | null = null;
	for (const field of fields) {
		const normalized = field.replace(/\s+/g, " ");
		const colon = normalized.indexOf(":");
		if (colon < 0) continue;
		const name = normalized.slice(0, colon).trim().toLowerCase();
		const value = normalized.slice(colon + 1).trim();
		if (name === "content-transfer-encoding") encoding ??= value;
		else if (name === "content-id") values.set(name, values.get(name) ?? value);
		else values.set(name, value);
	}
	const type = parseStructuredHeader(values.get("content-type") ?? "");
	const disposition = parseStructuredHeader(values.get("content-disposition") ?? "");
	const contentType = /^[^/\s]+\/[^/\s]+$/.test(type.value) ? type.value : "text/plain";
	const boundary = contentType.startsWith("multipart/") ? mimeParameter(type.params, "boundary") : null;
	return {
		contentType,
		transferEncoding: transferEncodingOf(encoding),
		disposition: disposition.value === "attachment" || disposition.value === "inline" ? disposition.value : null,
		filename: mimeParameter(disposition.params, "filename") ?? mimeParameter(type.params, "name"),
		contentId: values.get("content-id") || null,
		boundary: boundary ? encoder.encode(boundary) : null,
	};
}

/** One pass over the lines of a raw message, recording where each leaf part's body starts and ends. */
class MimeIndexScan {
	private readonly parts: MimePartIndex[] = [];
	/** Boundaries of the open multiparts, outermost first. */
	private readonly boundaries: Uint8Array[] = [];
	/** The current part's header lines while they are read, then null. */
	private headerLines: string[] | null = [];
	private headerBytes = 0;
	/** The leaf whose body is being read. */
	private leaf: { fields: PartFields; bodyOffset: number } | null = null;
	/** End of the previous line's content, before its line break. */
	private previousEnd = 0;

	constructor(private readonly bytes: Uint8Array) {}

	run(): MimePartIndex[] {
		const { bytes } = this;
		for (let start = 0; start < bytes.length;) {
			const newline = bytes.indexOf(NEWLINE, start);
			const lineEnd = newline === -1 ? bytes.length : newline;
			const end = lineEnd > start && bytes[lineEnd - 1] === CARRIAGE_RETURN ? lineEnd - 1 : lineEnd;
			const next = newline === -1 ? bytes.length : newline + 1;
			if (!this.line(start, end, next)) return this.parts;
			start = next;
		}
		// A missing close delimiter: the last part runs to the end of the message.
		this.finishLeaf(this.bytes.length);
		return this.parts;
	}

	/** False stops the scan. */
	private line(start: number, end: number, next: number): boolean {
		const { bytes } = this;
		if (end - start > 2 && bytes[start] === DASH && bytes[start + 1] === DASH) {
			const delimiter = this.delimiter(start, end);
			if (delimiter) {
				// The line break before a delimiter belongs to the delimiter (RFC 2046 §5.1.1).
				if (this.leaf) this.finishLeaf(Math.max(this.leaf.bodyOffset, this.previousEnd));
				this.boundaries.length = delimiter.close ? delimiter.index : delimiter.index + 1;
				this.headerLines = delimiter.close ? null : [];
				this.headerBytes = 0;
				this.previousEnd = end;
				return this.parts.length < MIME_INDEX_MAX_PARTS;
			}
		}
		if (this.headerLines) {
			if (end === start) this.endHeaders(next);
			else {
				this.headerBytes += end - start;
				if (this.headerBytes > MAX_HEADER_BYTES) return false;
				this.headerLines.push(utf8.decode(bytes.subarray(start, end)));
			}
		}
		this.previousEnd = end;
		return true;
	}

	/** The open multipart a line delimits, innermost first, and whether it closes it. */
	private delimiter(start: number, end: number): { index: number; close: boolean } | null {
		for (let index = this.boundaries.length - 1; index >= 0; index--) {
			const boundary = this.boundaries[index];
			if (!bytesStartWith(this.bytes, start + 2, end, boundary)) continue;
			let rest = start + 2 + boundary.length;
			const close = end - rest >= 2 && this.bytes[rest] === DASH && this.bytes[rest + 1] === DASH;
			if (close) rest += 2;
			if (onlyBlankBytes(this.bytes, rest, end)) return { index, close };
		}
		return null;
	}

	private endHeaders(bodyOffset: number) {
		const fields = describeHeaders(this.headerLines ?? []);
		this.headerLines = null;
		if (fields.boundary && this.boundaries.length < MIME_INDEX_MAX_DEPTH) this.boundaries.push(fields.boundary);
		else this.leaf = { fields, bodyOffset };
	}

	private finishLeaf(bodyEnd: number) {
		if (!this.leaf) return;
		const { fields, bodyOffset } = this.leaf;
		this.leaf = null;
		this.parts.push({
			bodyOffset,
			bodyLength: Math.max(0, bodyEnd - bodyOffset),
			transferEncoding: fields.transferEncoding,
			contentType: fields.contentType,
			disposition: fields.disposition,
			filename: fields.filename,
			contentId: fields.contentId,
		});
	}
}

function toBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/**
 * The leaf parts of a raw message, in order, with the byte range of each encoded body.
 * @public Raw-backed ingest (step 4 of docs/specs/attachments-once.md) calls this; exercised by the unit tests.
 */
export function indexMimeParts(raw: ArrayBuffer | Uint8Array): MimePartIndex[] {
	return new MimeIndexScan(toBytes(raw)).run();
}

const BASE64_VALUES = (() => {
	const table = new Int8Array(256).fill(-1);
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	for (let index = 0; index < alphabet.length; index++) table[alphabet.charCodeAt(index)] = index;
	return table;
})();

/**
 * Base64 as mail carries it: every byte outside the alphabet (line breaks, spaces, `=` padding) is skipped, and a
 * trailing group of two or three characters decodes to one or two bytes. Batch and streaming decoding both run
 * through this one state machine, so they cannot disagree.
 */
class Base64Decoder {
	private bits = 0;
	private count = 0;

	/** Room `decodeInto` may need for `length` input bytes, including the carried characters. */
	static capacity(length: number): number {
		return Math.floor((length + 3) / 4) * 3;
	}

	decodeInto(input: Uint8Array, output: Uint8Array, at: number): number {
		let { bits, count } = this;
		let position = at;
		for (let index = 0; index < input.length; index++) {
			const value = BASE64_VALUES[input[index]];
			if (value < 0) continue;
			bits = (bits << 6) | value;
			if (++count === 4) {
				output[position++] = (bits >> 16) & 0xff;
				output[position++] = (bits >> 8) & 0xff;
				output[position++] = bits & 0xff;
				bits = 0;
				count = 0;
			}
		}
		this.bits = bits;
		this.count = count;
		return position;
	}

	/** The one or two bytes a trailing group holds; a single leftover character carries no full byte. */
	finishInto(output: Uint8Array, at: number): number {
		let position = at;
		if (this.count === 2) output[position++] = (this.bits >> 4) & 0xff;
		else if (this.count === 3) {
			output[position++] = (this.bits >> 10) & 0xff;
			output[position++] = (this.bits >> 2) & 0xff;
		}
		this.bits = 0;
		this.count = 0;
		return position;
	}
}

/**
 * The decoded length of a part without decoding it.
 * @public Exercised by the unit tests.
 */
export function decodedPartLength(bytes: Uint8Array, encoding: MimeTransferEncoding): number {
	if (encoding === "identity") return bytes.length;
	let count = 0;
	for (let index = 0; index < bytes.length; index++) if (BASE64_VALUES[bytes[index]] >= 0) count++;
	const tail = count % 4;
	return Math.floor(count / 4) * 3 + (tail === 2 ? 1 : tail === 3 ? 2 : 0);
}

/**
 * A part's encoded body decoded; `identity` returns the bytes unchanged.
 * @public Raw-backed ingest (step 4 of docs/specs/attachments-once.md) calls this; exercised by the unit tests.
 */
export function decodePart(bytes: Uint8Array, encoding: MimeTransferEncoding): Uint8Array {
	if (encoding === "identity") return bytes;
	const decoder = new Base64Decoder();
	const output = new Uint8Array(Base64Decoder.capacity(bytes.length) + 2);
	return output.subarray(0, decoder.finishInto(output, decoder.decodeInto(bytes, output, 0)));
}

/** Base64 decoding of a byte stream, holding one chunk at a time; the same output as `decodePart`. */
export function createBase64DecodeStream(): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new Base64Decoder();
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			const output = new Uint8Array(Base64Decoder.capacity(chunk.length));
			const end = decoder.decodeInto(chunk, output, 0);
			if (end) controller.enqueue(output.subarray(0, end));
		},
		flush(controller) {
			const output = new Uint8Array(2);
			const end = decoder.finishInto(output, 0);
			if (end) controller.enqueue(output.subarray(0, end));
		},
	});
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}

/**
 * Pairs each attachment with an unused part whose decoded bytes are exactly its content, in order, so two identical
 * attachments take two parts. Candidates are filtered by decoded length before anything is decoded. Parts with an
 * encoding this index cannot decode (quoted-printable, uuencode) never match.
 * @public Raw-backed ingest (step 4 of docs/specs/attachments-once.md) calls this; exercised by the unit tests.
 */
export function matchAttachmentsToParts(
	raw: ArrayBuffer | Uint8Array,
	attachments: { content: ArrayBuffer | Uint8Array }[],
	parts: MimePartIndex[],
): MimeAttachmentMatches {
	const bytes = toBytes(raw);
	const body = (part: MimePartIndex) => bytes.subarray(part.bodyOffset, part.bodyOffset + part.bodyLength);
	const lengths = new Map<number, number>();
	const decoded = new Map<number, Uint8Array>();
	const used = new Set<number>();
	const result: MimeAttachmentMatches = { matches: [], unmatched: [] };
	attachments.forEach((attachment, attachmentIndex) => {
		const content = toBytes(attachment.content);
		const partIndex = parts.findIndex((part, index) => {
			const encoding = part.transferEncoding;
			if (!encoding || used.has(index) || part.bodyOffset + part.bodyLength > bytes.length) return false;
			if (!lengths.has(index)) lengths.set(index, decodedPartLength(body(part), encoding));
			if (lengths.get(index) !== content.length) return false;
			if (!decoded.has(index)) decoded.set(index, decodePart(body(part), encoding));
			return equalBytes(decoded.get(index) as Uint8Array, content);
		});
		if (partIndex < 0) result.unmatched.push(attachmentIndex);
		else {
			used.add(partIndex);
			result.matches.push({ attachmentIndex, part: parts[partIndex] });
		}
	});
	return result;
}

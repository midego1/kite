import type { HostAttachmentContent } from "@/lib/modules/host-types";
import { documentAttachment, isPdf, type StepAttachment } from "./document-utils";

/** The most of one attachment the step reads; a larger file comes back truncated and is skipped (§6). */
export const PDF_READ_MAX_BYTES = 2_097_152;

type PdfLimits = {
	maxStreams: number;
	maxStreamBytes: number;
	maxInflatedBytes: number;
	maxTextChars: number;
	maxMs: number;
};

/** The §6 caps: streams walked, inflated bytes per stream and in total, text kept and wall-clock time.
 * @public Exercised by the bundled unit tests.
 */
export const PDF_LIMITS: PdfLimits = {
	maxStreams: 32,
	maxStreamBytes: 1_048_576,
	maxInflatedBytes: 4_194_304,
	maxTextChars: 65_536,
	maxMs: 5_000,
};

export type PdfTextOptions = { limits?: Partial<PdfLimits>; now?: () => number };

/**
 * The attachment worth reading as PDF text: only when the body gave no amount and the subject or an
 * attachment name matched a keyword, and only the message's document PDF within the read cap.
 */
export function pdfToRead(
	analysis: { amount: unknown; signals: ReadonlySet<string> },
	attachments: readonly StepAttachment[],
): StepAttachment | null {
	if (analysis.amount) return null;
	if (!analysis.signals.has("subject_keyword") && !analysis.signals.has("invoice_attachment")) return null;
	const id = documentAttachment(attachments);
	const chosen = attachments.find((item) => item.id === id);
	return chosen && isPdf(chosen) && chosen.size <= PDF_READ_MAX_BYTES ? chosen : null;
}

/** The step input with the PDF text after the body excerpt, so the same detector reads both. */
export function withPdfText<Input extends { message: { textExcerpt: string | null } }>(
	input: Input,
	text: string | null,
): Input {
	if (!text?.trim()) return input;
	const excerpt = input.message.textExcerpt ? `${input.message.textExcerpt}\n${text}` : text;
	return { ...input, message: { ...input.message, textExcerpt: excerpt } };
}

/**
 * Text from the content `moduleHost.mail.readAttachment` returned, or null when the read was truncated,
 * the content is not base64 PDF bytes, or the file is encrypted.
 */
export async function pdfTextFromContent(
	content: HostAttachmentContent | null,
	options: PdfTextOptions = {},
): Promise<string | null> {
	if (!content || content.truncated || content.encoding !== "base64") return null;
	let binary: string;
	try {
		binary = atob(content.content);
	} catch {
		return null;
	}
	return extractPdfText(binary, options);
}

type Budget = { limits: PdfLimits; inflated: number; expired: () => boolean };

/** Best-effort text of a PDF held as a binary (one char per byte) string; null for encrypted or non-PDF files. */
async function extractPdfText(binary: string, options: PdfTextOptions): Promise<string | null> {
	if (!binary.slice(0, 1024).includes("%PDF-") || binary.includes("/Encrypt")) return null;
	const limits = { ...PDF_LIMITS, ...options.limits };
	const now = options.now ?? Date.now;
	const deadline = now() + limits.maxMs;
	const budget: Budget = { limits, inflated: 0, expired: () => now() > deadline };
	let text = "";
	for (const stream of streamsOf(binary, limits.maxStreams)) {
		if (budget.expired() || text.length >= limits.maxTextChars) break;
		const content = await streamContent(stream, budget);
		if (content) text += textOperators(content, limits.maxTextChars - text.length);
	}
	return text.slice(0, limits.maxTextChars);
}

type RawStream = { dict: string; data: string };

const DICT_LOOKBACK = 2048;

/** The `stream … endstream` objects in file order; a stream cut off before `endstream` ends the walk. */
function* streamsOf(binary: string, maxStreams: number): Generator<RawStream> {
	let from = 0;
	for (let count = 0; count < maxStreams;) {
		const at = binary.indexOf("stream", from);
		if (at === -1) return;
		from = at + 6;
		if (binary.slice(Math.max(0, at - 3), at) === "end") continue;
		const start = binary[from] === "\r" && binary[from + 1] === "\n" ? from + 2 : from + 1;
		if (binary[from] !== "\n" && binary[from] !== "\r") continue;
		const end = binary.indexOf("endstream", start);
		if (end === -1) return;
		count += 1;
		const dictFrom = Math.max(binary.lastIndexOf("obj", at), at - DICT_LOOKBACK, 0);
		yield { dict: binary.slice(dictFrom, at), data: binary.slice(start, end).replace(/\r?\n$|\r$/, "") };
		from = end + 9;
	}
}

const FLATE_ONLY = /\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\s*\])(?![\w/])/;
const NOT_CONTENT = /\/Subtype\s*\/(?:Image|Type1C|CIDFontType0C|OpenType)\b|\/Length[123]\b/;

/** A content stream's decoded bytes, within the per-stream and total caps; null for images, fonts and other filters. */
async function streamContent(stream: RawStream, budget: Budget): Promise<string | null> {
	if (NOT_CONTENT.test(stream.dict)) return null;
	const room = Math.min(budget.limits.maxStreamBytes, budget.limits.maxInflatedBytes - budget.inflated);
	if (room <= 0) return null;
	const flate = FLATE_ONLY.test(stream.dict);
	if (!flate && /\/Filter\b/.test(stream.dict)) return null;
	const content = flate ? await inflate(stream.data, room, budget.expired) : stream.data.slice(0, room);
	budget.inflated += content.length;
	return content;
}

function toBytes(binary: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function toBinary(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 8192)
		binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
	return binary;
}

/** Inflates zlib data, stopping at `cap` output bytes or the deadline; corrupt data keeps what came out. */
async function inflate(data: string, cap: number, expired: () => boolean): Promise<string> {
	const stream = new DecompressionStream("deflate");
	const writer = stream.writable.getWriter();
	writer.write(toBytes(data)).catch(() => undefined);
	writer.close().catch(() => undefined);
	const reader = stream.readable.getReader();
	let out = "";
	try {
		while (out.length < cap && !expired()) {
			const { done, value } = await reader.read();
			if (done) break;
			out += toBinary(value.subarray(0, cap - out.length));
		}
	} catch {
		// Corrupt or truncated data: keep what inflated before the error.
	} finally {
		reader.cancel().catch(() => undefined);
	}
	return out;
}

/** Windows-1252 code points that differ from Latin-1 and matter for amounts and ranges. */
const WIN_ANSI: Record<number, string> = { 0x80: "€", 0x96: "–", 0x97: "—" };

function decodeBytes(raw: string): string {
	if (raw.startsWith("\xFE\xFF")) {
		let text = "";
		for (let index = 2; index + 1 < raw.length; index += 2)
			text += String.fromCharCode((raw.charCodeAt(index) << 8) | raw.charCodeAt(index + 1));
		return clean(text);
	}
	let text = "";
	for (const char of raw) {
		const code = char.charCodeAt(0);
		text += code >= 0x80 && code <= 0x9f ? (WIN_ANSI[code] ?? " ") : char;
	}
	return clean(text);
}

function clean(text: string): string {
	return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ");
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

/** A literal string starting at `(`: balanced parentheses and the standard escapes; unterminated runs to the end. */
function literalAt(content: string, open: number): [string, number] {
	let raw = "";
	let depth = 1;
	let index = open + 1;
	while (index < content.length) {
		const char = content[index];
		if (char === "\\") {
			const [decoded, next] = escapeAt(content, index + 1);
			raw += decoded;
			index = next;
			continue;
		}
		if (char === "(") depth += 1;
		if (char === ")" && --depth === 0) return [raw, index + 1];
		raw += char;
		index += 1;
	}
	return [raw, index];
}

function escapeAt(content: string, at: number): [string, number] {
	const char = content[at] ?? "";
	if (char in ESCAPES) return [ESCAPES[char], at + 1];
	if (char === "\r") return ["", content[at + 1] === "\n" ? at + 2 : at + 1];
	if (char === "\n") return ["", at + 1];
	const octal = /^[0-7]{1,3}/.exec(content.slice(at, at + 3))?.[0];
	if (octal) return [String.fromCharCode(parseInt(octal, 8) & 0xff), at + octal.length];
	return [char, at + 1];
}

/** A hex string starting at `<`: whitespace ignored, an odd final digit padded with 0. */
function hexAt(content: string, open: number): [string, number] {
	const close = content.indexOf(">", open + 1);
	const end = close === -1 ? content.length : close;
	const digits = content.slice(open + 1, end).replace(/[^0-9a-fA-F]/g, "");
	let raw = "";
	for (let index = 0; index < digits.length; index += 2)
		raw += String.fromCharCode(parseInt(digits.slice(index, index + 2).padEnd(2, "0"), 16));
	return [raw, end + 1];
}

const DELIMITERS = "()<>[]{}/%";
const WHITESPACE = " \t\r\n\f\0";
const LINE_OPERATORS = new Set(["Td", "TD", "T*", "Tm", "ET", "'", '"']);
/** A TJ adjustment below this (thousandths of an em) reads as a word gap. */
const WORD_GAP = -180;

type TextState = { out: string; pending: string | null; array: string[] | null };

function emit(state: TextState, text: string): void {
	state.out += text;
}

function newline(state: TextState): void {
	if (state.out && !state.out.endsWith("\n")) emit(state, "\n");
}

function operator(state: TextState, token: string): void {
	if (LINE_OPERATORS.has(token)) newline(state);
	if ((token === "Tj" || token === "TJ" || token === "'" || token === '"') && state.pending !== null)
		emit(state, decodeBytes(state.pending));
	state.pending = null;
}

function operand(state: TextState, raw: string): void {
	if (state.array) state.array.push(raw);
	else state.pending = raw;
}

function endOfLine(content: string, index: number): number {
	let at = index;
	while (at < content.length && content[at] !== "\n" && content[at] !== "\r") at += 1;
	return at;
}

function endOfToken(content: string, index: number): number {
	let at = index + 1;
	while (at < content.length && !WHITESPACE.includes(content[at]) && !DELIMITERS.includes(content[at])) at += 1;
	return at;
}

/** A name, number or operator token; names are skipped, numbers matter only as TJ word gaps. */
function token(state: TextState, value: string): void {
	if (value.startsWith("/")) return;
	const number = Number(value);
	if (state.array) {
		if (number < WORD_GAP) state.array.push(" ");
	} else if (Number.isNaN(number)) operator(state, value);
}

/** Consumes one lexical element at `index` and returns the index after it. */
function step(content: string, index: number, state: TextState): number {
	const char = content[index];
	if (char === "<" && content[index + 1] === "<") return index + 2;
	if (char === "(" || char === "<") {
		const [raw, next] = char === "(" ? literalAt(content, index) : hexAt(content, index);
		operand(state, raw);
		return next;
	}
	if (char === "[") state.array = [];
	else if (char === "]") {
		state.pending = state.array ? state.array.join("") : null;
		state.array = null;
	} else if (char === "%") return endOfLine(content, index);
	else if (char === "/" || !(WHITESPACE.includes(char) || DELIMITERS.includes(char))) {
		const end = endOfToken(content, index);
		token(state, content.slice(index, end));
		return end;
	}
	return index + 1;
}

/** Text shown by `Tj`, `TJ`, `'` and `"` in one content stream, in a single linear pass, up to `maxChars`. */
function textOperators(content: string, maxChars: number): string {
	const state: TextState = { out: "", pending: null, array: null };
	let index = 0;
	while (index < content.length && state.out.length < maxChars) index = step(content, index, state);
	return state.out.slice(0, maxChars);
}

import { parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";
import type { OutboundProviderAttachment, OutboundProviderMessage } from "@/lib/email/outbound-provider-types";
import { transportAddress } from "@/lib/smtp/protocol-utils";

/**
 * RFC 5322 bytes for an outbound message (spec §7.5), built from the same `OutboundProviderMessage` the other
 * providers take, without a MIME library so both runtimes produce the same output: `multipart/mixed` (attachments) ›
 * `multipart/alternative` (text, HTML) › `multipart/related` (HTML and its inline images). Everything is 7-bit ASCII
 * with CRLF line endings: non-ASCII header text becomes RFC 2047 encoded words, non-ASCII file names RFC 2231
 * parameters, text bodies `7bit` or quoted-printable, attachments base64 in 76-column lines; header lines are folded at
 * 78 columns where they can be. Bcc is never a header (it is in the SMTP envelope only). Dot-stuffing is the SMTP
 * client's job (`smtpDataPayload`), so the same bytes can be stored and appended to a Sent folder.
 */
export type BuildMimeOptions = {
	/** The Date header; now by default. */
	date?: Date;
	/** The Message-ID, with or without angle brackets; else a `Message-ID` header of the message, else a new one. */
	messageId?: string;
	/** Random bytes for boundaries; injectable for tests. */
	randomBytes?: (length: number) => Uint8Array;
};

export type BuiltMimeMessage = { raw: Uint8Array; messageId: string };

/** Header lines are folded to this width where whitespace allows (RFC 5322 §2.1.1). */
const FOLD_WIDTH = 78;
/** A word longer than this is not left to the 998-octet hard limit: the whole value is encoded instead. */
const MAX_PLAIN_WORD = 200;
/** UTF-8 bytes per `=?UTF-8?B?…?=` word: 45 bytes are 60 base64 characters, 72 with the delimiters (RFC 2047 ≤ 75). */
const ENCODED_WORD_BYTES = 45;
/** The longest quoted parameter value; longer ones use RFC 2231 sections. */
const QUOTED_PARAMETER_MAX = 60;
/** One parameter token, so that it fits a folded line (a space before it) with room to spare. */
const PARAMETER_TOKEN_MAX = 75;

/** Headers the builder writes itself; a caller's value for one of them is ignored (Message-ID is used, not copied). */
const RESERVED_HEADERS = new Set([
	"from",
	"to",
	"cc",
	"bcc",
	"subject",
	"date",
	"message-id",
	"mime-version",
	"content-type",
	"content-transfer-encoding",
	"content-disposition",
	"content-id",
]);
/** Headers whose value is an address list, formatted like From and To rather than as text. */
const ADDRESS_HEADERS = new Set(["reply-to", "sender"]);

export function buildMimeMessage(message: OutboundProviderMessage, options: BuildMimeOptions = {}): BuiltMimeMessage {
	// One author: a From list would need a Sender header (RFC 5322 §3.6.2) and is never what send-as means.
	if (splitEmailAddressList(message.from).length !== 1) throw new Error("A message has exactly one From address");
	const random = options.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
	const custom = customHeaders(message.headers ?? {});
	const messageId = normalizeMessageId(options.messageId ?? custom.messageId ?? mintMessageId(message.from));
	const to = message.to.filter((value) => value.trim());
	const cc = (message.cc ?? []).filter((value) => value.trim());

	const head = [
		foldHeader("From", addressTokens([message.from])),
		...(to.length ? [foldHeader("To", addressTokens(to))] : []),
		...(cc.length ? [foldHeader("Cc", addressTokens(cc))] : []),
		// A message without visible recipients still says so, as RFC 5322 §3.6.3 suggests for Bcc-only mail.
		...(!to.length && !cc.length ? ["To: undisclosed-recipients:;"] : []),
		foldHeader("Subject", textTokens(message.subject ?? "")),
		`Date: ${formatMailDate(options.date ?? new Date())}`,
		`Message-ID: ${messageId}`,
		...custom.lines,
		"MIME-Version: 1.0",
	];
	const body = buildBody(message, random);
	const chunks: (string | Uint8Array)[] = [];
	writePart(chunks, { ...body, headers: [...head, ...body.headers] });
	// A single-part message whose text lacks a final line break still ends with one.
	const last = chunks[chunks.length - 1];
	if (typeof last === "string" && !last.endsWith("\r\n")) chunks.push("\r\n");
	return { raw: concat(chunks), messageId };
}

/** `<kite.<id>@<domain of the From address>>` (spec §7.3), with a random id when none is given. */
export function mintMessageId(from: string, id: string = crypto.randomUUID()): string {
	const address = transportAddress(from);
	const domain = address.slice(address.lastIndexOf("@") + 1);
	return `<kite.${id.replace(/[^A-Za-z0-9._-]/g, "")}@${domain}>`;
}

/** A Message-ID in angle brackets; refused when it is empty or could break the header. @public Exercised by the unit tests. */
export function normalizeMessageId(value: string): string {
	const inner = value.trim().replace(/^<|>$/g, "");
	if (!/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(inner) || /[<>]/.test(inner) || inner.length > 900)
		throw new Error("The Message-ID is not valid");
	return `<${inner}>`;
}

/** RFC 5322 §3.3: `Thu, 29 Oct 2026 10:00:00 +0000`, always in UTC. @public Exercised by the unit tests. */
export function formatMailDate(date: Date): string {
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/**
 * `Name: token token …` folded at 78 columns: a line breaks before a token that would pass the width, and the space
 * that separated them starts the continuation line, so unfolding (removing CRLF) restores the value exactly. The first
 * token may move to a continuation line of its own (`Subject:` CRLF ` =?UTF-8?B?…?=`); one longer than the width stays
 * where it is. Tokens never exceed `MAX_PLAIN_WORD` or an encoded word's 75.
 * @public Exercised by the unit tests.
 */
export function foldHeader(name: string, tokens: readonly string[]): string {
	const lines: string[] = [];
	let line = `${name}:`;
	for (const token of tokens) {
		const fits = line.length + 1 + token.length <= FOLD_WIDTH;
		// Folding right after the colon only helps a token that then fits its own line.
		const first = line.length === name.length + 1;
		if (!fits && (!first || token.length + 1 <= FOLD_WIDTH)) {
			lines.push(line);
			line = ` ${token}`;
		} else line += ` ${token}`;
	}
	lines.push(line);
	return lines.join("\r\n");
}

/**
 * RFC 2047 `B` encoded words of the UTF-8 text, each at most 45 bytes (75 characters with its delimiters) and never
 * splitting a character, so every word decodes on its own.
 * @public Exercised by the unit tests.
 */
export function encodedWords(text: string): string[] {
	const encoder = new TextEncoder();
	const words: string[] = [];
	let current: number[] = [];
	for (const char of text) {
		const bytes = encoder.encode(char);
		if (current.length + bytes.length > ENCODED_WORD_BYTES) {
			words.push(encodedWord(current));
			current = [];
		}
		current.push(...bytes);
	}
	if (current.length || !words.length) words.push(encodedWord(current));
	return words;
}

function encodedWord(bytes: number[]): string {
	return `=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`;
}

/**
 * The tokens of unstructured header text (Subject, other headers): line breaks and runs of whitespace become one
 * space (a header value cannot carry a line break). Printable ASCII stays readable; text with anything else, with a
 * word too long to fold, or with something a reader would decode as an encoded word, is encoded as a whole.
 * @public Exercised by the unit tests.
 */
export function textTokens(value: string): string[] {
	const text = value.replace(/\s+/g, " ").trim();
	if (!text) return [];
	const words = text.split(" ");
	const plain =
		/^[\x20-\x7e]*$/.test(text) && !/=\?/.test(text) && words.every((word) => word.length <= MAX_PLAIN_WORD);
	return plain ? words : encodedWords(text);
}

const ATOM_PHRASE = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/;

/**
 * The tokens of an address list (`Name <a@b>, c@d`): each address in its ASCII form (`transportAddress`, punycode for
 * an internationalized domain), display names as atoms, a quoted string, or encoded words when they are not ASCII.
 * Commas end every mailbox but the last.
 * @public Exercised by the unit tests.
 */
export function addressTokens(values: readonly string[]): string[] {
	// An element may itself be a comma-joined header value (`A <a@x>, B <b@y>`); every address in it is kept.
	const mailboxes = values
		.flatMap((value) => splitEmailAddressList(value))
		.map((value) => {
			const parts = parseEmailAddressParts(value);
			const address = transportAddress(parts.address);
			const name = (parts.name ?? "").replace(/\s+/g, " ").trim();
			if (!name) return [address];
			return [...phraseTokens(name), `<${address}>`];
		});
	return mailboxes.flatMap((tokens, index) =>
		index < mailboxes.length - 1 ? [...tokens.slice(0, -1), `${tokens[tokens.length - 1]},`] : tokens,
	);
}

function phraseTokens(name: string): string[] {
	if (/^[\x20-\x7e]*$/.test(name) && !/=\?/.test(name) && name.length <= MAX_PLAIN_WORD) {
		if (ATOM_PHRASE.test(name)) return name.split(" ");
		return [`"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`];
	}
	return encodedWords(name);
}

/** The caller's extra headers, validated and folded; reserved ones are left out and Message-ID is handed back. */
function customHeaders(headers: Record<string, string>): { lines: string[]; messageId: string | null } {
	const byName = new Map<string, [string, string]>();
	for (const [name, value] of Object.entries(headers)) {
		if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) throw new Error(`"${name.slice(0, 40)}" is not a valid header name`);
		byName.set(name.toLowerCase(), [name, String(value)]);
	}
	const lines: string[] = [];
	for (const [lower, [name, value]] of byName) {
		if (RESERVED_HEADERS.has(lower)) continue;
		const tokens = ADDRESS_HEADERS.has(lower) ? addressTokens(splitEmailAddressList(value)) : textTokens(value);
		if (tokens.length) lines.push(foldHeader(name, tokens));
	}
	return { lines, messageId: byName.get("message-id")?.[1] ?? null };
}

type MimePart = { headers: string[]; body: Uint8Array | string } | { headers: string[]; parts: MimePart[] };

type MultipartPart = { headers: string[]; parts: MimePart[] };

function buildBody(message: OutboundProviderMessage, random: (length: number) => Uint8Array): MimePart {
	const attachments = message.attachments ?? [];
	const inline = message.html ? attachments.filter((attachment) => contentId(attachment)) : [];
	const regular = attachments.filter((attachment) => !inline.includes(attachment));
	const multipart = (subtype: string, parts: MimePart[]): MultipartPart => ({
		headers: [foldHeader("Content-Type", [`multipart/${subtype};`, `boundary="${boundary(random)}"`])],
		parts,
	});

	const html = message.html ? textPart("html", message.html) : null;
	const htmlWithImages =
		html && inline.length
			? multipart("related", [html, ...inline.map((attachment) => attachmentPart(attachment, true))])
			: html;
	const text = message.text || !htmlWithImages ? textPart("plain", message.text ?? "") : null;
	const content =
		text && htmlWithImages ? multipart("alternative", [text, htmlWithImages]) : (htmlWithImages ?? (text as MimePart));
	return regular.length
		? multipart("mixed", [content, ...regular.map((attachment) => attachmentPart(attachment, false))])
		: content;
}

/** `=_kite_` and 24 random hex digits. `=_` cannot occur in base64 or quoted-printable output, nor in a 7bit part. */
function boundary(random: (length: number) => Uint8Array): string {
	return `=_kite_${Array.from(random(12), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A text body, CRLF throughout: `7bit` when it is short-lined printable ASCII without `=_`, else quoted-printable. */
function textPart(subtype: "plain" | "html", value: string): MimePart {
	const text = value.replace(/\r\n|\r|\n/g, "\r\n");
	const sevenBit =
		/^[\x20-\x7e\t\r\n]*$/.test(text) && !text.includes("=_") && text.split("\r\n").every((line) => line.length <= 998);
	return {
		headers: [
			`Content-Type: text/${subtype}; charset=utf-8`,
			`Content-Transfer-Encoding: ${sevenBit ? "7bit" : "quoted-printable"}`,
		],
		body: sevenBit ? text : encodeQuotedPrintable(text),
	};
}

/** An attachment; `inline` only inside `multipart/related`, where the HTML refers to it by Content-ID. */
function attachmentPart(attachment: OutboundProviderAttachment, inline: boolean): MimePart {
	const filename = attachment.filename.replace(/[\0-\x1f\x7f]/g, "").trim() || "attachment";
	const cid = contentId(attachment);
	const disposition = inline && cid ? "inline" : "attachment";
	return {
		headers: [
			foldHeader("Content-Type", [`${mediaType(attachment.type)};`, ...parameterTokens("name", filename)]),
			"Content-Transfer-Encoding: base64",
			foldHeader("Content-Disposition", [`${disposition};`, ...parameterTokens("filename", filename)]),
			...(disposition === "inline" ? [`Content-ID: <${cid}>`] : []),
		],
		body: encodeBase64Lines(new Uint8Array(attachment.content)),
	};
}

/** The attachment's media type without parameters, or `application/octet-stream` when it is not one. @public Exercised by the unit tests. */
export function mediaType(value: string): string {
	const type = value.split(";")[0].trim().toLowerCase();
	return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : "application/octet-stream";
}

/** The attachment's Content-ID without angle brackets, or null when it has none that can go into a header. */
function contentId(attachment: OutboundProviderAttachment): string | null {
	const value = attachment.contentId?.trim().replace(/^<|>$/g, "") ?? "";
	return /^[\x21-\x3b\x3d\x3f-\x7e]{1,200}$/.test(value) ? value : null;
}

/**
 * A MIME parameter as header tokens: `name="value"` for short printable ASCII, else RFC 2231 `name*=utf-8''…` in
 * percent-encoded UTF-8, split into `name*0*`, `name*1*`, … sections that each fit a folded line (never inside a
 * `%XX`). Every token but the last ends with `;`.
 * @public Exercised by the unit tests.
 */
export function parameterTokens(name: string, value: string): string[] {
	if (/^[\x20-\x7e]*$/.test(value) && value.length <= QUOTED_PARAMETER_MAX && !/=\?/.test(value))
		return [`${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`];
	const encoded = Array.from(new TextEncoder().encode(value), (byte) => {
		const char = String.fromCharCode(byte);
		return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}).join("");
	const single = `${name}*=utf-8''${encoded}`;
	if (single.length <= PARAMETER_TOKEN_MAX) return [single];
	const sections: string[] = [];
	let rest = encoded;
	while (rest) {
		const prefix = `${name}*${sections.length}*=${sections.length ? "" : "utf-8''"}`;
		// Room for the prefix and the `;` that ends every section but the last; an escape is never cut in two.
		let take = Math.max(PARAMETER_TOKEN_MAX - prefix.length - 1, 3);
		if (rest[take - 1] === "%") take -= 1;
		else if (rest[take - 2] === "%") take -= 2;
		sections.push(`${prefix}${rest.slice(0, take)}`);
		rest = rest.slice(take);
	}
	return sections.map((section, index) => (index < sections.length - 1 ? `${section};` : section));
}

/**
 * Quoted-printable (RFC 2045 §6.7) of CRLF-separated text, as UTF-8: lines at most 76 characters with `=` soft breaks
 * that never split an `=XX`, `=` and every byte outside printable ASCII escaped, and a space or tab at the end of a
 * line escaped so no transport can strip it.
 * @public Exercised by the unit tests.
 */
export function encodeQuotedPrintable(text: string): string {
	const encoder = new TextEncoder();
	return text
		.split("\r\n")
		.map((line) => {
			const bytes = encoder.encode(line);
			const out: string[] = [];
			let width = 0;
			bytes.forEach((byte, index) => {
				const last = index === bytes.length - 1;
				const literal = (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
				const token = literal ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
				// The soft break's `=` counts toward the 76; the last token of the line needs no room for one.
				if (width + token.length > (last ? 76 : 75)) {
					out.push("=\r\n");
					width = 0;
				}
				out.push(token);
				width += token.length;
			});
			return out.join("");
		})
		.join("\r\n");
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 in 76-character lines, each ending in CRLF, written straight into one buffer: a 25 MB attachment costs its
 * encoded size once, not a string, a wrapped copy and the bytes.
 * @public Exercised by the unit tests.
 */
export function encodeBase64Lines(input: Uint8Array): Uint8Array {
	const LINE_INPUT = 57;
	const lines = Math.ceil(input.length / LINE_INPUT);
	const out = new Uint8Array(Math.ceil(input.length / 3) * 4 + lines * 2);
	let offset = 0;
	for (let start = 0; start < input.length; start += LINE_INPUT) {
		const end = Math.min(start + LINE_INPUT, input.length);
		for (let index = start; index < end; index += 3) {
			const a = input[index];
			const b = index + 1 < end ? input[index + 1] : 0;
			const c = index + 2 < end ? input[index + 2] : 0;
			out[offset++] = BASE64.charCodeAt(a >> 2);
			out[offset++] = BASE64.charCodeAt(((a & 3) << 4) | (b >> 4));
			out[offset++] = index + 1 < end ? BASE64.charCodeAt(((b & 15) << 2) | (c >> 6)) : 61;
			out[offset++] = index + 2 < end ? BASE64.charCodeAt(c & 63) : 61;
		}
		out[offset++] = 13;
		out[offset++] = 10;
	}
	return out;
}

/** Headers, a blank line, then the body or each subpart between boundary lines (RFC 2046 §5.1.1). */
function writePart(chunks: (string | Uint8Array)[], part: MimePart): void {
	chunks.push(`${part.headers.join("\r\n")}\r\n\r\n`);
	if ("body" in part) {
		chunks.push(part.body);
		return;
	}
	const marker = /boundary="([^"]+)"/.exec(part.headers[part.headers.length - 1])?.[1];
	for (const sub of part.parts) {
		chunks.push(`--${marker}\r\n`);
		writePart(chunks, sub);
		// A text body may not end in CRLF; the boundary needs one before it, which belongs to the boundary (RFC 2046).
		chunks.push("\r\n");
	}
	chunks.push(`--${marker}--\r\n`);
}

function concat(chunks: (string | Uint8Array)[]): Uint8Array {
	const encoder = new TextEncoder();
	const parts = chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk));
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

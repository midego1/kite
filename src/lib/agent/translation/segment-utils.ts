import { Parser } from "htmlparser2";
import { EMAIL_PATTERN, URL_PATTERN } from "../auto-read/draft-guard-utils";
import { splitRepliedEmailContent } from "@/lib/email/reply-content-utils";
import { sha256Prefix } from "../summaries/summary-utils";
import type { TranslationPlan, TranslationSlot, TranslationSource } from "./translation-types";

/**
 * A message split into the pieces of text a model may translate, and put back together: markup is never sent and
 * never rebuilt. Each piece keeps its exact place in the stored body, and a translation replaces that range as
 * escaped text, so tags, attributes and links stay byte for byte what the sender wrote, and no answer of a model
 * can become markup. The result then goes through the reader's sanitizer and sandboxed frame like the original.
 */

/** The most one piece holds, so one long run of text cannot fill a request. */
const SEGMENT_MAX_CHARS = 3_000;
/** Elements whose text is not prose, or not shown. */
const SKIPPED_TAGS = new Set([
	"head",
	"title",
	"style",
	"script",
	"noscript",
	"textarea",
	"code",
	"kbd",
	"samp",
	"var",
	"svg",
	"math",
]);
const HIDDEN_STYLE = /(?:^|;)\s*display\s*:\s*none/i;
const QUOTE_CLASSES = ["gmail_quote", "gmail_attr", "yahoo_quoted", "moz-cite-prefix"];
const QUOTE_IDS = ["divRplyFwdMsg"];
const WHOLE_LINE_LIST_ITEM = /^(\s*(?:[-•*]|\d{1,3}[.)])\s+)(.*)$/;
const BREAK = /[\s。！？；，、]/;
const LETTER = /\p{L}/u;
const ROOT_DIRECTION = /^\s*<div dir="(?:ltr|rtl)">/;

type Frame = { skip: boolean; quoted: boolean; preformatted: boolean };

function classesOf(attributes: Record<string, string>): string[] {
	return (attributes.class ?? "").split(/\s+/);
}

function isQuote(name: string, attributes: Record<string, string>): boolean {
	return (
		name === "blockquote" ||
		"data-kite-quote" in attributes ||
		QUOTE_IDS.includes(attributes.id ?? "") ||
		classesOf(attributes).some((name) => QUOTE_CLASSES.includes(name))
	);
}

function frameOf(name: string, attributes: Record<string, string>, parent: Frame): Frame {
	const notTranslated = attributes.translate === "no" || classesOf(attributes).includes("notranslate");
	return {
		skip: parent.skip || SKIPPED_TAGS.has(name) || notTranslated || HIDDEN_STYLE.test(attributes.style ?? ""),
		quoted: parent.quoted || isQuote(name, attributes),
		preformatted: parent.preformatted || name === "pre",
	};
}

/** Whether text says something a person would translate: letters that are not just a link or an address. */
function isTranslatable(text: string): boolean {
	return LETTER.test(text.replace(URL_PATTERN, " ").replace(EMAIL_PATTERN, " "));
}

/** Where to end a piece of a run longer than the limit: at white space or a clause, never inside an entity or a pair. */
function breakAt(raw: string, from: number): number {
	const limit = from + SEGMENT_MAX_CHARS;
	for (let index = limit; index > from + SEGMENT_MAX_CHARS / 2; index -= 1)
		if (BREAK.test(raw[index])) return index + 1;
	const entity = raw.lastIndexOf("&", limit);
	if (entity > limit - 12 && !raw.slice(entity, limit).includes(";")) return entity;
	const low = raw.charCodeAt(limit);
	return low >= 0xdc00 && low <= 0xdfff ? limit + 1 : limit;
}

/** `[start, end]` pairs of `raw`, each short enough for one piece. */
function ranges(raw: string): [number, number][] {
	const found: [number, number][] = [];
	let from = 0;
	while (raw.length - from > SEGMENT_MAX_CHARS) {
		const to = breakAt(raw, from);
		found.push([from, to]);
		from = to;
	}
	found.push([from, raw.length]);
	return found;
}

function decodeEntities(raw: string): string {
	if (!raw.includes("&")) return raw;
	let decoded = "";
	new Parser(
		{
			ontext: (text) => {
				decoded += text;
			},
		},
		{ decodeEntities: true },
	).end(raw);
	return decoded;
}

/** The slots of one run of text at `offset` in the source. */
function slotsOfRun(raw: string, offset: number, frame: Frame, decode: (raw: string) => string): TranslationSlot[] {
	const slots: TranslationSlot[] = [];
	for (const [from, to] of ranges(raw)) {
		const decoded = decode(raw.slice(from, to));
		const text = decoded.trim();
		if (!isTranslatable(text)) continue;
		const before = decoded.length - decoded.trimStart().length;
		slots.push({
			start: offset + from,
			end: offset + to,
			text: frame.preformatted ? text : text.replace(/\s+/g, " "),
			pre: decoded.slice(0, before),
			post: decoded.slice(before + text.length),
			quoted: frame.quoted,
		});
	}
	return slots;
}

function htmlSlots(html: string): TranslationSlot[] {
	const slots: TranslationSlot[] = [];
	const stack: Frame[] = [{ skip: false, quoted: false, preformatted: false }];
	let run: { start: number; end: number } | null = null;
	const flush = () => {
		if (!run) return;
		const frame = stack[stack.length - 1];
		if (!frame.skip) slots.push(...slotsOfRun(html.slice(run.start, run.end), run.start, frame, decodeEntities));
		run = null;
	};
	const parser = new Parser(
		{
			onopentag(name, attributes) {
				flush();
				stack.push(frameOf(name, attributes, stack[stack.length - 1]));
			},
			onclosetag() {
				flush();
				if (stack.length > 1) stack.pop();
			},
			oncomment: flush,
			ontext(text) {
				const end = parser.endIndex + 1;
				const start = end - text.length;
				if (run?.end === start) run.end = end;
				else {
					flush();
					run = { start, end };
				}
			},
		},
		{ decodeEntities: false },
	);
	parser.end(html);
	flush();
	return slots;
}

const plain = { skip: false, quoted: false, preformatted: true };

/** One paragraph's slots: a list keeps its markers, one slot per item; any other paragraph is one slot. */
function paragraphSlots(paragraph: string, offset: number): TranslationSlot[] {
	const lines = paragraph.split("\n");
	if (lines.some((line) => line.trimStart().startsWith(">"))) return [];
	if (!lines.every((line) => WHOLE_LINE_LIST_ITEM.test(line)))
		return slotsOfRun(paragraph, offset, plain, (raw) => raw);
	const slots: TranslationSlot[] = [];
	let position = offset;
	for (const line of lines) {
		const marker = WHOLE_LINE_LIST_ITEM.exec(line)?.[1] ?? "";
		slots.push(...slotsOfRun(line.slice(marker.length), position + marker.length, plain, (raw) => raw));
		position += line.length + 1;
	}
	return slots;
}

/** The new part of a plain-text message, by paragraph; the quoted history after it stays as it is. */
function textSlots(text: string): TranslationSlot[] {
	const { latestContent } = splitRepliedEmailContent(text);
	const at = latestContent ? text.indexOf(latestContent) : -1;
	const [start, end] = at >= 0 ? [at, at + latestContent.length] : [0, text.length];
	const paragraphs = text.slice(start, end).matchAll(/\S[^\n]*(?:\n[ \t]*\S[^\n]*)*/g);
	return [...paragraphs].flatMap((match) => paragraphSlots(match[0], start + match.index));
}

/**
 * The translatable pieces of a stored message: its HTML when it has any, as the reader shows that, else its text.
 * Mail that is all quote, such as a forward, counts as new.
 */
export function messageSlots(body: { htmlBody?: string | null; textBody?: string | null }): TranslationSource {
	if (body.htmlBody?.trim()) {
		const slots = htmlSlots(body.htmlBody);
		const onlyQuoted = slots.every((slot) => slot.quoted);
		return {
			format: "html",
			source: body.htmlBody,
			slots: onlyQuoted ? slots.map((slot) => ({ ...slot, quoted: false })) : slots,
		};
	}
	const source = (body.textBody ?? "").replace(/\r\n?/g, "\n");
	return { format: "text", source, slots: textSlots(source) };
}

/** Identifies the pieces a stored translation lines up with, so one never lands on a body cut differently. */
export function slotsDigest(slots: readonly TranslationSlot[]): Promise<string> {
	return sha256Prefix(JSON.stringify(["v1", ...slots.map((slot) => slot.text)]));
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The message with its translated slots in place. Everything between the slots, and each slot with no translation,
 * is the original source. In HTML a translation is escaped, so it is only ever text. The one markup that changes is
 * the direction the mail declared for its whole body (`withRootDirection`), which followed the original's language:
 * it becomes `auto`, or Arabic turned into English would stay aligned to the right.
 */
export function rebuildMessage(parsed: TranslationSource, segments: readonly (string | null)[]): string {
	if (parsed.format === "text") return replaceSlots(parsed, segments, (text) => text);
	const rebuilt = replaceSlots(parsed, segments, escapeHtml);
	return segments.some((segment) => segment !== null && segment !== undefined)
		? rebuilt.replace(ROOT_DIRECTION, '<div dir="auto">')
		: rebuilt;
}

function replaceSlots(
	parsed: TranslationSource,
	segments: readonly (string | null)[],
	encode: (text: string) => string,
): string {
	let result = "";
	let cursor = 0;
	parsed.slots.forEach((slot, index) => {
		const translated = segments[index];
		if (translated === null || translated === undefined) return;
		result += parsed.source.slice(cursor, slot.start) + encode(slot.pre + translated + slot.post);
		cursor = slot.end;
	});
	return result + parsed.source.slice(cursor);
}

/**
 * Groups slots, in the order given, into requests of at most `maxChars` of source text each, and stops at
 * `maxChunks`. Neighbouring pieces stay together so a request reads as connected text.
 */
export function planChunks(
	slots: readonly TranslationSlot[],
	indexes: readonly number[],
	limits: { maxChars: number; maxChunks: number; reserved?: number },
): TranslationPlan {
	const chunks: number[][] = [];
	let chunk: number[] = [];
	let size = limits.reserved ?? 0;
	for (const index of indexes) {
		const length = slots[index].text.length;
		if (chunk.length && size + length > limits.maxChars) {
			chunks.push(chunk);
			if (chunks.length === limits.maxChunks) return { chunks, cut: true };
			chunk = [];
			size = 0;
		}
		chunk.push(index);
		size += length;
	}
	if (chunk.length) chunks.push(chunk);
	return { chunks, cut: false };
}

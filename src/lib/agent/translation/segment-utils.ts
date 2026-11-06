import { Parser } from "htmlparser2";
import { EMAIL_PATTERN, URL_PATTERN } from "../auto-read/draft-guard-utils";
import { findLinks, type LinkMatch } from "@/lib/email/linkify-utils";
import { splitRepliedEmailContent } from "@/lib/email/reply-content-utils";
import { sha256Prefix } from "../summaries/summary-utils";
import { detectMessageLanguage } from "./detect-language-utils";
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
/** Text nobody sees: not worth paying for, and the usual place for instructions meant for a model. */
const HIDDEN_STYLE =
	/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:[a-z%]+)?\s*(?:;|!|$))/i;
const QUOTE_CLASSES = ["gmail_quote", "gmail_attr", "yahoo_quoted", "moz-cite-prefix"];
const QUOTE_IDS = ["divRplyFwdMsg"];
const WHOLE_LINE_LIST_ITEM = /^(\s*(?:[-•*]|\d{1,3}[.)])\s+)(.*)$/;
const BREAK = /[\s。！？；，、]/;
const LETTER = /\p{L}/u;
/** No named entity is longer (`&CounterClockwiseContourIntegral;`). */
const LONGEST_ENTITY = 34;
/** The reader folds a quote by this line above it (`collapseQuotedEmailHtml`), so it stays as it is. */
const QUOTE_INTRODUCTION = /^On\b[\s\S]*\bwrote:\s*$/i;
/** What one piece adds to a request and its answer, in characters of source text. */
const PIECE_OVERHEAD_CHARS = 24;
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

function isHidden(attributes: Record<string, string>): boolean {
	return "hidden" in attributes || HIDDEN_STYLE.test(attributes.style ?? "");
}

function frameOf(name: string, attributes: Record<string, string>, parent: Frame): Frame {
	const notTranslated = attributes.translate === "no" || classesOf(attributes).includes("notranslate");
	return {
		skip: parent.skip || SKIPPED_TAGS.has(name) || notTranslated || isHidden(attributes),
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
	if (entity > limit - LONGEST_ENTITY && !raw.slice(entity, limit).includes(";")) return entity;
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
		if (!isTranslatable(text) || QUOTE_INTRODUCTION.test(text)) continue;
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

/** One paragraph's slots, without its quoted lines: an inline reply has new lines between them. */
function paragraphSlots(paragraph: string, offset: number): TranslationSlot[] {
	const slots: TranslationSlot[] = [];
	let position = offset;
	let run: string[] = [];
	const flush = (end: number) => {
		if (run.length) slots.push(...runSlots(run, end - run.join("\n").length - 1));
		run = [];
	};
	for (const line of paragraph.split("\n")) {
		position += line.length + 1;
		if (line.trimStart().startsWith(">")) flush(position - line.length - 1);
		else run.push(line);
	}
	flush(position);
	return slots;
}

/** Consecutive lines: a list keeps its markers, one slot per item; anything else is one slot. */
function runSlots(lines: string[], offset: number): TranslationSlot[] {
	if (!lines.every((line) => WHOLE_LINE_LIST_ITEM.test(line)))
		return slotsOfRun(lines.join("\n"), offset, plain, (raw) => raw);
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

/**
 * The language of the slots in `indexes`, or null when they do not say clearly. Quoted history is left out by
 * passing only the new part: a Thai reply over an English thread is in Thai.
 */
export function slotsLanguage(parsed: TranslationSource, indexes: readonly number[]): string | null {
	return detectMessageLanguage(indexes.map((index) => parsed.slots[index].text).join("\n"));
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
	if (parsed.format === "text")
		return replaceSlots(
			parsed,
			segments.map((segment) => segment?.trim() ?? null),
			(text) => text,
		);
	const rebuilt = replaceSlots(parsed, segments, escapeHtml);
	return segments.some((segment) => segment !== null && segment !== undefined)
		? rebuilt.replace(ROOT_DIRECTION, '<div dir="auto">')
		: rebuilt;
}

/**
 * A translation keeps a space at its edge only where the original had none: Thai and Chinese run pieces together
 * that English has to separate ("Please click " + "here"). Plain text has no pieces to separate.
 */
function spaced(slot: TranslationSlot, translated: string): string {
	const start = slot.pre ? translated.trimStart() : translated;
	return slot.post ? start.trimEnd() : start;
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
		result += parsed.source.slice(cursor, slot.start) + encode(slot.pre + spaced(slot, translated) + slot.post);
		cursor = slot.end;
	});
	return result + parsed.source.slice(cursor);
}

/** Part of a text node as the reader will see it: `index` is the translated slot it came from, null for fixed text. */
type RunPart = { text: string; index: number | null };

/**
 * The message after rebuilding, as the text nodes the reader links: the translated pieces, and around them the text
 * nothing changes (slots not translated, white space kept at a slot's edge, and what lies between slots). A tag ends
 * a node, and in plain text only white space does, which the matcher handles.
 */
function textRuns(parsed: TranslationSource, segments: readonly (string | null)[]): RunPart[][] {
	const html = parsed.format === "html";
	const decode = html ? decodeEntities : (raw: string) => raw;
	const runs: RunPart[][] = [[]];
	const fixed = (raw: string) => {
		if (raw) runs[runs.length - 1].push({ text: decode(raw), index: null });
	};
	const between = (raw: string) => {
		const tag = html ? raw.indexOf("<") : -1;
		if (tag < 0) return fixed(raw);
		fixed(raw.slice(0, tag));
		runs.push([]);
		fixed(raw.slice(raw.lastIndexOf(">") + 1));
	};
	let cursor = 0;
	parsed.slots.forEach((slot, index) => {
		between(parsed.source.slice(cursor, slot.start));
		cursor = slot.end;
		const translated = segments[index];
		if (translated === null || translated === undefined) return fixed(parsed.source.slice(slot.start, slot.end));
		const shown = spaced(slot, html ? translated : translated.trim());
		runs[runs.length - 1].push(
			{ text: slot.pre, index: null },
			{ text: shown, index },
			{ text: slot.post, index: null },
		);
	});
	between(parsed.source.slice(cursor));
	return runs;
}

/** The message's own text, one string per text node, the way the reader sees it. */
export function sourceTexts(parsed: TranslationSource): string[] {
	return textRuns(parsed, [])
		.map((run) => run.map((part) => part.text).join(""))
		.filter(Boolean);
}

/** The run with `links`, given by their place in the joined text, taken out of its translated parts. */
function withoutLinks(run: readonly RunPart[], links: readonly LinkMatch[]): RunPart[] {
	let offset = 0;
	return run.map((part) => {
		const start = offset;
		offset += part.text.length;
		if (part.index === null) return part;
		const removed = (at: number) => links.some((link) => start + at >= link.start && start + at < link.end);
		return {
			...part,
			text: part.text
				.split("")
				.filter((_, at) => !removed(at))
				.join(""),
		};
	});
}

/**
 * The reader links text after the pieces are put back, so a piece that looks harmless alone can join its neighbour
 * into a link: another piece, from another request or left in the original, or text between the two. Each text node
 * is read whole, and what `invented` refuses is taken out of its translated parts, never out of the sender's text,
 * until nothing more goes: taking one out can join what was around it.
 */
export function withoutJoinedLinks(
	parsed: TranslationSource,
	segments: readonly (string | null)[],
	invented: (link: LinkMatch) => boolean,
): (string | null)[] {
	const result = [...segments];
	for (let run of textRuns(parsed, segments)) {
		if (!run.some((part) => part.index !== null)) continue;
		for (;;) {
			const cleaned = withoutLinks(run, findLinks(run.map((part) => part.text).join("")).filter(invented));
			if (cleaned.every((part, position) => part.text === run[position].text)) break;
			run = cleaned;
		}
		for (const part of run) if (part.index !== null) result[part.index] = part.text;
	}
	return result;
}

/** Characters that take far more room translated than they do here: one Han character is about one English word. */
const WIDE_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** A piece's share of a request: its text, counting wide characters twice, and the JSON around it. */
function pieceWeight(text: string): number {
	return text.length + (text.match(WIDE_SCRIPTS)?.length ?? 0) + PIECE_OVERHEAD_CHARS;
}

/**
 * Groups slots, in the order given, into requests of at most `maxChars` each, and stops at `maxChunks`. Each piece
 * is weighed by what its answer will take (`pieceWeight`), or a table of 3,000 one-word cells or a long Chinese mail
 * would not fit one answer. Neighbouring pieces stay together so a request reads as connected text.
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
		const length = pieceWeight(slots[index].text);
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

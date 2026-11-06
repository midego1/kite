import type {
	PreviousMessageDirection,
	ReplyContentParts,
	QuotedEmailContent,
	SplitReplyContentOptions,
} from "./reply-content-types";
import { normalizeEmailAddress } from "./address";

const ORIGINAL_MESSAGE_RE = /^-{2,}\s*Original Message\s*-{2,}$/i;
const UNDERSCORE_SEPARATOR_RE = /^_{8,}$/;
// Matched on trimmed lines. One `\s` on each side keeps it linear; `getWroteDateLine` trims the rest off the date.
const WROTE_RE = /^On\s(.+)\swrote:$/i;
const HEADER_RE = /^(From|To|Cc|Subject|Date|Sent):(.*)$/is;

/** Nested quotes kept apart: real threads stay well below this, and the text past it stays in the deepest quote. */
const MAX_QUOTE_DEPTH = 32;
/** The longest line read as a "wrote:" or header line, so the patterns reading those lines stay cheap. */
const MAX_MARKER_LINE_CHARS = 1_000;

type ReplyMarker = { kind: "original" | "separator" | "wrote" | "quote"; index: number };

type QuoteStart = { start: number; dateLine: string; direction: PreviousMessageDirection };

/**
 * Reply parsing works on one array of lines: every level reads the part of it behind the marker above, strips that
 * part's quote prefixes in place and copies out only its own text. The levels share the lines and their texts do not
 * overlap, so memory stays linear in the message and `MAX_QUOTE_DEPTH` bounds the passes over it.
 */
export function splitRepliedEmailContent(
	content: string | null | undefined,
	options: SplitReplyContentOptions = {},
): ReplyContentParts {
	const lines = splitLines(content);
	return splitLineRange(lines, 0, lines.length, options, 0);
}

export function getLatestEmailContent(content: string | null | undefined): string {
	const lines = splitLines(content);
	const marker = findReplyMarker(lines, 0, lines.length);
	return joinLines(lines, 0, marker?.index ?? lines.length);
}

function splitLineRange(
	lines: string[],
	start: number,
	end: number,
	options: SplitReplyContentOptions,
	depth: number,
): ReplyContentParts {
	const marker = depth < MAX_QUOTE_DEPTH ? findReplyMarker(lines, start, end) : null;
	if (!marker) return { latestContent: joinLines(lines, start, end), quotedContent: [] };
	const latestContent = joinLines(lines, start, marker.index);
	const quote = readQuoteStart(lines, marker, end, options);
	return {
		latestContent,
		quotedContent: buildQuotedContent(lines, quote, end, options, depth + 1),
	};
}

/** The first marker of the strongest kind: a line of "Original Message" anywhere beats a separator, and so on. */
function findReplyMarker(lines: string[], start: number, end: number): ReplyMarker | null {
	let separator = -1;
	let wrote = -1;
	let quote = -1;
	for (let index = start; index < end; index += 1) {
		const line = (lines[index] ?? "").trim();
		if (ORIGINAL_MESSAGE_RE.test(line)) return { kind: "original", index };
		if (separator < 0 && UNDERSCORE_SEPARATOR_RE.test(line)) separator = index;
		if (wrote < 0 && line.length <= MAX_MARKER_LINE_CHARS && WROTE_RE.test(line)) wrote = index;
		if (quote < 0 && line.startsWith(">")) quote = index;
	}
	if (separator >= 0) return { kind: "separator", index: separator };
	if (wrote >= 0) return { kind: "wrote", index: wrote };
	return quote >= 0 ? { kind: "quote", index: quote } : null;
}

function readQuoteStart(
	lines: string[],
	marker: ReplyMarker,
	end: number,
	options: SplitReplyContentOptions,
): QuoteStart {
	switch (marker.kind) {
		case "original":
			return readOriginalMessage(lines, marker.index + 1, end, options);
		case "separator":
			return readSeparatorQuote(lines, marker.index + 1, end, options);
		case "wrote": {
			const markerLine = lines[marker.index]?.trim() ?? "";
			stripQuotePrefixes(lines, marker.index + 1, end);
			return {
				start: marker.index + 1,
				dateLine: getWroteDateLine(markerLine),
				direction: getPreviousMessageDirection(getWroteAddress(markerLine), options.ownAddress),
			};
		}
		case "quote":
			stripQuotePrefixes(lines, marker.index, end);
			return { start: marker.index, dateLine: "Unknown time", direction: "received" };
	}
}

/** UTF-16 units of HTML read for text: snippets, search and automatic reading need far less, and the cost stays linear. */
const MAX_READABLE_HTML_CHARS = 250_000;

const STRIPPED_BLOCK_OPENER = /<(style|script|head)\b[^>]*>/gi;
const STRIPPED_BLOCK_CLOSER: Record<string, RegExp> = { style: /<\/style/gi, script: /<\/script/gi, head: /<\/head/gi };

/** Where the closing tag of `name` starts at or after `from`, or -1; searched in `html` itself, case-insensitively. */
function closingTagIndex(html: string, name: string, from: number): number {
	const closer = STRIPPED_BLOCK_CLOSER[name];
	closer.lastIndex = from;
	return closer.exec(html)?.index ?? -1;
}

/**
 * `html` without its `<style>`, `<script>` and `<head>` blocks, in one pass. An opener without a closing tag is left
 * in place (its tag is stripped later), and a missing closing tag is looked for once per name, so thousands of
 * unclosed openers cost no more than one (Mailflare #214).
 */
function stripBlocks(html: string): string {
	const missingClose = new Set<string>();
	let out = "";
	let cursor = 0;
	STRIPPED_BLOCK_OPENER.lastIndex = 0;
	for (let match = STRIPPED_BLOCK_OPENER.exec(html); match; match = STRIPPED_BLOCK_OPENER.exec(html)) {
		const name = match[1].toLowerCase();
		if (match.index < cursor || missingClose.has(name)) continue;
		const close = closingTagIndex(html, name, match.index + match[0].length);
		if (close === -1) {
			missingClose.add(name);
			continue;
		}
		const closeEnd = html.indexOf(">", close);
		out += `${html.slice(cursor, match.index)} `;
		cursor = closeEnd === -1 ? html.length : closeEnd + 1;
		STRIPPED_BLOCK_OPENER.lastIndex = cursor;
	}
	return out + html.slice(cursor);
}

export function htmlToReadableText(html: string | null | undefined): string {
	return (
		stripBlocks((html ?? "").slice(0, MAX_READABLE_HTML_CHARS))
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|li|tr|blockquote|h[1-6])>/gi, "\n")
			// `[^<>]` keeps an unclosed `<` from scanning to the end of the input for every opener.
			.replace(/<[^<>]*>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			// Last, so "&amp;lt;" becomes the literal "&lt;" instead of "<".
			.replace(/&amp;/g, "&")
	);
}

function readOriginalMessage(
	lines: string[],
	start: number,
	end: number,
	options: SplitReplyContentOptions,
): QuoteStart {
	const headers = new Map<string, string>();
	let contentStart = start;

	for (let index = start; index < end; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim()) {
			contentStart = index + 1;
			break;
		}

		const match = matchHeader(line);
		if (match) {
			headers.set(match[1].toLowerCase(), match[2].trim());
			contentStart = index + 1;
		}
	}

	stripQuotePrefixes(lines, contentStart, end);
	return {
		start: contentStart,
		dateLine: headers.get("date") ?? headers.get("sent") ?? "Unknown time",
		direction: getPreviousMessageDirection(headers.get("from"), options.ownAddress),
	};
}

function readSeparatorQuote(
	lines: string[],
	start: number,
	end: number,
	options: SplitReplyContentOptions,
): QuoteStart {
	return {
		start,
		dateLine: getHeaderValue(lines, start, end, "sent") ?? getHeaderValue(lines, start, end, "date") ?? "Unknown time",
		direction: getPreviousMessageDirection(getHeaderValue(lines, start, end, "from"), options.ownAddress),
	};
}

function getWroteDateLine(line: string): string {
	const match = line.match(WROTE_RE);
	const rawDateLine = match?.[1]?.trim() ?? "";
	return (
		rawDateLine
			.replace(/,\s*["']?[^,<"]+["']?\s*<[^>]+>\s*$/i, "")
			.replace(/\b([0-9]{1,2}:[0-9]{2}\s?(?:AM|PM))(?:,?\s+.*)?$/i, "$1")
			.trim() || "Unknown time"
	);
}

function getWroteAddress(line: string): string | undefined {
	return line.match(/<([^>]+@[^>]+)>/)?.[1];
}

function splitLines(content: string | null | undefined): string[] {
	return (content ?? "").replace(/\r\n?/g, "\n").split("\n");
}

function stripQuotePrefixes(lines: string[], start: number, end: number): void {
	for (let index = start; index < end; index += 1) {
		lines[index] = (lines[index] ?? "").replace(/^\s*>\s?/, "");
	}
}

function trimEmptyLines(lines: string[], start: number, end: number): [number, number] {
	let first = start;
	let last = end;

	while (first < last && !lines[first]?.trim()) first += 1;
	while (last > first && !lines[last - 1]?.trim()) last -= 1;

	return [first, last];
}

function joinLines(lines: string[], start: number, end: number): string {
	const [first, last] = trimEmptyLines(lines, start, end);
	return lines.slice(first, last).join("\n").trim();
}

function hasQuotedContent(quotedContent: QuotedEmailContent): boolean {
	return quotedContent.content.trim().length > 0 || quotedContent.quotedContent.length > 0;
}

function buildQuotedContent(
	lines: string[],
	{ start, dateLine, direction }: QuoteStart,
	end: number,
	options: SplitReplyContentOptions,
	depth: number,
): QuotedEmailContent[] {
	const [first, last] = trimEmptyLines(lines, start, end);
	if (first === last) return [];

	lines[first] = (lines[first] ?? "").trimStart();
	lines[last - 1] = (lines[last - 1] ?? "").trimEnd();
	const nested = splitLineRange(lines, first, last, options, depth);
	const quotedContent: QuotedEmailContent = {
		dateLine,
		direction,
		content: nested.latestContent,
		quotedContent: nested.quotedContent,
	};

	return hasQuotedContent(quotedContent) ? [quotedContent] : [];
}

function getPreviousMessageDirection(
	from: string | undefined,
	ownAddress: string | undefined,
): PreviousMessageDirection {
	if (!from || !ownAddress) return "received";
	const fromAddress = normalizeEmailAddress(from.match(/<([^>]+)>/)?.[1] ?? from);
	return fromAddress === normalizeEmailAddress(ownAddress) ? "sent" : "received";
}

function matchHeader(line: string): RegExpMatchArray | null {
	return line.length <= MAX_MARKER_LINE_CHARS ? line.match(HEADER_RE) : null;
}

function getHeaderValue(lines: string[], start: number, end: number, name: string): string | undefined {
	for (let index = start; index < end; index += 1) {
		const match = matchHeader(lines[index] ?? "");
		if (match?.[1].toLowerCase() === name) return match[2].trim();
	}
	return undefined;
}

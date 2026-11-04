/**
 * Helpers for the HTML composer. The editor owns one HTML string; the plain-text
 * alternative and the draft/send payloads are all derived from it, so there is
 * a single source of truth for what the message says.
 */

import { sanitizeEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/email-html-sanitizer";
import { firstStrongDirection, hasRtlCharacters, withAutoDirection } from "./rich-text-direction-utils";

export { resolveAutoDirections } from "./rich-text-direction-utils";

export const QUOTE_ATTRIBUTE = "data-kite-quote";
const QUOTE_OPEN = `<div class="kite-quote" ${QUOTE_ATTRIBUTE}="1">`;
const SIGNATURE_ATTRIBUTE = "data-kite-signature";
// Drafts and sent mail saved before the rename to Kite carry these markers.
const LEGACY_QUOTE_OPEN = `<div class="mailflare-quote" data-mailflare-quote="1">`;
const LEGACY_SIGNATURE_ATTRIBUTE = "data-mailflare-signature";

export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text as HTML: escaped, with line breaks preserved. */
export function textToHtml(text: string | null | undefined): string {
	const value = (text ?? "").replace(/\r\n?/g, "\n");
	if (!value) return "";
	return `<div>${escapeHtml(value).replace(/\n/g, "<br>")}</div>`;
}

/**
 * Plain text as HTML for a message that is sent without the composer opening (an assistant's draft). Left-to-right text
 * is exactly `textToHtml`; text with right-to-left letters gets one paragraph per line, each with the `rtl` or `ltr` its
 * own first letter decides, since nothing here can resolve `auto` later.
 */
export function textToDirectedHtml(text: string | null | undefined): string {
	const value = (text ?? "").replace(/\r\n?/g, "\n");
	if (!hasRtlCharacters(value)) return textToHtml(value);
	return value
		.split("\n")
		.map((line) => {
			const direction = firstStrongDirection(line);
			return `<div${direction ? ` dir="${direction}"` : ""}>${line ? escapeHtml(line) : "<br>"}</div>`;
		})
		.join("");
}

/**
 * Wrap quoted or forwarded content so the composer and reader can fold it. The original keeps its own direction: an
 * Arabic message quoted under an English reply (or the other way round) stays as it was written, and only its
 * right-to-left paragraphs get a `dir`, so what the sender set on a wrapping block keeps applying to the rest.
 */
export function wrapQuotedHtml(inner: string): string {
	return `${QUOTE_OPEN}${withAutoDirection(inner, { quote: true })}</div>`;
}

function findQuoteOpen(value: string): { index: number; open: string } | null {
	const current = value.indexOf(QUOTE_OPEN);
	const legacy = value.indexOf(LEGACY_QUOTE_OPEN);
	if (legacy >= 0 && (current < 0 || legacy < current)) return { index: legacy, open: LEGACY_QUOTE_OPEN };
	return current >= 0 ? { index: current, open: QUOTE_OPEN } : null;
}

/** Split a stored HTML body into the editable part and the folded quote, if any. */
export function splitQuotedHtml(html: string | null | undefined): { body: string; quoted: string | null } {
	const value = html ?? "";
	const found = findQuoteOpen(value);
	if (!found) return { body: value, quoted: null };
	const inner = value.slice(found.index + found.open.length).replace(/<\/div>\s*$/, "");
	return { body: value.slice(0, found.index), quoted: inner };
}

/**
 * A stored draft as editor state. Drafts can also be written by other mailbox
 * members, API clients over JMAP or the assistant, and the editor renders them in
 * the app's own document rather than a sandboxed frame, so both parts are
 * sanitized with the outgoing allowlist first.
 */
export function splitStoredDraftHtml(
	htmlBody: string | null | undefined,
	textBody: string | null | undefined,
): { body: string; quoted: string | null } {
	const stored = splitQuotedHtml(htmlBody || textToHtml(textBody));
	return {
		body: sanitizeEmailHtml(stored.body, { forOutgoing: true }) ?? "",
		quoted: stored.quoted === null ? null : (sanitizeEmailHtml(stored.quoted, { forOutgoing: true }) ?? ""),
	};
}

/** The draft or message HTML: what was written, with its directions in place, then the folded quote. */
export function joinQuotedHtml(body: string, quoted: string | null): string {
	const written = withAutoDirection(body);
	return quoted ? `${written}${wrapQuotedHtml(quoted)}` : written;
}

/** True when the HTML carries something other than empty blocks and whitespace. */
export function hasMeaningfulHtml(html: string): boolean {
	return htmlToPlainText(html).trim().length > 0 || /<img\b/i.test(html);
}

/** Distinguish stored HTML markup from existing plain-text signatures. */
export function isHtmlSignature(signature: string | null | undefined): boolean {
	return /<\/?[a-z][a-z0-9]*[\s>/]/i.test(signature ?? "");
}

export function signatureToHtml(signature: string | null | undefined): string {
	const value = signature?.trim() ?? "";
	if (!value) return "";
	if (isHtmlSignature(value) && typeof DOMParser !== "undefined") {
		return sanitizeEmailHtml(value, { forOutgoing: true }) ?? "";
	}
	return textToHtml(value).replace(/^<div>|<\/div>$/g, "");
}

// The editor puts `dir` on the block of a right-to-left signature, and the direction button can change it.
const SIGNATURE_DIRECTIONS = ["auto", "rtl", "ltr"];

/**
 * The signature block as inserted, then as the editor may hold it: with the `dir` it gives the paragraphs inside, and
 * with each direction on the block itself (the editor puts one on a right-to-left line of loose text, the direction
 * button can change it) and the `dir` it then gives the paragraphs inside, worked out the way the editor works it out.
 */
function signatureBlocks(signature: string | null | undefined, attribute = SIGNATURE_ATTRIBUTE): string[] {
	const html = signatureToHtml(signature);
	if (!html) return [];
	const block = (direction = "") => `<div ${attribute}="1"${direction}><br><br>${html}</div>`;
	// Block-level lines (`<div>مرحبا</div>`, a paragraph, a list) get their `dir` inside the block, none on it.
	return [
		block(),
		withAutoDirection(block(), { wrapLooseText: false }),
		...SIGNATURE_DIRECTIONS.map((direction) =>
			withAutoDirection(block(` dir="${direction}"`), { wrapLooseText: false }),
		),
	];
}

const DIRECTION_ATTRIBUTE = /\sdir="(?:auto|rtl|ltr)"/gi;
const OPTIONAL_DIRECTION = String.raw`(?:\s+dir="(?:auto|rtl|ltr)")?`;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a signature block whatever `dir` each of its elements carries. The direction button sets `dir` on any
 * paragraph, including the lines inside a block-level signature, one at a time or all at once, so the few forms of
 * `signatureBlocks` cannot cover every state the editor leaves it in.
 */
function directionTolerantPattern(block: string): RegExp {
	const source = block
		.split(/(<[a-z][a-z0-9]*(?:\s[^>]*)?>)/i)
		.map((part, index) => {
			if (index % 2 === 0) return escapeRegExp(part);
			const [, name = "", attributes = ""] = /^<([a-z][a-z0-9]*)([\s\S]*)>$/i.exec(part) ?? [];
			// The `dir` goes from the tag's own attributes only, never from text; it may sit between any two of them.
			const kept = (attributes.replace(DIRECTION_ATTRIBUTE, "").match(/\s+[^\s=>]+(?:="[^"]*")?/g) ?? []).map(
				(attribute) => `${OPTIONAL_DIRECTION}${escapeRegExp(attribute)}`,
			);
			return `<${escapeRegExp(name)}${kept.join("")}${OPTIONAL_DIRECTION}>`;
		})
		.join("");
	return new RegExp(source, "i");
}

/** The `dir` on the block itself (its first tag), else null. */
function blockDirection(block: string): string | null {
	const direction = /^<[^>]*?\sdir="(auto|rtl|ltr)"/i.exec(block)?.[1]?.toLowerCase();
	return direction ?? null;
}

/**
 * Swap or append the mailbox signature, mirroring the plain-text behaviour. An empty body gets one empty line
 * before the signature, so the caret, and what the user types, starts in the body rather than inside the block.
 */
export function applyMailboxSignatureHtml(
	html: string,
	previousSignature: string | null | undefined,
	nextSignature: string | null | undefined,
): string {
	const nextBlocks = signatureBlocks(nextSignature);
	const [nextBlock = ""] = nextBlocks;
	for (const attribute of [SIGNATURE_ATTRIBUTE, LEGACY_SIGNATURE_ATTRIBUTE]) {
		const previousBlocks = signatureBlocks(previousSignature, attribute);
		// The new signature keeps the direction the old one was given.
		// The last that matches: where two forms are the same text, the one with the direction on the block is the one meant.
		const index = previousBlocks.findLastIndex((block) => html.includes(block));
		if (index >= 0) return html.replace(previousBlocks[index] as string, () => nextBlocks[index] ?? nextBlock);
	}
	if (nextBlocks.some((block) => html.includes(block))) return html;
	// Any other `dir` on its elements: the direction button changed the lines inside.
	for (const attribute of [SIGNATURE_ATTRIBUTE, LEGACY_SIGNATURE_ATTRIBUTE]) {
		for (const block of signatureBlocks(previousSignature, attribute)) {
			const found = directionTolerantPattern(block).exec(html);
			if (!found) continue;
			// The same signature in the other mailbox: what the user did to its lines stays.
			if (signatureToHtml(previousSignature) === signatureToHtml(nextSignature)) return html;
			const own = blockDirection(found[0]);
			const next = nextBlocks[own ? 2 + SIGNATURE_DIRECTIONS.indexOf(own) : 1] ?? nextBlock;
			return html.slice(0, found.index) + next + html.slice(found.index + found[0].length);
		}
	}
	if (!nextBlock || nextBlocks.some((block) => directionTolerantPattern(block).test(html))) return html;
	return `${html.trim() ? html : "<div><br></div>"}${nextBlock}`;
}

const BLOCK_TAGS = new Set([
	"p",
	"div",
	"li",
	"tr",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"pre",
	"blockquote",
	"ul",
	"ol",
	"table",
]);

/**
 * One pass of `text.replace(/<[^>]+>/g, "")`, by index: every `<` with at least one character before the next `>`
 * goes up to that `>`. The regex rescans a long run of `<` with no `>` after it from each of them (quadratic); this
 * looks at every character once.
 */
function stripTags(text: string): string {
	const last = text.lastIndexOf(">");
	let kept = "";
	let index = 0;
	while (index < text.length) {
		const open = text.indexOf("<", index);
		// No `>` after this `<`: nothing from here on is a tag.
		if (open < 0 || open > last) return kept + text.slice(index);
		const close = text.indexOf(">", open + 1);
		if (close === open + 1) {
			// "<>" is no tag; the next search starts at its ">".
			kept += text.slice(index, open + 1);
			index = open + 1;
			continue;
		}
		kept += text.slice(index, open);
		index = close + 1;
	}
	return kept;
}

/**
 * The text/plain alternative of a composed message. Blocks become lines, lists
 * get bullets or numbers, blockquotes get the classic "> " prefix so reply
 * chains stay readable in text-only clients and in Kite's own reader.
 */
export function htmlToPlainText(html: string | null | undefined): string {
	if (!html) return "";
	if (typeof DOMParser === "undefined") {
		let text = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n");
		// Repeat until stable so removing one tag cannot leave a new one behind ("<<b>b>").
		for (let previous = ""; previous !== text;) {
			previous = text;
			text = stripTags(text);
		}
		return text;
	}
	const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
	const text = renderNode(doc.body, { listDepth: 0, ordered: [] });
	return (
		text
			// Only from the start of a run of blanks: a long run not followed by a line break would be rescanned otherwise.
			.replace(/(?<![ \t])[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

type RenderState = { listDepth: number; ordered: Array<number | null> };

function renderNode(node: Node, state: RenderState): string {
	if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
	if (node.nodeType !== Node.ELEMENT_NODE) return "";
	const element = node as HTMLElement;
	const tag = element.tagName.toLowerCase();
	if (tag === "br") return "\n";
	if (tag === "style" || tag === "script" || tag === "head") return "";

	if (tag === "ul" || tag === "ol") {
		const next: RenderState = { listDepth: state.listDepth + 1, ordered: [...state.ordered, tag === "ol" ? 0 : null] };
		const items = Array.from(element.children)
			.map((child) => {
				const index = next.ordered.length - 1;
				if (next.ordered[index] !== null) next.ordered[index] = (next.ordered[index] ?? 0) + 1;
				const marker = next.ordered[index] !== null ? `${next.ordered[index]}. ` : "- ";
				const indent = "  ".repeat(state.listDepth);
				return `${indent}${marker}${renderChildren(child, next).trim()}`;
			})
			.join("\n");
		return `\n${items}\n`;
	}

	let inner = renderChildren(element, state);
	if (tag === "a") {
		const href = element.getAttribute("href") ?? "";
		if (href && !href.startsWith("mailto:") && !isShownAddress(href, inner)) inner = `${inner} (${href})`;
	}
	if (tag === "blockquote") {
		const quoted = inner
			.trim()
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n");
		return `\n${quoted}\n`;
	}
	if (BLOCK_TAGS.has(tag)) return `\n${inner}\n`;
	return inner;
}

/** Scheme and host are case-insensitive; the path, query and fragment are not. */
function normalizeAddress(value: string): string {
	const parts = /^((?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*)([\s\S]*)$/i.exec(value);
	return parts ? `${(parts[1] as string).toLowerCase()}${parts[2]}` : value;
}

/** A link whose text already is its address (`www.example.com` for `https://www.example.com`) needs no "(href)". */
function isShownAddress(href: string, text: string): boolean {
	const shown = text.trim();
	const target = normalizeAddress(href);
	return [shown, `https://${shown}`, `http://${shown}`].some((candidate) => normalizeAddress(candidate) === target);
}

function renderChildren(element: Element, state: RenderState): string {
	return Array.from(element.childNodes)
		.map((child) => renderNode(child, state))
		.join("");
}

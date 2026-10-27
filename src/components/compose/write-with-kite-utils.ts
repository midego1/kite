import { escapeHtml } from "./rich-text-utils";

// The signature block `applyMailboxSignatureHtml` appends, and its pre-rename form.
const SIGNATURE_OPEN = /<div\b[^>]*\bdata-(?:kite|mailflare)-signature="1"[^>]*>/i;
const LIST_ITEM = /^\s*(?:[-•*]|\d{1,3}[.)])\s+/;
const ORDERED_ITEM = /^\s*\d{1,3}[.)]\s+/;
// Formatting a plain-text rewrite cannot keep.
const RICH_FORMATTING = /<(?:a|b|strong|i|em|u|s|strike|img|font|span\b[^>]*style)\b/i;

/** The editable body split at the signature block, which Write with Kite never sends or changes. */
export function splitSignature(html: string): { body: string; signature: string } {
	const match = SIGNATURE_OPEN.exec(html);
	if (!match) return { body: html, signature: "" };
	return { body: html.slice(0, match.index), signature: html.slice(match.index) };
}

/** The editor HTML with its body replaced and the signature block, if any, kept after it. */
export function replaceBody(html: string, body: string): string {
	return `${body}${splitSignature(html).signature}`;
}

function listHtml(lines: string[]): string {
	const tag = lines.every((line) => ORDERED_ITEM.test(line)) ? "ol" : "ul";
	const items = lines.map((line) => `<li>${escapeHtml(line.replace(LIST_ITEM, "").trim())}</li>`).join("");
	return `<${tag}>${items}</${tag}>`;
}

/**
 * Plain text from the model as editor HTML, escaped: blank-line-separated paragraphs become blocks with an empty
 * line between them, single line breaks stay, and a paragraph whose every line starts with "- ", "• " or "1. "
 * becomes a list.
 */
export function composeTextToHtml(text: string): string {
	const paragraphs = text
		.replace(/\r\n?/g, "\n")
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.split("\n").filter((line) => line.trim()))
		.filter((lines) => lines.length > 0);
	return paragraphs
		.map((lines) =>
			lines.every((line) => LIST_ITEM.test(line))
				? listHtml(lines)
				: `<div>${lines.map((line) => escapeHtml(line.trim())).join("<br>")}</div>`,
		)
		.join("<div><br></div>");
}

/** A translation followed by the original in a quote block, so the recipient can read both. */
export function withOriginalBelow(translationHtml: string, originalHtml: string): string {
	return `${translationHtml}<blockquote>${originalHtml}</blockquote>`;
}

/** Whether a fragment has bold, links, images or other formatting that a plain-text rewrite would drop. */
export function hasRichFormatting(html: string): boolean {
	return RICH_FORMATTING.test(html);
}

/** The languages Translate offers: the browser's own first when it is not one of the others. */
export function translateLanguages(browserLanguage: string | undefined): string[] {
	const fixed = ["English", "Dutch", "German", "French", "Spanish"];
	let own: string | null = null;
	try {
		const code = browserLanguage?.split("-")[0];
		own = code ? (new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? null) : null;
	} catch {
		own = null;
	}
	return own && !fixed.includes(own) ? [own, ...fixed] : fixed;
}

export type ComposeStreamEvent =
	| { type: "text"; text: string }
	| { type: "done"; text: string; warnings: string[] }
	| { type: "error"; error: string; code?: string; details?: unknown };

/** Complete NDJSON lines from a buffer, and the incomplete rest to keep for the next chunk. */
export function parseComposeEvents(buffer: string): { events: ComposeStreamEvent[]; rest: string } {
	const lines = buffer.split("\n");
	const rest = lines.pop() ?? "";
	const events: ComposeStreamEvent[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line) as ComposeStreamEvent);
		} catch {
			/* A malformed line is skipped; the final `done` or `error` decides the outcome. */
		}
	}
	return { events, rest };
}

const WARNING_TEXT: Record<string, string> = {
	removed_address: "An email address that is not in your text or the conversation was removed.",
	removed_link: "A link that is not in your text or the conversation was removed.",
	truncated: "The answer was too long and was shortened.",
};

export function warningText(warning: string): string {
	return WARNING_TEXT[warning] ?? warning;
}

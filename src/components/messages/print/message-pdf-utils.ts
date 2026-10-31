import type { TextPdfBlock } from "@/lib/pdf/text-pdf-types";
import type { PrintDocumentInput, PrintMessage } from "./print-types";

/** A paragraph of a message body as the PDF lays it out: its text, how deeply it is quoted and whether it is bold. */
type BodyParagraph = { text: string; depth: number; bold: boolean };

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const BLOCK_TAGS = new Set([
	"address",
	"blockquote",
	"caption",
	"dd",
	"div",
	"dl",
	"dt",
	"figcaption",
	"figure",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"li",
	"ol",
	"p",
	"pre",
	"table",
	"tbody",
	"tfoot",
	"thead",
	"tr",
	"ul",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const CELL_TAGS = new Set(["td", "th"]);

// Preview text and other content mail hides from people (`display:none`, Outlook's `mso-hide:all`).
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|mso-hide\s*:\s*all)\s*(?:!important\s*)?(?:;|$)/i;

type WalkState = {
	paragraphs: BodyParagraph[];
	line: string;
	/** A list item's marker, written before the item's first text even when that text is in a nested block. */
	marker: string;
	depth: number;
	bold: boolean;
};

function flush(state: WalkState, pre = false) {
	const lines = state.line.split("\n").map((part) => (pre ? part.trimEnd() : part.replace(/[ \t]+/g, " ").trim()));
	const text = pre ? lines.join("\n").replace(/^\n+|\n+$/g, "") : lines.join("\n").trim();
	if (text) {
		state.paragraphs.push({ text: state.marker + text, depth: state.depth, bold: state.bold });
		state.marker = "";
	}
	state.line = "";
}

function listMarker(element: Element): string {
	const list = element.parentElement;
	if (list?.tagName.toLowerCase() !== "ol") return "• ";
	const start = Number(list.getAttribute("start") ?? "1") || 1;
	const items = Array.from(list.children).filter((child) => child.tagName.toLowerCase() === "li");
	return `${start + items.indexOf(element)}. `;
}

function walkChildren(element: Element, state: WalkState, pre: boolean) {
	for (const child of Array.from(element.childNodes)) walk(child, state, pre);
}

function walk(node: Node, state: WalkState, pre: boolean) {
	if (node.nodeType === TEXT_NODE) {
		const text = node.textContent ?? "";
		state.line += pre ? text : text.replace(/\s+/g, " ");
		return;
	}
	if (node.nodeType !== ELEMENT_NODE) return;
	const element = node as Element;
	const tag = element.tagName.toLowerCase();
	if (tag === "br") {
		state.line += "\n";
		return;
	}
	if (tag === "img" || HIDDEN_STYLE.test(element.getAttribute("style") ?? "")) return;
	if (CELL_TAGS.has(tag) && state.line.trim()) state.line += "  ";
	if (!BLOCK_TAGS.has(tag)) return walkChildren(element, state, pre);
	flush(state, pre);
	if (tag === "hr") return;
	const outer = { depth: state.depth, bold: state.bold };
	if (tag === "blockquote") state.depth += 1;
	if (HEADING_TAGS.has(tag) || tag === "dt") state.bold = true;
	if (tag === "li") state.marker = listMarker(element);
	walkChildren(element, state, pre || tag === "pre");
	flush(state, pre || tag === "pre");
	// An empty item leaves no marker behind for the next paragraph.
	if (tag === "li") state.marker = "";
	state.depth = outer.depth;
	state.bold = outer.bold;
}

/** A sanitized HTML body (its parsed `<body>`) as paragraphs, keeping block structure, lists and quote depth.
 * @public Exercised by the unit tests.
 */
export function paragraphsFromHtml(body: Element): BodyParagraph[] {
	const state: WalkState = { paragraphs: [], line: "", marker: "", depth: 0, bold: false };
	for (const child of Array.from(body.childNodes)) walk(child, state, false);
	flush(state);
	return state.paragraphs;
}

/**
 * A plain-text body as paragraphs, one per line so its own line breaks and blank lines stay; `>` quoting becomes
 * quote depth.
 * @public Exercised by the unit tests.
 */
export function paragraphsFromText(text: string): BodyParagraph[] {
	return text
		.replace(/\r\n?/g, "\n")
		.trimEnd()
		.split("\n")
		.map((line) => {
			const quote = /^((?:>\s?)+)/.exec(line);
			const depth = quote ? (quote[1].match(/>/g) ?? []).length : 0;
			return { text: quote ? line.slice(quote[1].length) : line, depth, bold: false };
		});
}

const BODY_SIZE = 10.5;
const QUOTE_INDENT = 12;

function bodyBlocks(paragraphs: BodyParagraph[], spaced: boolean): TextPdfBlock[] {
	return paragraphs.map((paragraph) => ({
		text: paragraph.text,
		size: BODY_SIZE,
		bold: paragraph.bold,
		grey: paragraph.depth > 0 ? 0.4 : 0,
		indent: Math.min(paragraph.depth, 6) * QUOTE_INDENT,
		spaceBefore: spaced ? 4 : 0,
	}));
}

function messageBlocks(message: PrintMessage, title: string, parse: (html: string) => Element): TextPdfBlock[] {
	const blocks: TextPdfBlock[] = [{ rule: true, spaceBefore: 14 }];
	if (message.subject && message.subject !== title)
		blocks.push({ text: message.subject, size: 12, bold: true, spaceBefore: 8 });
	message.headers.forEach((row, index) =>
		blocks.push({ text: `${row.label}: ${row.value}`, size: 9.5, grey: 0.3, spaceBefore: index === 0 ? 8 : 0 }),
	);
	if (message.attachments.length) {
		blocks.push({ text: `Attachments (${message.attachments.length})`, size: 9.5, bold: true, spaceBefore: 8 });
		for (const attachment of message.attachments)
			blocks.push({ text: `• ${attachment.filename} (${attachment.size})`, size: 9.5, grey: 0.3, indent: 8 });
	}
	const body = message.html
		? bodyBlocks(paragraphsFromHtml(parse(message.html)), true)
		: bodyBlocks(paragraphsFromText(message.text), false);
	if (body.length) body[0] = { ...body[0], spaceBefore: 12 };
	return [...blocks, ...body];
}

/**
 * The PDF blocks for what Print shows: the subject, then for each message a rule, its headers, attachment names and
 * its body as text. `parse` turns sanitized HTML into a parsed `<body>` (DOMParser in the browser).
 */
export function messagePdfBlocks(
	{ title, messages }: PrintDocumentInput,
	parse: (html: string) => Element,
): TextPdfBlock[] {
	const heading = title.trim() || "(no subject)";
	const blocks: TextPdfBlock[] = [{ text: heading, size: 16, bold: true }];
	if (messages.length > 1)
		blocks.push({ text: `${messages.length} messages in this conversation`, size: 9.5, grey: 0.35, spaceBefore: 2 });
	for (const message of messages) blocks.push(...messageBlocks(message, heading, parse));
	return blocks;
}

import { Parser } from "htmlparser2";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { rootDirection, withRootDirection } from "@/lib/email/root-direction-utils";

/**
 * Received HTML is cleaned once before it is stored, so the API, JMAP, webhooks,
 * exports and any later renderer never see scripts, event handlers, frames, forms
 * or script URLs. It is deliberately looser than the reader's DOMPurify allowlist
 * (`email-html-sanitizer.ts`), which still runs on every display: layout, classes
 * and remote images stay so nothing visible is lost, and the raw MIME in storage
 * keeps the original.
 *
 * It runs on Workers and Node with a streaming tokenizer instead of a DOM. The
 * output only contains allowlisted elements that browsers parse as ordinary
 * markup (never raw-text elements such as `<style>` or `<textarea>`), and every
 * text node and attribute value is escaped, so a browser cannot read it back into
 * anything the allowlist did not permit.
 *
 * The work is bounded. The parser's cost per tag grows with the elements still open, and browsers stop nesting at the
 * same 512 levels, so past `MAX_OPEN_ELEMENTS` the sanitizer stops parsing, closes what it opened and keeps the rest
 * as plain text, as it does past `MAX_TAG_ATTRIBUTES` attributes on one tag. `MAX_SANITIZED_HTML_CHARS` is above the
 * largest body a message can hold, so only output that grew while it was escaped reaches it; what fits is kept, closed
 * the same way.
 */
const MAX_OPEN_ELEMENTS = 512;
const MAX_TAG_ATTRIBUTES = 1_024;
const MAX_SANITIZED_HTML_CHARS = 26_000_000;
/**
 * How much output waits to be joined. A string grown with `+=` or a global replace keeps a heap node per piece until it
 * is flattened, far more than a small tag's text, and joining flattens it.
 */
const OUTPUT_PIECES = 1_024;
const OUTPUT_PIECE_CHARS = 1024 * 1024;
/** Characters escaped at a time, so the output limit is checked long before a whole body has been replaced. */
const ESCAPE_SLICE_CHARS = 64 * 1024;

const STORED_TAGS = new Set([
	"a",
	"abbr",
	"address",
	"b",
	"big",
	"blockquote",
	"br",
	"caption",
	"center",
	"cite",
	"code",
	"col",
	"colgroup",
	"dd",
	"del",
	"dfn",
	"div",
	"dl",
	"dt",
	"em",
	"figcaption",
	"figure",
	"font",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"i",
	"img",
	"ins",
	"kbd",
	"li",
	"mark",
	"ol",
	"p",
	"pre",
	"q",
	"s",
	"samp",
	"small",
	"span",
	"strike",
	"strong",
	"sub",
	"sup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"tt",
	"u",
	"ul",
	"wbr",
]);
const VOID_TAGS = new Set(["br", "col", "hr", "img", "wbr"]);

// Dropped together with everything inside: code, controls, frames and foreign content.
// Other elements outside the allowlist are unwrapped and keep their text.
const DROP_CONTENT_TAGS = new Set([
	"applet",
	"iframe",
	"math",
	"noembed",
	"noframes",
	"noscript",
	"object",
	"script",
	"select",
	"style",
	"svg",
	"template",
	"textarea",
	"title",
	"xmp",
]);

const GLOBAL_ATTRIBUTES = new Set([
	"align",
	"bgcolor",
	"border",
	"class",
	"dir",
	"height",
	"lang",
	"style",
	"title",
	"valign",
	"width",
]);
const TAG_ATTRIBUTES: Record<string, Set<string>> = {
	a: new Set(["href", "name", "target"]),
	blockquote: new Set(["cite", "type"]),
	col: new Set(["span"]),
	colgroup: new Set(["span"]),
	font: new Set(["color", "face", "size"]),
	img: new Set(["src", "alt"]),
	li: new Set(["value"]),
	ol: new Set(["start", "type"]),
	table: new Set(["cellpadding", "cellspacing"]),
	td: new Set(["colspan", "rowspan", "nowrap"]),
	th: new Set(["colspan", "rowspan", "nowrap", "scope"]),
	ul: new Set(["type"]),
};
const DATA_ATTRIBUTE = /^data-[a-z0-9_.-]+$/;

const URL_ATTRIBUTES = new Set(["href", "src", "cite"]);
const LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
// cid: references inline attachments; the reader rewrites them to attachment URLs.
const IMAGE_SCHEMES = new Set(["http", "https", "data", "cid"]);
/** Longer than every allowed scheme, so a scheme cut here is simply not allowed. */
const MAX_SCHEME_CHARS = 32;
const UNSAFE_STYLE_VALUE = /expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding/i;

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return escapeText(value).replace(/"/g, "&quot;");
}

function isSchemeCharacter(code: number, first: boolean): boolean {
	const lower = code | 32;
	if (lower >= 97 && lower <= 122) return true;
	return !first && ((code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46);
}

/** The scheme of a URL. Browsers ignore C0 controls and spaces around a URL and tabs and newlines inside it. */
function urlScheme(value: string): string | null {
	let scheme = "";
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x20 || code === 0x7f) continue;
		if (code === 58) return scheme || null;
		if (!isSchemeCharacter(code, scheme === "")) return null;
		if (scheme.length < MAX_SCHEME_CHARS) scheme += value[index];
	}
	return null;
}

function isAllowedUrl(tag: string, value: string): boolean {
	const scheme = urlScheme(value);
	if (!scheme) return true;
	return (tag === "img" ? IMAGE_SCHEMES : LINK_SCHEMES).has(scheme.toLowerCase());
}

function isAllowedAttribute(tag: string, name: string, value: string): boolean {
	if (!GLOBAL_ATTRIBUTES.has(name) && !TAG_ATTRIBUTES[tag]?.has(name) && !DATA_ATTRIBUTE.test(name)) return false;
	if (URL_ATTRIBUTES.has(name)) return isAllowedUrl(tag, value);
	if (name === "style") return !UNSAFE_STYLE_VALUE.test(value);
	return true;
}

function createOutput() {
	let pieces: string[] = [];
	let pieceChars = 0;
	let joined = "";
	let length = 0;
	let blank = true;
	const join = () => {
		joined += pieces.join("");
		pieces = [];
		pieceChars = 0;
		return joined;
	};
	return {
		add(piece: string) {
			pieces.push(piece);
			pieceChars += piece.length;
			length += piece.length;
			if (blank && piece.trim() !== "") blank = false;
			if (pieces.length >= OUTPUT_PIECES || pieceChars >= OUTPUT_PIECE_CHARS) join();
		},
		isBlank: () => blank,
		isFull: () => length >= MAX_SANITIZED_HTML_CHARS,
		toString: join,
	};
}

/** The escaped attribute value, or null when escaping takes it past the output limit. */
function boundedAttribute(value: string): string | null {
	const escaped = createOutput();
	for (let start = 0; start < value.length; start += ESCAPE_SLICE_CHARS) {
		escaped.add(escapeAttribute(value.slice(start, start + ESCAPE_SLICE_CHARS)));
		if (escaped.isFull()) return null;
	}
	return escaped.toString();
}

function openTag(tag: string, attributes: Record<string, string>): string {
	let markup = `<${tag}`;
	for (const [name, value] of Object.entries(attributes)) {
		if (!isAllowedAttribute(tag, name, value)) continue;
		const escaped = boundedAttribute(value);
		if (escaped !== null) markup += ` ${name}="${escaped}"`;
	}
	return `${markup}>`;
}

export function sanitizeStoredEmailHtml(html: string | null | undefined): string | null {
	if (!html) return null;
	const output = createOutput();
	// Everything the parser holds open, and the stored elements among them, innermost last.
	let depth = 0;
	const open: string[] = [];
	// Depth inside a dropped element; the tokenizer reports every open tag with a matching close.
	let dropped = 0;
	let attributeCount = 0;
	let stopped = false;
	const stop = () => {
		stopped = true;
		parser.pause();
	};
	// The direction the mail declares on its own <html> and <body>, which are not stored; the first of each counts.
	const root: { html?: string; body?: string } = {};
	const parser = new Parser(
		{
			onattribute() {
				attributeCount += 1;
				if (attributeCount > MAX_TAG_ATTRIBUTES) stop();
			},
			onopentag(name, attributes) {
				if (stopped) return;
				attributeCount = 0;
				depth += 1;
				if (depth > MAX_OPEN_ELEMENTS) {
					stop();
					return;
				}
				if (dropped > 0 || DROP_CONTENT_TAGS.has(name)) {
					dropped += 1;
					return;
				}
				// Only a root tag that opens the mail counts: in a fragment, a later one is content, not a root.
				if ((name === "html" || name === "body") && root[name] === undefined && output.isBlank()) {
					root[name] = attributes.dir ?? "";
				}
				if (!STORED_TAGS.has(name)) return;
				output.add(openTag(name, attributes));
				if (!VOID_TAGS.has(name)) open.push(name);
				if (output.isFull()) stop();
			},
			onclosetag(name) {
				if (stopped) return;
				depth -= 1;
				if (dropped > 0) {
					dropped -= 1;
					return;
				}
				if (STORED_TAGS.has(name) && !VOID_TAGS.has(name)) {
					open.pop();
					output.add(`</${name}>`);
				}
			},
			ontext(text) {
				if (stopped || dropped > 0) return;
				for (let start = 0; start < text.length && !stopped; start += ESCAPE_SLICE_CHARS) {
					output.add(escapeText(text.slice(start, start + ESCAPE_SLICE_CHARS)));
					if (output.isFull()) stop();
				}
			},
		},
		{ decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
	);
	parser.write(html);
	if (stopped) {
		while (open.length > 0) output.add(`</${open.pop()}>`);
		if (dropped === 0 && !output.isFull()) {
			output.add(
				`<div style="white-space: pre-wrap">${escapeText(htmlToReadableText(html.slice(parser.endIndex + 1)))}</div>`,
			);
		}
	} else {
		parser.end();
	}
	return withRootDirection(output.toString(), rootDirection(root.body, root.html));
}

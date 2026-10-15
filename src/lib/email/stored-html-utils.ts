import { Parser } from "htmlparser2";

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
 */
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
// Browsers ignore C0 controls and spaces around a URL and tabs and newlines inside it.
// eslint-disable-next-line no-control-regex
const URL_IGNORED_CHARACTERS = /[\u0000-\u0020\u007f]/g;
const UNSAFE_STYLE_VALUE = /expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding/i;

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return escapeText(value).replace(/"/g, "&quot;");
}

function isAllowedUrl(tag: string, value: string): boolean {
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value.replace(URL_IGNORED_CHARACTERS, ""))?.[1];
	if (!scheme) return true;
	return (tag === "img" ? IMAGE_SCHEMES : LINK_SCHEMES).has(scheme.toLowerCase());
}

function isAllowedAttribute(tag: string, name: string, value: string): boolean {
	if (!GLOBAL_ATTRIBUTES.has(name) && !TAG_ATTRIBUTES[tag]?.has(name) && !DATA_ATTRIBUTE.test(name)) return false;
	if (URL_ATTRIBUTES.has(name)) return isAllowedUrl(tag, value);
	if (name === "style") return !UNSAFE_STYLE_VALUE.test(value);
	return true;
}

function openTag(tag: string, attributes: Record<string, string>): string {
	let markup = `<${tag}`;
	for (const [name, value] of Object.entries(attributes)) {
		if (isAllowedAttribute(tag, name, value)) markup += ` ${name}="${escapeAttribute(value)}"`;
	}
	return `${markup}>`;
}

export function sanitizeStoredEmailHtml(html: string | null | undefined): string | null {
	if (!html) return null;
	let output = "";
	// Depth inside a dropped element; the tokenizer reports every open tag with a matching close.
	let dropped = 0;
	const parser = new Parser(
		{
			onopentag(name, attributes) {
				if (dropped > 0 || DROP_CONTENT_TAGS.has(name)) {
					dropped += 1;
					return;
				}
				if (STORED_TAGS.has(name)) output += openTag(name, attributes);
			},
			onclosetag(name) {
				if (dropped > 0) {
					dropped -= 1;
					return;
				}
				if (STORED_TAGS.has(name) && !VOID_TAGS.has(name)) output += `</${name}>`;
			},
			ontext(text) {
				if (dropped === 0) output += escapeText(text);
			},
		},
		{ decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
	);
	parser.write(html);
	parser.end();
	return output;
}

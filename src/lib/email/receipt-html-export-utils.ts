/**
 * Turns the already-stored-sanitized message HTML (`sanitizeStoredEmailHtml`, which keeps remote images and
 * `cid:` references so nothing visible is lost on screen) into a standalone document with no remote content: every
 * `<img src>` that is not already a `data:` URI is blanked, and a `style` attribute that could reference anything
 * (`url(`, `image-set(`, or a backslash, which CSS accepts as an escape inside a function name or a URL) has its
 * whole value dropped rather than surgically edited: CSS has too many ways to spell the same function name to
 * blocklist reliably. `buildReceiptHtmlDocument` also sets a strict Content-Security-Policy (`img-src data:`, no
 * `default-src`) as the real backstop, enforced by the browser's resource loader after full CSS parsing, so a
 * style-stripping gap here is defense in depth, not the only thing standing between the file and a remote request.
 *
 * This reads and rewrites attributes with `htmlparser2` (the same tokenizer `stored-html-utils.ts` sanitizes mail
 * with), not regular expressions over the raw markup: a regex anchored on `\bsrc="` or `\brel="` cannot tell an
 * `<img>`'s own `src` from the literal text `src="…"` sitting inside that same tag's `alt` or `title` value (which
 * the sanitizer keeps verbatim), so a crafted `alt`/`title` could make the real attribute's value survive
 * untouched. The parser never confuses one attribute's value for another's name.
 *
 * `cid:` inline images are blanked too (v1 does not embed them as `data:` URIs): the document stays strictly
 * self-contained rather than silently showing a half-resolved image.
 */

import { Parser } from "htmlparser2";
import { DROP_CONTENT_TAGS } from "./stored-html-utils";

const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

/** A backslash (CSS's escape character, valid inside a function name or a URL) or a numeric character reference:
 * never needed by an ordinary style value, always suspicious here. */
const ALWAYS_RISKY = /\\|&#/;
/** CSS functions that can reach outside the document; `image-set(` is never given a bare `data:` carve-out, since
 * mail has no legitimate reason to use it and it is rare enough that dropping it costs nothing real. */
const IMAGE_SET_FN = /image-set\(/i;
/** Everything between one `url(` and its first `)`; a `data:` URI's base64 body never contains a paren. */
const URL_FN = /url\(([^)]*)\)/gi;
const QUOTE_PAIRS = ['"', "'"] as const;

/** `url(...)`'s content with one matching pair of quotes removed. */
function unwrapUrlContent(raw: string): string {
	const value = raw.trim();
	for (const quote of QUOTE_PAIRS)
		if (value.startsWith(quote) && value.endsWith(quote) && value.length >= quote.length * 2)
			return value.slice(quote.length, -quote.length).trim();
	return value;
}

function isSafeDataUri(rawUrlContent: string): boolean {
	return /^data:/i.test(unwrapUrlContent(rawUrlContent));
}

/**
 * The `style` value kept as is when every `url(...)` in it plainly names a `data:` URI, or `null` to drop the
 * whole value: a bare `url(` the pattern below does not fully decode, `image-set(`, a CSS backslash escape or a
 * numeric character reference anywhere in the value all drop it outright. CSS has too many ways to spell the
 * same function name to blocklist exact forms reliably, so this errs toward dropping styling rather than risking
 * a remote request; `buildReceiptHtmlDocument`'s Content-Security-Policy is the real backstop regardless.
 */
function sanitizedStyleValue(value: string): string | null {
	if (ALWAYS_RISKY.test(value) || IMAGE_SET_FN.test(value)) return null;
	const openCount = (value.match(/url\(/gi) ?? []).length;
	let matched = 0;
	URL_FN.lastIndex = 0;
	for (let match = URL_FN.exec(value); match; match = URL_FN.exec(value)) {
		matched += 1;
		if (!isSafeDataUri(match[1])) return null;
	}
	// A "url(" with no matching ")", or more opens than this pass matched, is malformed enough to drop outright.
	return matched === openCount ? value : null;
}

function isRemoteOrInlineImageSrc(src: string): boolean {
	return !src.toLowerCase().startsWith("data:");
}

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return escapeText(value).replace(/"/g, "&quot;");
}

const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
]);

/** A link's `rel` for a standalone file: the tokens it already has, minus `opener`, plus `noopener noreferrer`, so
 * a link that opens a new tab never gets `window.opener` whatever `rel` the mail named. */
function noopenerRel(existing: string | undefined): string {
	const tokens = (existing ?? "")
		.toLowerCase()
		.split(/\s+/)
		.filter((token) => token && token !== "opener");
	for (const required of ["noopener", "noreferrer"]) if (!tokens.includes(required)) tokens.push(required);
	return tokens.join(" ");
}

type StripOptions = { images?: boolean; styles?: boolean; links?: boolean };

/**
 * One pass over the markup with `htmlparser2`, rewriting only the attributes `options` asks for and leaving
 * everything else (tag and attribute order, text, entities already decoded back to their literal character)
 * exactly as it was: the single implementation `blankRemoteImages`, `blankRemoteStyleUrls`, `noopenerLinks` and
 * `stripRemoteContent` each call with a different subset enabled, so there is one tokenizing pass to keep
 * correct instead of three separate regex implementations.
 */
function rewriteHtml(html: string, options: StripOptions): string {
	const out: string[] = [];
	let dropped = 0;
	const parser = new Parser(
		{
			onopentag(name, attributes) {
				// The stored sanitizer already dropped these with everything inside; the same rule here keeps a raw-text
				// element (`<style>`, `<textarea>`, ...) from coming out as visible text if one ever reaches the export.
				if (dropped > 0 || DROP_CONTENT_TAGS.has(name)) {
					dropped += 1;
					return;
				}
				const attrs: Record<string, string> = { ...attributes };
				if (options.images && name === "img" && typeof attrs.src === "string" && isRemoteOrInlineImageSrc(attrs.src)) {
					attrs.src = BLANK_PIXEL;
				}
				if (options.links && name === "a" && "target" in attrs) attrs.rel = noopenerRel(attrs.rel);
				if (options.styles && typeof attrs.style === "string") {
					attrs.style = sanitizedStyleValue(attrs.style) ?? "";
				}
				out.push(`<${name}`);
				for (const [attrName, value] of Object.entries(attrs)) out.push(` ${attrName}="${escapeAttribute(value)}"`);
				out.push(">");
			},
			onclosetag(name) {
				if (dropped > 0) {
					dropped -= 1;
					return;
				}
				if (!VOID_TAGS.has(name)) out.push(`</${name}>`);
			},
			ontext(text) {
				if (dropped > 0) return;
				out.push(escapeText(text));
			},
		},
		{ decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
	);
	parser.write(html);
	parser.end();
	return out.join("");
}

/** Blanks every image source that is not already a `data:` URI (remote `http(s)`/`//`, and `cid:` references). */
export function blankRemoteImages(html: string): string {
	return rewriteHtml(html, { images: true });
}

/**
 * Drops the whole value of a `style` attribute that could reach outside the document, leaving one with no such
 * risk untouched.
 */
export function blankRemoteStyleUrls(html: string): string {
	return rewriteHtml(html, { styles: true });
}

/** Adds `noopener noreferrer` to the `rel` of a link opened in a new tab (dropping `opener`), so a standalone file never gets `window.opener`. */
export function noopenerLinks(html: string): string {
	return rewriteHtml(html, { links: true });
}

/** Every stripping concern, in one pass; the result has no remote content and no scripts (already true of its input). */
export function stripRemoteContent(html: string): string {
	return rewriteHtml(html, { images: true, styles: true, links: true });
}

export type ReceiptHtmlHeader = {
	fromName: string | null;
	fromAddress: string;
	subject: string | null;
	dateText: string;
};

/**
 * One self-contained HTML document: a plain header (From, date, subject) and the sanitized, now remote-content-free
 * body, with an inline reset so it reads the same in any browser without Kite's stylesheet. No external request,
 * script or stylesheet is referenced, and a strict Content-Security-Policy backs that up at the browser level:
 * `default-src 'none'` refuses anything not named below, `img-src data:` lets only already-inlined images draw
 * (blocking a remote image or CSS `url()` background even if some obfuscated form slipped past
 * `blankRemoteStyleUrls`), and `style-src 'unsafe-inline'` is only what the inline `<style>` and `style="…"`
 * attributes need to apply. The body is painted in its own containing block (`contain: paint`) so a sender's
 * `position: fixed`/`absolute` cannot escape it to cover the header above with a fake one.
 */
export function buildReceiptHtmlDocument(header: ReceiptHtmlHeader, bodyHtml: string): string {
	const subject = header.subject?.trim() || "(no subject)";
	const from = header.fromName ? `${header.fromName} <${header.fromAddress}>` : header.fromAddress;
	const safeBody = stripRemoteContent(bodyHtml);
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeText(subject)}</title>
<style>
	body { margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; background: #fff; }
	.kite-receipt-header { border-bottom: 1px solid #ddd; margin-bottom: 20px; padding-bottom: 16px; }
	.kite-receipt-header dt { font-size: 12px; color: #666; margin-top: 8px; }
	.kite-receipt-header dd { margin: 0; font-size: 14px; }
	.kite-receipt-body { max-width: 800px; position: relative; overflow: hidden; contain: paint; }
	img { max-width: 100%; }
</style>
</head>
<body>
<dl class="kite-receipt-header">
	<dt>From</dt><dd>${escapeText(from)}</dd>
	<dt>Date</dt><dd>${escapeText(header.dateText)}</dd>
	<dt>Subject</dt><dd>${escapeText(subject)}</dd>
</dl>
<div class="kite-receipt-body">${safeBody}</div>
</body>
</html>
`;
}

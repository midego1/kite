/**
 * Turns the already-stored-sanitized message HTML (`sanitizeStoredEmailHtml`, which keeps remote images and
 * `cid:` references so nothing visible is lost on screen) into a standalone document with no remote content: every
 * `<img src>` that is not already a `data:` URI is blanked, and a `style` attribute that could reference anything
 * (`url(`, `image-set(`, or a backslash, which CSS accepts as an escape inside a function name or a URL, including
 * the `&quot;`-escaped form the sanitizer's own output already uses for a literal quote) has its whole value
 * dropped rather than surgically edited: CSS has too many ways to spell the same function name to blocklist
 * reliably. `buildReceiptHtmlDocument` also sets a strict Content-Security-Policy (`img-src data:`, no
 * `default-src`) as the real backstop, enforced by the browser's resource loader after full CSS parsing, so a
 * style-stripping gap here is defense in depth, not the only thing standing between the file and a remote request.
 *
 * `cid:` inline images are blanked too (v1 does not embed them as `data:` URIs): the document stays strictly
 * self-contained rather than silently showing a half-resolved image.
 */

const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const IMG_SRC = /(<img\b[^>]*?\bsrc=")([^"]*)(")/gi;
const STYLE_ATTR = /(\sstyle=")([^"]*)(")/gi;
/** A backslash (CSS's escape character, valid inside a function name or a URL) or a numeric character reference:
 * never needed by an ordinary style value, always suspicious here. */
const ALWAYS_RISKY = /\\|&#/;
/** CSS functions that can reach outside the document; `image-set(` is never given a bare `data:` carve-out, since
 * mail has no legitimate reason to use it and it is rare enough that dropping it costs nothing real. */
const IMAGE_SET_FN = /image-set\(/i;
/** Everything between one `url(` and its first `)`; a `data:` URI's base64 body never contains a paren. */
const URL_FN = /url\(([^)]*)\)/gi;
const QUOTE_PAIRS = ['"', "'", "&quot;"] as const;

/** `url(...)`'s content with one matching pair of quotes removed, literal or the sanitizer's `&quot;` form. */
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

const BLANK_TARGET_LINK = /(<a\b(?=[^>]*\btarget=")(?![^>]*\brel=")[^>]*)(>)/gi;

function isRemoteOrInlineImageSrc(src: string): boolean {
	return !src.toLowerCase().startsWith("data:");
}

/** Blanks every image source that is not already a `data:` URI (remote `http(s)`/`//`, and `cid:` references). */
export function blankRemoteImages(html: string): string {
	return html.replace(IMG_SRC, (match, before: string, src: string, after: string) =>
		isRemoteOrInlineImageSrc(src) ? `${before}${BLANK_PIXEL}${after}` : match,
	);
}

/**
 * Drops the whole value of a `style` attribute that could reach outside the document, leaving one with no such
 * risk untouched. A `url(...)` whose content is plainly (after stripping the quotes, including the `&quot;` form
 * the sanitizer's own output uses for a literal quote) a `data:` URI is kept, since that can never itself trigger
 * a further request; anything else — a bare `url(` the pattern above does not fully decode, `image-set(`, a CSS
 * backslash escape or a numeric character reference anywhere in the value — drops the whole value. CSS has too
 * many ways to spell the same function name to blocklist exact forms reliably, so this errs toward dropping
 * styling rather than risking a remote request; `buildReceiptHtmlDocument`'s Content-Security-Policy is the real
 * backstop regardless.
 */
export function blankRemoteStyleUrls(html: string): string {
	return html.replace(STYLE_ATTR, (_match, before: string, value: string, after: string) => {
		if (ALWAYS_RISKY.test(value) || IMAGE_SET_FN.test(value)) return `${before}${after}`;
		const openCount = (value.match(/url\(/gi) ?? []).length;
		let matched = 0;
		URL_FN.lastIndex = 0;
		for (let match = URL_FN.exec(value); match; match = URL_FN.exec(value)) {
			matched += 1;
			if (!isSafeDataUri(match[1])) return `${before}${after}`;
		}
		// A "url(" with no matching ")", or more opens than this pass matched, is malformed enough to drop outright.
		return matched === openCount ? `${before}${value}${after}` : `${before}${after}`;
	});
}

/** Adds `rel="noopener noreferrer"` to a link opened in a new tab, so a standalone file never gets `window.opener`. */
export function noopenerLinks(html: string): string {
	return html.replace(
		BLANK_TARGET_LINK,
		(_match, start: string, close: string) => `${start} rel="noopener noreferrer"${close}`,
	);
}

/** Every stripping pass, in order; the result has no remote content and no scripts (already true of its input). */
export function stripRemoteContent(html: string): string {
	return noopenerLinks(blankRemoteStyleUrls(blankRemoteImages(html)));
}

function escapeHtmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
<title>${escapeHtmlText(subject)}</title>
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
	<dt>From</dt><dd>${escapeHtmlText(from)}</dd>
	<dt>Date</dt><dd>${escapeHtmlText(header.dateText)}</dd>
	<dt>Subject</dt><dd>${escapeHtmlText(subject)}</dd>
</dl>
<div class="kite-receipt-body">${safeBody}</div>
</body>
</html>
`;
}

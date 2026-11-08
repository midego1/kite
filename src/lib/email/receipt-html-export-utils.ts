/**
 * Turns the already-stored-sanitized message HTML (`sanitizeStoredEmailHtml`, which keeps remote images and
 * `cid:` references so nothing visible is lost on screen) into a standalone document with no remote content: every
 * `<img src>` that is not already a `data:` URI is blanked, and a `url(...)` inside a `style` attribute pointing at
 * `http(s):` or a bare `//` host is replaced with `none`. Attribute values in the sanitizer's output are always
 * escaped (`"` becomes `&quot;`), so a value can never contain a literal quote that would let this run past the
 * attribute it targets.
 *
 * `cid:` inline images are blanked too (v1 does not embed them as `data:` URIs): the document stays strictly
 * self-contained rather than silently showing a half-resolved image.
 */

const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

const IMG_SRC = /(<img\b[^>]*?\bsrc=")([^"]*)(")/gi;
const STYLE_ATTR = /(\sstyle=")([^"]*)(")/gi;
const STYLE_URL = /url\(\s*(['"]?)(https?:|\/\/)[^)'"]*\1\s*\)/gi;
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

/** Replaces a remote `url(...)` inside a `style` attribute with `none`, leaving `data:` and relative values alone. */
export function blankRemoteStyleUrls(html: string): string {
	return html.replace(STYLE_ATTR, (_match, before: string, value: string, after: string) => {
		const cleaned = value.replace(STYLE_URL, "none");
		return `${before}${cleaned}${after}`;
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
 * script or stylesheet is referenced.
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
<title>${escapeHtmlText(subject)}</title>
<style>
	body { margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; background: #fff; }
	.kite-receipt-header { border-bottom: 1px solid #ddd; margin-bottom: 20px; padding-bottom: 16px; }
	.kite-receipt-header dt { font-size: 12px; color: #666; margin-top: 8px; }
	.kite-receipt-header dd { margin: 0; font-size: 14px; }
	.kite-receipt-body { max-width: 800px; }
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

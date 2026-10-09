import type { EmailFrameDocumentOptions } from "./email-html-frame-types";

/**
 * Received mail renders in an iframe with `sandbox` but without `allow-scripts`,
 * so nothing in a message can run in the app's origin. `allow-same-origin` only
 * lets the reader measure the document for auto-height and load inline
 * attachments with the session cookie.
 */
export const EMAIL_FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

const BASE_STYLES = [
	"html{overflow-y:hidden;overflow-x:auto}",
	'body{margin:0;padding:0;font-size:14px;line-height:1.5;overflow-wrap:anywhere;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
	"img{max-width:100%;height:auto}",
	"table{max-width:100%}",
	"ul{list-style:disc;padding-left:1.5rem;margin:.25rem 0}",
	"ol{list-style:decimal;padding-left:1.5rem;margin:.25rem 0}",
	"blockquote{border-left:2px solid #d4d4d4;margin:.25rem 0;padding-left:.75rem}",
	"a{text-decoration:underline}",
	"p{margin:0 0 .5rem}",
	".email-quote-toggle{margin-top:1.4em}",
	".email-quote-toggle>summary{display:inline-flex;align-items:center;justify-content:center;width:26px;height:12px;border-radius:9999px;background:#ececec;color:#4d4d4d;cursor:pointer;list-style:none}",
	".email-quote-toggle>summary::-webkit-details-marker{display:none}",
	'.email-quote-toggle>summary::marker{content:""}',
	'.email-quote-toggle>summary::before{content:"•••";font-size:11px;font-weight:700;letter-spacing:.04em}',
	".email-quote-toggle>summary:hover{background:#e5e5e5}",
	".email-quote-content{display:flow-root}",
].join("");

const LIGHT_STYLES = "html{color-scheme:light}body{color:#171717}a{color:#2563eb}blockquote{color:#525252}";
// The frame's color-scheme must match the app's for its canvas to stay transparent.
const DARK_STYLES =
	"html{color-scheme:dark}body{color:#e8eaed}a{color:#8ab4f8}blockquote{color:#9aa0a6;border-left-color:#5f6368}.email-quote-toggle>summary{background:#3c4043;color:#e8eaed}.email-quote-toggle>summary:hover{background:#5f6368}";

// Designed mail (newsletters, notifications) paints its own light backgrounds but
// often leaves text colour to inherit, so restyling only the text would put light
// text on white. In dark mode such mail is rendered light and then inverted as a
// whole, the way Outlook and Spark do it; media is inverted back so photos and
// logos keep their colours. invert(.92) instead of 1 keeps whites off pure black
// and dims media slightly (0.08 + 0.84x after the double inversion).
const OWN_BACKGROUND =
	/\bbgcolor\s*=|background(?:-color)?\s*:\s*(?!\s*(?:transparent|none|inherit|initial|unset)\b)[^;"'}]/i;
const INVERTED_STYLES = [
	"html{background:#f2f2f0;filter:invert(.92) hue-rotate(180deg)}",
	"body{padding:12px}",
	'img,video,picture,svg,iframe,[background],[style*="background-image"],[style*="background:url"],[style*="background: url"]{filter:invert(1) hue-rotate(180deg)}',
].join("");

export function hasOwnBackground(html: string): boolean {
	return OWN_BACKGROUND.test(html);
}

export function buildEmailFrameDocument(html: string, options: EmailFrameDocumentOptions = {}): string {
	const inverted = !!options.dark && !options.original && hasOwnBackground(html);
	const dark = !!options.dark && !hasOwnBackground(html);
	const lightCanvas = !!options.dark && !dark && !inverted;
	const colorStyles =
		(dark ? DARK_STYLES : LIGHT_STYLES) +
		(inverted ? INVERTED_STYLES : "") +
		(lightCanvas ? "html{background:#fff}body{padding:12px}" : "");
	const muted = options.muted ? (dark ? "body{color:#9aa0a6}" : "body{color:#525252}") : "";
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		'<meta name="referrer" content="no-referrer">',
		'<base target="_blank">',
		`<style>${BASE_STYLES}${colorStyles}${muted}</style>`,
		"</head><body>",
		html,
		"</body></html>",
	].join("");
}

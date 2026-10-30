import { readerFontStyles } from "@/components/font-assets-utils";
import type { EmailColourFacts, EmailFrameDocumentOptions } from "./email-html-frame-types";

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
const INVERTED_STYLES = [
	"html{background:#f2f2f0;filter:invert(.92) hue-rotate(180deg)}",
	"body{padding:12px}",
	'img,video,picture,svg,iframe,[background],[style*="background-image"],[style*="background:url"],[style*="background: url"]{filter:invert(1) hue-rotate(180deg)}',
].join("");

// What dark mode does with mail that brings its own colours depends on the colours themselves, which the
// reader's sanitizer reads from each element's parsed inline style (EmailColourFacts):
//  1. A background, or a text colour that stays unreadable on the dark canvas (a #1F497D signature): the mail is
//     rendered light and inverted.
//  2. Otherwise near-black text (Outlook's `color:black`, Gmail's `#222`), which the sanitizer marked
//     `data-kite-text="neutral"`, takes the theme's text colour, so an ordinary reply looks like plain mail.
//  3. Colours that read fine on dark (light text) are left alone.
// "Original colours" shows the sender's markup on a light canvas whenever 1 or 2 changed something.
const THEME_TEXT = "#e8eaed";
const THEME_LINK = "#8ab4f8";
const THEME_MUTED = "#9aa0a6";
const NEUTRAL_TEXT = "[data-kite-text=neutral]";

function neutralTextStyles(muted: boolean): string {
	return (
		`${NEUTRAL_TEXT}{color:${muted ? THEME_MUTED : THEME_TEXT}!important}` +
		`blockquote ${NEUTRAL_TEXT}{color:${THEME_MUTED}!important}` +
		`a${NEUTRAL_TEXT},a ${NEUTRAL_TEXT}{color:${THEME_LINK}!important}`
	);
}

/** Whether dark mode changes this mail's colours, so "Original colours" has something to show. */
export function emailColoursAdapted(colours: EmailColourFacts | undefined): boolean {
	return !!colours && (colours.background || colours.unreadable || colours.neutral);
}

type FrameRendering = { scheme: "dark" | "light"; inverted: boolean };

function frameRendering(options: EmailFrameDocumentOptions): FrameRendering {
	if (!options.dark) return { scheme: "light", inverted: false };
	const adapted = emailColoursAdapted(options.colours);
	if (options.original) return { scheme: adapted ? "light" : "dark", inverted: false };
	const inverted = !!options.colours && (options.colours.background || options.colours.unreadable);
	return inverted ? { scheme: "light", inverted: true } : { scheme: "dark", inverted: false };
}

/**
 * The color-scheme the frame document declares. The `<iframe>` element has to declare the same one:
 * when they differ, Chromium paints an opaque canvas (#121212 for dark) behind the mail.
 */
export function emailFrameColorScheme(options: EmailFrameDocumentOptions = {}): "dark" | "light" {
	return frameRendering(options).scheme;
}

export function buildEmailFrameDocument(html: string, options: EmailFrameDocumentOptions = {}): string {
	const { scheme, inverted } = frameRendering(options);
	const dark = scheme === "dark";
	const lightCanvas = !!options.dark && !dark && !inverted;
	const colorStyles =
		(dark ? DARK_STYLES : LIGHT_STYLES) +
		(inverted ? INVERTED_STYLES : "") +
		(lightCanvas ? "html{background:#fff}body{padding:12px}" : "");
	const muted = options.muted ? (dark ? `body{color:${THEME_MUTED}}` : "body{color:#525252}") : "";
	const neutral = dark && options.dark && options.colours?.neutral ? neutralTextStyles(!!options.muted) : "";
	// The font's stylesheet is same-origin (CSP font-src 'self'); the frame has no scripts to add it. The mail's
	// inline font-family declarations were left out by the sanitizer (`dropFontFamily`), never edited here.
	const font = options.font
		? `<link rel="stylesheet" href="${options.font.stylesheet}"><style>${readerFontStyles(options.font)}</style>`
		: "";
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		'<meta name="referrer" content="no-referrer">',
		'<base target="_blank">',
		`<style>${BASE_STYLES}${colorStyles}${muted}${neutral}</style>`,
		font,
		"</head><body>",
		html,
		"</body></html>",
	].join("");
}

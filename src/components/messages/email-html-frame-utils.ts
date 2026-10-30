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

// The reader's sanitizer drops `bgcolor` and keeps only `background-color`, so plenty of mail arrives with
// inline text colours and no background. What dark mode does with it depends on the colours themselves:
//  1. Near-black greys (Outlook writes `color:black` on nearly every block, Gmail signatures `#222`) are only
//     dropped, so the text takes the theme colour and the reply looks like plain mail.
//  2. Any other colour that is still unreadable on the dark canvas (a #1F497D signature) means the mail is
//     rendered light and inverted, like mail with a background.
//  3. Colours that read fine on dark (white or light text) are left alone.
// Only style attribute values count: the words "color: blue" in a message's text are not a text colour.
const STYLE_ATTRIBUTE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const TEXT_COLOUR_DECLARATION = /(^|;)(\s*color\s*:\s*)([^;]+)/gi;

type Rgb = [number, number, number];

const NAMED_COLOURS: Record<string, Rgb> = {
	black: [0, 0, 0],
	windowtext: [0, 0, 0],
	canvastext: [0, 0, 0],
	white: [255, 255, 255],
	gray: [128, 128, 128],
	grey: [128, 128, 128],
	silver: [192, 192, 192],
	maroon: [128, 0, 0],
	red: [255, 0, 0],
	purple: [128, 0, 128],
	green: [0, 128, 0],
	olive: [128, 128, 0],
	navy: [0, 0, 128],
	blue: [0, 0, 255],
	teal: [0, 128, 128],
	darkblue: [0, 0, 139],
	darkred: [139, 0, 0],
	darkgreen: [0, 100, 0],
};
const COLOUR_FUNCTION =
	/^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/;

/** The colour as RGB, or null for anything that is not plainly one (var(), hsl(), inherit, ...). */
function parseColour(value: string): Rgb | null {
	const text = value
		.trim()
		.toLowerCase()
		.replace(/\s*!important$/, "");
	if (NAMED_COLOURS[text]) return NAMED_COLOURS[text];
	const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
	if (hex && [3, 4, 6, 8].includes(hex.length)) {
		const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
		return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16)) as Rgb;
	}
	const fn = COLOUR_FUNCTION.exec(text);
	return fn ? ([1, 2, 3].map((index) => Math.min(255, Number(fn[index]))) as Rgb) : null;
}

function relativeLuminance([r, g, b]: Rgb): number {
	const [lr, lg, lb] = [r, g, b].map((value) => {
		const unit = value / 255;
		return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** The lightest dark canvas the frame sits on (#292a2d in the classic dark theme), with a little headroom. */
const DARK_CANVAS_LUMINANCE = relativeLuminance([0x2c, 0x2c, 0x30]);
/** Below this contrast against the dark canvas a colour counts as unreadable (WCAG's floor for large text). */
const UNREADABLE_CONTRAST = 3;
/** Black through about #333 with little saturation: what mail writes as "default text". */
const NEAR_BLACK_CHANNEL = 0x38;
const NEAR_BLACK_SPREAD = 24;

function isNearBlackNeutral([r, g, b]: Rgb): boolean {
	return Math.max(r, g, b) <= NEAR_BLACK_CHANNEL && Math.max(r, g, b) - Math.min(r, g, b) <= NEAR_BLACK_SPREAD;
}

function isUnreadableOnDark(colour: Rgb): boolean {
	return (relativeLuminance(colour) + 0.05) / (DARK_CANVAS_LUMINANCE + 0.05) < UNREADABLE_CONTRAST;
}

type EmailColourAnalysis = {
	/** Rendered light and inverted in dark mode: it has a background, or a colour that stays unreadable. */
	invert: boolean;
	/** Dark mode changes it, so the reader offers "Original colours". */
	adapted: boolean;
	/** Near-black text colours that are dropped in dark mode when the mail is not inverted. */
	dropsNeutral: boolean;
};

const ANALYSIS_CACHE_SIZE = 64;
const analysisCache = new Map<string, EmailColourAnalysis>();

/** One scan per message body (a frame asks several times per render), remembered for the last few. */
function analyseEmailColours(html: string): EmailColourAnalysis {
	const known = analysisCache.get(html);
	if (known) return known;
	let unreadable = false;
	let neutral = false;
	for (const [, double, single] of html.matchAll(STYLE_ATTRIBUTE)) {
		for (const [, , , value] of (double ?? single ?? "").matchAll(TEXT_COLOUR_DECLARATION)) {
			const colour = parseColour(value);
			if (!colour) continue;
			if (isNearBlackNeutral(colour)) neutral = true;
			else if (isUnreadableOnDark(colour)) unreadable = true;
		}
	}
	const invert = unreadable || OWN_BACKGROUND.test(html);
	const analysis = { invert, adapted: invert || neutral, dropsNeutral: neutral };
	if (analysisCache.size >= ANALYSIS_CACHE_SIZE) analysisCache.delete(analysisCache.keys().next().value!);
	analysisCache.set(html, analysis);
	return analysis;
}

/** Whether dark mode changes this mail's colours, so "Original colours" has something to show. */
export function adaptsEmailColours(html: string): boolean {
	return analyseEmailColours(html).adapted;
}

function dropNearBlackText(html: string): string {
	return html.replace(STYLE_ATTRIBUTE, (attribute, double?: string, single?: string) => {
		const style = (double ?? single ?? "").replace(TEXT_COLOUR_DECLARATION, (declaration, start, _name, value) => {
			const colour = parseColour(value);
			return colour && isNearBlackNeutral(colour) ? start : declaration;
		});
		return `style=${double === undefined ? "'" : '"'}${style}${double === undefined ? "'" : '"'}`;
	});
}

type FrameRendering = { scheme: "dark" | "light"; inverted: boolean };

function frameRendering(html: string, options: EmailFrameDocumentOptions): FrameRendering {
	if (!options.dark) return { scheme: "light", inverted: false };
	const { invert, adapted } = analyseEmailColours(html);
	if (options.original) return { scheme: adapted ? "light" : "dark", inverted: false };
	return invert ? { scheme: "light", inverted: true } : { scheme: "dark", inverted: false };
}

/**
 * The color-scheme the frame document declares. The `<iframe>` element has to declare the same one:
 * when they differ, Chromium paints an opaque canvas (#121212 for dark) behind the mail.
 */
export function emailFrameColorScheme(html: string, options: EmailFrameDocumentOptions = {}): "dark" | "light" {
	return frameRendering(html, options).scheme;
}

export function buildEmailFrameDocument(html: string, options: EmailFrameDocumentOptions = {}): string {
	const { scheme, inverted } = frameRendering(html, options);
	const dark = scheme === "dark";
	const lightCanvas = !!options.dark && !dark && !inverted;
	const colorStyles =
		(dark ? DARK_STYLES : LIGHT_STYLES) +
		(inverted ? INVERTED_STYLES : "") +
		(lightCanvas ? "html{background:#fff}body{padding:12px}" : "");
	const muted = options.muted ? (dark ? "body{color:#9aa0a6}" : "body{color:#525252}") : "";
	const body = dark && options.dark && analyseEmailColours(html).dropsNeutral ? dropNearBlackText(html) : html;
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		'<meta name="referrer" content="no-referrer">',
		'<base target="_blank">',
		`<style>${BASE_STYLES}${colorStyles}${muted}</style>`,
		"</head><body>",
		body,
		"</body></html>",
	].join("");
}

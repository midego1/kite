// Colour rules for dark mode, applied by the reader's sanitizer to each element's parsed inline style (never to
// the serialized markup, where text could pass for an attribute). See email-html-frame-utils.ts for what the
// frame does with the result.

import type { EmailColourFacts } from "./email-html-frame-types";

type Rgb = [number, number, number];

/** A fresh set of findings for one sanitizer call to fill in. */
export function emptyEmailColours(): EmailColourFacts {
	return { background: false, unreadable: false, neutral: false };
}

/** The 148 CSS named colours, as `name hex` pairs. */
const NAMED =
	"aliceblue f0f8ff;antiquewhite faebd7;aqua 00ffff;aquamarine 7fffd4;azure f0ffff;beige f5f5dc;bisque ffe4c4;black 000000;blanchedalmond ffebcd;blue 0000ff;blueviolet 8a2be2;brown a52a2a;burlywood deb887;cadetblue 5f9ea0;chartreuse 7fff00;chocolate d2691e;coral ff7f50;cornflowerblue 6495ed;cornsilk fff8dc;crimson dc143c;cyan 00ffff;darkblue 00008b;darkcyan 008b8b;darkgoldenrod b8860b;darkgray a9a9a9;darkgreen 006400;darkgrey a9a9a9;darkkhaki bdb76b;darkmagenta 8b008b;darkolivegreen 556b2f;darkorange ff8c00;darkorchid 9932cc;darkred 8b0000;darksalmon e9967a;darkseagreen 8fbc8f;darkslateblue 483d8b;darkslategray 2f4f4f;darkslategrey 2f4f4f;darkturquoise 00ced1;darkviolet 9400d3;deeppink ff1493;deepskyblue 00bfff;dimgray 696969;dimgrey 696969;dodgerblue 1e90ff;firebrick b22222;floralwhite fffaf0;forestgreen 228b22;fuchsia ff00ff;gainsboro dcdcdc;ghostwhite f8f8ff;gold ffd700;goldenrod daa520;gray 808080;green 008000;greenyellow adff2f;grey 808080;honeydew f0fff0;hotpink ff69b4;indianred cd5c5c;indigo 4b0082;ivory fffff0;khaki f0e68c;lavender e6e6fa;lavenderblush fff0f5;lawngreen 7cfc00;lemonchiffon fffacd;lightblue add8e6;lightcoral f08080;lightcyan e0ffff;lightgoldenrodyellow fafad2;lightgray d3d3d3;lightgreen 90ee90;lightgrey d3d3d3;lightpink ffb6c1;lightsalmon ffa07a;lightseagreen 20b2aa;lightskyblue 87cefa;lightslategray 778899;lightslategrey 778899;lightsteelblue b0c4de;lightyellow ffffe0;lime 00ff00;limegreen 32cd32;linen faf0e6;magenta ff00ff;maroon 800000;mediumaquamarine 66cdaa;mediumblue 0000cd;mediumorchid ba55d3;mediumpurple 9370db;mediumseagreen 3cb371;mediumslateblue 7b68ee;mediumspringgreen 00fa9a;mediumturquoise 48d1cc;mediumvioletred c71585;midnightblue 191970;mintcream f5fffa;mistyrose ffe4e1;moccasin ffe4b5;navajowhite ffdead;navy 000080;oldlace fdf5e6;olive 808000;olivedrab 6b8e23;orange ffa500;orangered ff4500;orchid da70d6;palegoldenrod eee8aa;palegreen 98fb98;paleturquoise afeeee;palevioletred db7093;papayawhip ffefd5;peachpuff ffdab9;peru cd853f;pink ffc0cb;plum dda0dd;powderblue b0e0e6;purple 800080;rebeccapurple 663399;red ff0000;rosybrown bc8f8f;royalblue 4169e1;saddlebrown 8b4513;salmon fa8072;sandybrown f4a460;seagreen 2e8b57;seashell fff5ee;sienna a0522d;silver c0c0c0;skyblue 87ceeb;slateblue 6a5acd;slategray 708090;slategrey 708090;snow fffafa;springgreen 00ff7f;steelblue 4682b4;tan d2b48c;teal 008080;thistle d8bfd8;tomato ff6347;turquoise 40e0d0;violet ee82ee;wheat f5deb3;white ffffff;whitesmoke f5f5f5;yellow ffff00;yellowgreen 9acd32";
/** System colours Outlook writes for its default text. */
const SYSTEM = "windowtext 000000;canvastext 000000";

const NAMED_COLOURS = new Map<string, Rgb>(
	`${NAMED};${SYSTEM}`.split(";").map((entry) => {
		const [name, hex] = entry.split(" ");
		return [name, [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16)) as Rgb];
	}),
);

const COLOUR_FUNCTION =
	/^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/;

/** The colour (RGB and alpha), or null for anything that is not plainly one (var(), hsl(), inherit, ...). */
export function parseCssColour(value: string): { rgb: Rgb; alpha: number } | null {
	const text = value
		.trim()
		.toLowerCase()
		.replace(/\s*!important$/, "");
	const named = NAMED_COLOURS.get(text);
	if (named) return { rgb: named, alpha: 1 };
	if (text === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
	const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
	if (hex && [3, 4, 6, 8].includes(hex.length)) {
		const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
		const [r, g, b, a] = [0, 2, 4, 6].map((index) => parseInt(full.slice(index, index + 2), 16));
		return { rgb: [r, g, b], alpha: full.length === 8 ? a / 255 : 1 };
	}
	const fn = COLOUR_FUNCTION.exec(text);
	if (!fn) return null;
	const alpha = fn[4] === undefined ? 1 : fn[4].endsWith("%") ? parseFloat(fn[4]) / 100 : Number(fn[4]);
	return { rgb: [1, 2, 3].map((index) => Math.min(255, Number(fn[index]))) as Rgb, alpha };
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

export function isNearBlackNeutral([r, g, b]: Rgb): boolean {
	return Math.max(r, g, b) <= NEAR_BLACK_CHANNEL && Math.max(r, g, b) - Math.min(r, g, b) <= NEAR_BLACK_SPREAD;
}

export function isUnreadableOnDark(colour: Rgb): boolean {
	return (relativeLuminance(colour) + 0.05) / (DARK_CANVAS_LUMINANCE + 0.05) < UNREADABLE_CONTRAST;
}

/** Colours fainter than this are decoration or hidden text (preheaders, spacers), not something to adapt or reveal. */
export const MIN_VISIBLE_ALPHA = 0.4;

/** True when a `background-color` value paints something (not faint, transparent, none or an inherited keyword). */
export function paintsBackground(value: string): boolean {
	const text = value.trim().toLowerCase();
	if (!text || /^(?:none|inherit|initial|unset|currentcolor)$/.test(text)) return false;
	const colour = parseCssColour(text);
	return !colour || colour.alpha >= MIN_VISIBLE_ALPHA;
}

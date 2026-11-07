import type PostalMime from "postal-mime";

type TextType = "plain" | "html";
type TextEntry = Partial<Record<TextType, { value: unknown }[]>>;
/** The parts of postal-mime that hold a message's text parts until they are joined into its bodies. */
type BodyRenderer = { textMap: Map<unknown, TextEntry>; textTypes: Set<TextType>; renderTextContent(): void };
/** A MIME part as postal-mime holds it, with its decoded bytes once it is read. */
type MimePart = {
	contentType: { multipart: string | false; parsed: { value: string; params: Record<string, unknown> } };
	content: ArrayBuffer | null;
};
/**
 * The parts of postal-mime that read a message's text parts out of the tree. A text part is filed in `textMap` under
 * its closest `multipart/alternative`, or else under itself.
 */
type PartCollector = {
	collectNode(node: MimePart, alternative: unknown, ...rest: unknown[]): Promise<void>;
	isInlineTextNode(node: MimePart): boolean;
};

/**
 * What `limitBodyConversion` allows: `conversionCost` of every text part that is rendered in the other format too,
 * together. A text part beside an HTML part outside `multipart/alternative` is converted to HTML and the HTML to text,
 * and both end up in memory beside the sanitizer's input and output. 6 million fits a 56 MB heap, with margin for what
 * the costs below only approximate: a plain text part up to its `MAX_DECODED_TEXT_BYTES` with few characters that get
 * replaced, or about 2 MB of HTML with spaces between its words and few entities, and less with a character above
 * Latin-1.
 */
const MAX_BODY_CONVERSION_COST = 6_000_000;
/** What a conversion replaces costs a heap node or two each until the result is flattened. */
const REPLACEMENT_COST = 8;
const costs = (characters: string, cost: number) =>
	Array.from(characters, (character): [number, number] => [character.charCodeAt(0), cost]);
const TEXT_COSTS = new Map(costs("<>\"'?&\n", REPLACEMENT_COST));
/**
 * HTML going to text also has its line ends replaced, including the U+0001 that stands in for them on the way, and
 * each run of spaces and tabs. An entity is read by a function per match, which holds about three times as much.
 */
const HTML_COSTS = new Map([
	...TEXT_COSTS,
	...costs("\r\u2028\u2029\u0001", REPLACEMENT_COST),
	...costs("&", 3 * REPLACEMENT_COST),
]);
const SPACE = 32;
const TAB = 9;

/** The highest character a string can hold at one byte each; one character above it makes every copy two bytes each. */
const LATIN1_MAX = 0xff;

/** The size of a text part with what gets replaced on the way to the other format. */
function conversionCost(text: string, type: TextType): number {
	const characterCosts = type === "html" ? HTML_COSTS : TEXT_COSTS;
	let cost = 0;
	let wide = false;
	let inRun = false;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		const blank = code === SPACE || code === TAB;
		cost += characterCosts.get(code) ?? 0;
		if (type === "html" && blank && !inRun) cost += REPLACEMENT_COST;
		if (code > LATIN1_MAX) wide = true;
		inRun = blank;
	}
	return cost + text.length * (wide ? 2 : 1);
}

function totalConversionCost(textMap: BodyRenderer["textMap"]): number {
	let cost = 0;
	for (const entry of textMap.values()) {
		if (entry.plain && entry.html) continue;
		const type = entry.plain ? "plain" : "html";
		for (const { value } of entry[type] ?? []) {
			if (typeof value === "string") cost += conversionCost(value, type);
		}
	}
	return cost;
}

function withoutConversion(textMap: BodyRenderer["textMap"]): TextEntry {
	const merged: TextEntry = { plain: [], html: [] };
	for (const entry of textMap.values()) {
		merged.plain?.push(...(entry.plain ?? []));
		merged.html?.push(...(entry.html ?? []));
	}
	return merged;
}

/** The `textMap` entries whose parts were also rendered into the body of the other format. */
export type BodyConversion = Set<unknown>;

/**
 * Keeps the text bodies of `parser` from being converted when that would cost more than `MAX_BODY_CONVERSION_COST`:
 * the plain text parts then only make the text body and the HTML parts only the HTML body. Each still reads as
 * written and the raw message keeps everything. A body in one format is never converted, nor is `multipart/alternative`.
 */
export function limitBodyConversion(parser: PostalMime): BodyConversion {
	const renderer = parser as unknown as BodyRenderer;
	const render = renderer.renderTextContent.bind(renderer);
	const converted: BodyConversion = new Set();
	renderer.renderTextContent = () => {
		if (renderer.textTypes.size > 1 && totalConversionCost(renderer.textMap) > MAX_BODY_CONVERSION_COST) {
			const merged = withoutConversion(renderer.textMap);
			renderer.textMap.clear();
			renderer.textMap.set(merged, merged);
		}
		if (renderer.textTypes.size > 1) {
			for (const [key, entry] of renderer.textMap) {
				if (!entry.html || !entry.plain) converted.add(key);
			}
		}
		render();
	};
	return converted;
}

/**
 * Decoded bytes of the text parts and of the HTML parts of a message, each format together, that `limitDecodedText`
 * lets postal-mime turn into strings. A string takes two bytes per character as soon as one character is outside
 * Latin-1, and decoding, line-end normalization, the sanitizer and conversion each hold a copy of it for a while: 24 MB
 * of such HTML needed about 120 MB of heap. At these sizes every body shape measured fits a 48 MB heap, leaving a
 * Worker's 128 MB room for the raw message and its decoded parts. Delivery stores at most 450 KB of the text body
 * anyway (`inbound-limits.ts`), and 4 MiB of HTML is far more than a reader scrolls through.
 *
 * @public Exercised by the unit tests.
 */
export const MAX_DECODED_TEXT_BYTES: Readonly<Record<TextType, number>> = {
	plain: 2 * 1024 * 1024,
	html: 4 * 1024 * 1024,
};
/** How far back from the limit a cut looks for a line end before it settles for a character boundary. */
const CUT_LINE_WINDOW = 64 * 1024;
const LINE_FEED = 10;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;

/**
 * Where to cut `bytes` to keep at most `max` of them: after the last line end in the final `CUT_LINE_WINDOW`, or else
 * at `max`. In a part that may be UTF-8 (`utf8`) that moves back before a lead byte, so the part still decodes as UTF-8
 * and not as windows-1252; any other charset loses at most the one character the cut goes through.
 *
 * @public Exercised by the unit tests.
 */
export function decodedTextCut(bytes: Uint8Array, max: number, utf8 = true): number {
	if (bytes.length <= max) return bytes.length;
	if (max <= 0) return 0;
	const lineEnd = bytes.lastIndexOf(LINE_FEED, max - 1);
	if (lineEnd >= 0 && lineEnd >= max - CUT_LINE_WINDOW) return lineEnd + 1;
	let cut = max;
	if (!utf8) return cut;
	for (let step = 0; step < 3 && cut > 0 && (bytes[cut] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION; step += 1) {
		cut -= 1;
	}
	return cut;
}

/** Per format, the `textMap` entries holding a part that `limitDecodedText` cut or left out. */
export type DecodedTextCut = Record<TextType, Set<unknown>>;

/** A charset label that names UTF-8, or none: an unlabelled part is read as UTF-8 when it is well formed. */
const MAYBE_UTF8 = /^(?:utf-?8|unicode-1-1-utf-8)?$/i;

/**
 * Keeps the text parts and the HTML parts of `parser` within `MAX_DECODED_TEXT_BYTES` of decoded bytes per format,
 * cutting the part that goes over and leaving out the ones after it before postal-mime decodes them into strings. The
 * raw message keeps everything.
 */
export function limitDecodedText(
	parser: PostalMime,
	max: Readonly<Record<TextType, number>> = MAX_DECODED_TEXT_BYTES,
): DecodedTextCut {
	const collector = parser as unknown as PartCollector;
	const collect = collector.collectNode.bind(collector);
	const cut: DecodedTextCut = { plain: new Set(), html: new Set() };
	const left = { ...max };
	// postal-mime walks the tree through `this.collectNode`, so every part comes through here.
	collector.collectNode = (node, alternative, ...rest) => {
		const { content } = node;
		if (!node.contentType.multipart && content && collector.isInlineTextNode(node)) {
			const { value, params } = node.contentType.parsed;
			const type = value === "text/html" ? "html" : "plain";
			const charset = typeof params.charset === "string" ? params.charset.trim() : "";
			const kept = decodedTextCut(new Uint8Array(content), left[type], MAYBE_UTF8.test(charset));
			if (kept < content.byteLength) {
				node.content = content.slice(0, kept);
				cut[type].add(alternative || node);
			}
			// Once a part is cut, later parts of its format are left out whole rather than read past a gap.
			left[type] = cut[type].size ? 0 : left[type] - kept;
		}
		return collect(node, alternative, ...rest);
	};
	return cut;
}

/** Which bodies hold a part that was cut: a body holds the parts of its own format, and those converted into it. */
export function cutBodies(cut: DecodedTextCut, converted: BodyConversion): Record<TextType, boolean> {
	const convertedCut = (keys: Set<unknown>) => [...keys].some((key) => converted.has(key));
	return {
		plain: cut.plain.size > 0 || convertedCut(cut.html),
		html: cut.html.size > 0 || convertedCut(cut.plain),
	};
}

/** Said at the end of a body Kite keeps only the start of; the raw message in the Mail store holds all of it. */
const BODY_CUT_NOTE =
	"This message is longer than Kite shows. The rest is in the original message: use Show original to download it.";

/** How a text body ends with the note. ASCII, so its length is its size in UTF-8 bytes. */
export const TEXT_CUT_NOTE = `\n\n[${BODY_CUT_NOTE}]`;

/** `html` with the note at its end, inside the one element that carries the root direction when there is one. */
export function withHtmlCutNote(html: string): string {
	const note = `<hr><p>${BODY_CUT_NOTE}</p>`;
	const wrapped = /^<div dir="(?:ltr|rtl)">/.test(html) && html.endsWith("</div>");
	return wrapped ? `${html.slice(0, -"</div>".length)}${note}</div>` : `${html}${note}`;
}

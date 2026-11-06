import type PostalMime from "postal-mime";

type TextType = "plain" | "html";
type TextEntry = Partial<Record<TextType, { value: unknown }[]>>;
/** The parts of postal-mime that hold a message's text parts until they are joined into its bodies. */
type BodyRenderer = { textMap: Map<unknown, TextEntry>; textTypes: Set<TextType>; renderTextContent(): void };

/**
 * What `limitBodyConversion` allows: `conversionCost` of every text part that is rendered in the other format too,
 * together. A text part beside an HTML part outside `multipart/alternative` is converted to HTML and the HTML to text,
 * and both end up in memory beside the sanitizer's input and output. 16 million leaves room in a 128 MB heap for the
 * raw message: about 12 MB of plain text, or 6 MB of HTML with spaces between its words.
 */
const MAX_BODY_CONVERSION_COST = 16_000_000;
/** What a conversion replaces costs a heap node or two each until the result is flattened. */
const REPLACEMENT_COST = 8;
const REPLACED_CHARACTERS = new Set(Array.from("<>\"'?&\n", (character) => character.charCodeAt(0)));
/** HTML going to text also has its line ends replaced, and each run of spaces and tabs. */
const REPLACED_IN_HTML = new Set(Array.from("\r\u2028\u2029", (character) => character.charCodeAt(0)));
const SPACE = 32;
const TAB = 9;

/** The size of a text part with what gets replaced on the way to the other format. */
function conversionCost(text: string, type: TextType): number {
	let cost = text.length;
	let inRun = false;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		const blank = code === SPACE || code === TAB;
		const replaced =
			REPLACED_CHARACTERS.has(code) || (type === "html" && (REPLACED_IN_HTML.has(code) || (blank && !inRun)));
		if (replaced) cost += REPLACEMENT_COST;
		inRun = blank;
	}
	return cost;
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

/**
 * Keeps the text bodies of `parser` from being converted when that would cost more than `MAX_BODY_CONVERSION_COST`:
 * the plain text parts then only make the text body and the HTML parts only the HTML body. Each still reads as
 * written and the raw message keeps everything. A body in one format is never converted, nor is `multipart/alternative`.
 */
export function limitBodyConversion(parser: PostalMime): void {
	const renderer = parser as unknown as BodyRenderer;
	const render = renderer.renderTextContent.bind(renderer);
	renderer.renderTextContent = () => {
		if (renderer.textTypes.size > 1 && totalConversionCost(renderer.textMap) > MAX_BODY_CONVERSION_COST) {
			const merged = withoutConversion(renderer.textMap);
			renderer.textMap.clear();
			renderer.textMap.set(merged, merged);
		}
		render();
	};
}

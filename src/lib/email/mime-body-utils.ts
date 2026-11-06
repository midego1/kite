import type PostalMime from "postal-mime";

type TextType = "plain" | "html";
type TextEntry = Partial<Record<TextType, { value: unknown }[]>>;
/** The parts of postal-mime that hold a message's text parts until they are joined into its bodies. */
type BodyRenderer = { textMap: Map<unknown, TextEntry>; textTypes: Set<TextType>; renderTextContent(): void };

/**
 * What `limitBodyConversion` allows: `conversionCost` of every text part that is rendered in the other format too,
 * together. A text part beside an HTML part outside `multipart/alternative` is converted to HTML and the HTML to text,
 * and both end up in memory beside the sanitizer's input and output. 12 million leaves room in a 128 MB heap for the
 * raw message, with margin for what the costs below only approximate: about 11 MB of plain text, or 5 MB of HTML with
 * spaces between its words and few entities.
 */
const MAX_BODY_CONVERSION_COST = 12_000_000;
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

/** The size of a text part with what gets replaced on the way to the other format. */
function conversionCost(text: string, type: TextType): number {
	const characterCosts = type === "html" ? HTML_COSTS : TEXT_COSTS;
	let cost = text.length;
	let inRun = false;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		const blank = code === SPACE || code === TAB;
		cost += characterCosts.get(code) ?? 0;
		if (type === "html" && blank && !inRun) cost += REPLACEMENT_COST;
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

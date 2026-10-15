const CONTROL_CHARS = /\p{Cc}/gu;
/** Bidi marks, embeddings, overrides and isolates: invisible, and able to reorder the text around them. */
const BIDI_CHARS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * One line of module-supplied display text: bidi characters removed, controls and runs of whitespace
 * collapsed to one space, at most `maxChars` code points (the last one an ellipsis when cut).
 * Undefined when nothing printable is left.
 */
export function cleanDisplayText(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const chars = Array.from(value.replace(BIDI_CHARS, "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim());
	if (chars.length === 0) return undefined;
	return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("")}…` : chars.join("");
}

const ROOT_DIRECTIONS = new Set(["ltr", "rtl", "auto"]);
const WRAPPER = /^\s*<div dir="(ltr|rtl)">/;

/**
 * The text direction a mail declares on its `<html>` or `<body>` tag: the exact values `ltr`, `rtl` and `auto`
 * (case-insensitive), the body's winning over the html element's. Anything else, such as a value with spaces or an
 * attribute that is missing, counts as not declared.
 */
export function rootDirection(
	bodyDirection: string | null | undefined,
	htmlDirection: string | null | undefined,
): "ltr" | "rtl" | "auto" | null {
	for (const value of [bodyDirection, htmlDirection]) {
		const direction = value?.toLowerCase();
		if (direction && ROOT_DIRECTIONS.has(direction)) return direction as "ltr" | "rtl" | "auto";
	}
	return null;
}

/**
 * The sanitized body inside one element that carries the root direction, because the `<html>` and `<body>` tags
 * themselves never survive sanitizing. Nothing else from those tags is kept. `auto` needs no element (the reader's
 * frame already detects the direction), and an empty body stays empty so the reader falls back to the text part.
 */
export function withRootDirection(html: string, direction: "ltr" | "rtl" | "auto" | null): string {
	if (!direction || direction === "auto" || !html.trim()) return html;
	return `<div dir="${direction}">${html}</div>`;
}

/**
 * The direction of the one wrapper `withRootDirection` adds, when `html` is exactly that wrapper around everything,
 * so the reader's frame can give it to its `<body>`: a body that detects its direction ignores a child with its own
 * `dir`, which would leave the viewport left to right and part of a wide right-to-left mail out of reach.
 * Sanitized markup only: tags are lower case and text never holds a `<`.
 */
export function wrappedRootDirection(html: string): "ltr" | "rtl" | null {
	const opening = WRAPPER.exec(html);
	if (!opening) return null;
	let depth = 0;
	const tags = /<(\/?)div\b[^>]*>/g;
	tags.lastIndex = opening.index;
	for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
		depth += tag[1] ? -1 : 1;
		if (depth === 0) return html.slice(tag.index + tag[0].length).trim() === "" ? (opening[1] as "ltr" | "rtl") : null;
	}
	return null;
}

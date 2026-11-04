const ROOT_DIRECTIONS = new Set(["ltr", "rtl", "auto"]);

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
 * themselves never survive sanitizing. Nothing else from those tags is kept.
 */
export function withRootDirection(html: string, direction: "ltr" | "rtl" | "auto" | null): string {
	return direction ? `<div dir="${direction}">${html}</div>` : html;
}

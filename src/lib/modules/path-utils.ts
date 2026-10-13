/** A path on this site: one leading slash, no scheme, no `//` or `/\` host form, no control characters. */
export function isSameOriginPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value[0] !== "/") return false;
	if (value[1] === "/" || value[1] === "\\") return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

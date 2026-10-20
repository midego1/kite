/** Decodes one RFC 6901 reference token: `~1` before `~0`, so `~01` becomes `~1` rather than `/`. */
export function unescapePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

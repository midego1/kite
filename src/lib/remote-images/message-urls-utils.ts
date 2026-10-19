import { Parser } from "htmlparser2";

function normalizeUrl(value: string, base: string): string | null {
	try {
		return new URL(value, base).href;
	} catch {
		return null;
	}
}

/**
 * Whether the stored HTML of a message has an `<img src>` naming `url`. The proxy fetches only
 * such URLs, so it cannot be used to fetch an arbitrary address. Both sides are resolved against
 * the app's origin the way the reader resolves them, so `//host/a.png`, entities and
 * surrounding whitespace compare equal.
 */
export function messageHtmlReferencesImage(html: string | null | undefined, url: string, base: string): boolean {
	if (!html) return false;
	const target = normalizeUrl(url, base);
	if (!target) return false;
	let found = false;
	const parser = new Parser(
		{
			onopentag(name, attributes) {
				if (found || name !== "img" || attributes.src === undefined) return;
				if (normalizeUrl(attributes.src, base) === target) found = true;
			},
		},
		{ decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
	);
	parser.write(html);
	parser.end();
	return found;
}

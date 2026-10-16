import { Parser } from "htmlparser2";

/** Decode HTML URL sources once, in their attribute or text context, without changing plain-text mail. */
export function htmlLinkText(html: string): string {
	const parts: string[] = [];
	const parser = new Parser(
		{
			onopentag(_name, attributes) {
				parts.push("\n", Object.values(attributes).join("\n"), "\n");
			},
			onclosetag() {
				parts.push("\n");
			},
			ontext(text) {
				parts.push(text);
			},
		},
		{ decodeEntities: true },
	);
	parser.end(html.slice(0, 250_000));
	return parts.join("");
}

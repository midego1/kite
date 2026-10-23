import { Parser } from "htmlparser2";
import { linkTextMismatch } from "./link-host-utils";

/**
 * Whether an anchor's visible address (a URL or a bare hostname) names a different site than its
 * destination, without parsing more than the URL scan limit.
 */
export function hasDisplayedLinkMismatch(html: string): boolean {
	let href: string | undefined;
	let text = "";
	let mismatch = false;
	const parser = new Parser(
		{
			onopentag(name, attributes) {
				if (name === "a") {
					href = attributes.href;
					text = "";
				}
			},
			ontext(value) {
				if (href !== undefined) text += value;
			},
			onclosetag(name) {
				if (name !== "a") return;
				if (href && linkTextMismatch(href, text)) mismatch = true;
				href = undefined;
				text = "";
			},
		},
		{ decodeEntities: true },
	);
	parser.end(html.slice(0, 250_000));
	return mismatch;
}

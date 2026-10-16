import { Parser } from "htmlparser2";

/** Compare decoded anchor destinations and visible addresses, without parsing more than the URL scan limit. */
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
				const displayed = text.trim();
				if (href && /^https?:\/\//i.test(href) && /^https?:\/\/\S+$/i.test(displayed)) {
					try {
						const targetDomain = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
						const displayedDomain = new URL(displayed).hostname.toLowerCase().replace(/^www\./, "");
						if (targetDomain !== displayedDomain) mismatch = true;
					} catch {}
				}
				href = undefined;
				text = "";
			},
		},
		{ decodeEntities: true },
	);
	parser.end(html.slice(0, 250_000));
	return mismatch;
}

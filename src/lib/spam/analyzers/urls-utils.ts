import { Parser } from "htmlparser2";
import { linkVerdict, type LinkVerdict } from "./link-host-utils";

/**
 * The worst thing the anchors' visible addresses (a URL or a bare hostname) say about their destinations,
 * without parsing more than the URL scan limit: `mismatch` when one names a different site than its
 * destination, else `sender_tracked` when one is the authenticated sender's own tracked link (`senderDomain`,
 * see `linkVerdict`), else null.
 */
export function displayedLinkFinding(html: string, senderDomain?: string | null): Exclude<LinkVerdict, "ok"> | null {
	let href: string | undefined;
	let text = "";
	let finding: Exclude<LinkVerdict, "ok"> | null = null;
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
				const verdict = href ? linkVerdict(href, text, senderDomain) : "ok";
				if (verdict === "mismatch" || (verdict === "sender_tracked" && finding === null)) finding = verdict;
				href = undefined;
				text = "";
			},
		},
		{ decodeEntities: true },
	);
	parser.end(html.slice(0, 250_000));
	return finding;
}

/** Whether an anchor's visible address names a different site than its destination. */
export function hasDisplayedLinkMismatch(html: string, senderDomain?: string | null): boolean {
	return displayedLinkFinding(html, senderDomain) === "mismatch";
}

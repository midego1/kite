/**
 * Finds the web addresses and email addresses in plain text, so the reader can turn
 * them into links and the composer can link what the user typed. Only http, https and
 * mailto links are ever produced; the matcher never builds a link from a scheme it did
 * not match itself, so `javascript:` and `data:` text stays text.
 */

export type LinkMatch = {
	start: number;
	end: number;
	/** The matched text, without the trailing punctuation that belongs to the sentence. */
	text: string;
	href: string;
	kind: "url" | "email";
};

export type LinkTextPart = string | { text: string; href: string };

/** Longer addresses are left as text: they are rarely real links and a link is a click target. */
const MAX_LINK_LENGTH = 2048;

// Not whitespace, control or format characters (zero-width and bidi overrides can disguise a host),
// nor the characters that end an address in running text.
const URL_PATTERN = String.raw`(?:https?:\/\/|www\.)[^\s\p{C}<>"　]+`;
const EMAIL_PATTERN = String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+`;
const LINK_PATTERN = new RegExp(`(?<![\\p{L}\\p{N}_@./%+-])(?:(${URL_PATTERN})|(${EMAIL_PATTERN}))`, "giu");

const TRAILING_PUNCTUATION = new Set([..."'.,;:!?*~`…。、，；：！？"]);
const CLOSING_PAIRS: Record<string, string> = {
	")": "(",
	"]": "[",
	"}": "{",
	"）": "（",
	"」": "「",
	"』": "『",
	"】": "【",
	"》": "《",
};

/**
 * Drops what ends a sentence rather than an address: "(see https://x.com/a)." links "https://x.com/a".
 * One pass from the end over bracket counts taken once, so hostile input stays linear.
 */
function trimTrailing(value: string): string {
	const balance: Record<string, number> = {};
	for (const character of value) balance[character] = (balance[character] ?? 0) + 1;
	let end = value.length;
	while (end > 0) {
		const last = value[end - 1] as string;
		const opener = CLOSING_PAIRS[last];
		if (TRAILING_PUNCTUATION.has(last)) {
			end -= 1;
		} else if (opener && (balance[last] ?? 0) > (balance[opener] ?? 0)) {
			balance[last] = (balance[last] ?? 0) - 1;
			end -= 1;
		} else {
			break;
		}
	}
	return value.slice(0, end);
}

/** The punctuation `trimTrailing` leaves out of an address, for callers that look past a link's end. */
export const LINK_TAIL = /^[\s'.,;:!?*~`…。、，；：！？)\]}）」』】》]*$/u;

function urlMatch(raw: string, index: number): LinkMatch | null {
	// Before any work on it: the match runs to the next space, however long that is.
	if (raw.length > MAX_LINK_LENGTH) return null;
	const text = trimTrailing(raw);
	if (!text) return null;
	const href = /^www\./i.test(text) ? `https://${text}` : text;
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	// "https://paypal.com@evil.example" shows one host and opens another.
	if (url.username || url.password) return null;
	// A bare "www." or "www.com" is not an address.
	if (/^www\./i.test(text) && url.hostname.split(".").length < 3) return null;
	if (!url.hostname || url.hostname.startsWith(".") || url.hostname.endsWith(".")) return null;
	return { start: index, end: index + text.length, text, href, kind: "url" };
}

function emailMatch(raw: string, index: number): LinkMatch | null {
	if (raw.length > MAX_LINK_LENGTH) return null;
	const text = raw.replace(/[-_.%+]+$/, "");
	const at = text.lastIndexOf("@");
	const domain = text.slice(at + 1);
	const topLevel = domain.slice(domain.lastIndexOf(".") + 1);
	if (text.length - at > 255) return null;
	if (!/^(?:\p{L}{2,}|xn--[a-z0-9-]+)$/iu.test(topLevel)) return null;
	if (/(?:^|\.)-|-(?:\.|$)/.test(domain)) return null;
	return { start: index, end: index + text.length, text, href: `mailto:${text}`, kind: "email" };
}

/** The links in `text`, in order and without overlaps. */
export function findLinks(text: string): LinkMatch[] {
	const matches: LinkMatch[] = [];
	if (!/[@:.]/.test(text)) return matches;
	for (const found of text.matchAll(LINK_PATTERN)) {
		const match = found[1] ? urlMatch(found[1], found.index) : emailMatch(found[2] as string, found.index);
		if (match) matches.push(match);
	}
	return matches;
}

/** `text` cut into plain strings and links, for renderers that build elements instead of HTML. */
export function splitLinkedText(text: string): LinkTextPart[] {
	const parts: LinkTextPart[] = [];
	let position = 0;
	for (const link of findLinks(text)) {
		if (link.start > position) parts.push(text.slice(position, link.start));
		parts.push({ text: link.text, href: link.href });
		position = link.end;
	}
	if (position < text.length) parts.push(text.slice(position));
	return parts;
}

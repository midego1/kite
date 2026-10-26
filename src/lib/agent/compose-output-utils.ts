import {
	EMAIL_PATTERN,
	META_PREFIX,
	URL_PATTERN,
	normalizeUrl,
	stripDraftMarkdown,
} from "./auto-read/draft-guard-utils";
import type { ComposeMode, ComposeOutcome, ComposeWarning } from "./compose-types";

const WRITE_MAX_CHARS = 12_000;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
// Common generic and country domains. A domain must end in one of them to count as a link, so "e.g.", "i.e."
// and "Node.js" in ordinary prose are left alone.
const TLDS =
	"com|net|org|info|biz|io|co|app|dev|ai|me|tv|ly|xyz|online|site|email|cloud|link|shop|nl|de|fr|es|uk|be|ch|at|it|eu|us|ca|au|ru|cn|jp|in|br|se|no|dk|fi|pl|pt|ie|nz|za|test|example";
const BARE_DOMAIN = new RegExp(
	`(?<![\\w@./:-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))\\b(\\/[^\\s<>()\\[\\]"'\`]*)?`,
	"gi",
);
// "name (at) example (dot) com", "name [at] example.com": spelled-out addresses in brackets.
const OBFUSCATED_ADDRESS = /([\w.+-]+)\s*[[(]\s*at\s*[\])]\s*([\w-]+(?:(?:\s*[[(]\s*dot\s*[\])]\s*|\.)[\w-]+)+)/gi;
const DOT_WORD = /\s*[[(]\s*dot\s*[\])]\s*/gi;
const UNTRUSTED_LINK = /\[untrusted link: ([^\]\s]+)\]/g;
// Markdown a user's own text may contain on purpose; plain "- " list lines do not count.
const MARKDOWN = /(^|\n)\s{0,3}(#{1,6}\s|```)|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/;
// A private-use character that no answer contains, marking the links and addresses already checked.
const MARK = String.fromCharCode(0xe000);
const PROTECTED = new RegExp(`${MARK}(\\d+)${MARK}`, "g");

/** The longest text a request may return: 12,000 characters to write, three times the input for a rewrite. */
export function composeLengthCap(mode: ComposeMode, inputChars: number): number {
	return mode === "write" ? WRITE_MAX_CHARS : Math.max(300, inputChars * 3);
}

type Known = { addresses: Set<string>; urls: Set<string>; hosts: Set<string> };

const hostOf = (url: string) => url.replace(/^https:\/\//, "").split(/[/?#]/)[0];

/** Every address, link and link host in some text: full URLs, bare domains and the domains of addresses. */
function collectKnown(texts: (string | null | undefined)[]): Known {
	const joined = texts.filter(Boolean).join("\n").replace(UNTRUSTED_LINK, "$1");
	const urls = new Set((joined.match(URL_PATTERN) ?? []).map(normalizeUrl));
	for (const match of joined.matchAll(BARE_DOMAIN)) urls.add(normalizeUrl(`https://${match[0]}`));
	const addresses = new Set(
		(joined.match(EMAIL_PATTERN) ?? []).map((address) => address.replace(TRAILING_PUNCTUATION, "").toLowerCase()),
	);
	return { addresses, urls, hosts: new Set([...urls].map(hostOf)) };
}

function cutAtSentence(text: string, max: number): string {
	const cut = text.slice(0, max);
	const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("\n\n"));
	return (end > max / 2 ? cut.slice(0, end + 1) : cut).trimEnd();
}

export type ComposeCheckContext = {
	mode: ComposeMode;
	/** What the user gave: the text being rewritten, or the request for a new email. */
	input: string;
	/** The user's own text and request, whose links and addresses may be repeated freely. */
	userReferences: (string | null | undefined)[];
	/** The email being answered: its links may be repeated, with a warning to check them. */
	sourceReferences: (string | null | undefined)[];
};

/**
 * Checks a finished composer answer before the panel may insert it. Links and addresses come first, on the text
 * as the model wrote it: one the user's text, request and the email being answered do not contain is removed and
 * reported, including bare domains and addresses spelled out as "name (at) domain"; one only the email contains is
 * kept with its own warning. Then Markdown becomes plain text (unless the user's own text used Markdown), with the
 * checked links and addresses kept exactly as they were. An answer that talks about the text instead of being it
 * is refused, unless the text being rewritten starts the same way. Runs whatever the prompt said.
 */
export function checkComposeOutput(raw: string, context: ComposeCheckContext): ComposeOutcome {
	const user = collectKnown(context.userReferences);
	const source = collectKnown(context.sourceReferences);
	const warnings = new Set<ComposeWarning>();
	const kept: string[] = [];
	const keep = (value: string) => `${MARK}${kept.push(value) - 1}${MARK}`;
	const checkLink = (value: string, key: string, host: string | null) => {
		if (user.urls.has(key) || (host && user.hosts.has(host))) return keep(value);
		if (source.urls.has(key) || (host && source.hosts.has(host))) {
			warnings.add("link_from_email");
			return keep(value);
		}
		warnings.add("removed_link");
		return value.match(TRAILING_PUNCTUATION)?.[0] ?? "";
	};
	const checkAddress = (value: string, address: string) => {
		if (user.addresses.has(address) || source.addresses.has(address)) return keep(value);
		warnings.add("removed_address");
		return "";
	};

	let text = raw.replace(/\r\n?/g, "\n").replace(UNTRUSTED_LINK, "$1");
	text = text.replace(OBFUSCATED_ADDRESS, (value, local: string, domain: string) =>
		checkAddress(value, `${local}@${domain.replace(DOT_WORD, ".").replace(/\s+/g, "")}`.toLowerCase()),
	);
	text = text.replace(URL_PATTERN, (url) => {
		const key = normalizeUrl(url);
		return checkLink(url, key, null);
	});
	text = text.replace(EMAIL_PATTERN, (address) =>
		checkAddress(address, address.replace(TRAILING_PUNCTUATION, "").toLowerCase()),
	);
	text = text.replace(BARE_DOMAIN, (value: string, host: string) =>
		checkLink(value, normalizeUrl(`https://${value}`), host.toLowerCase()),
	);
	if (!MARKDOWN.test(context.input)) text = stripDraftMarkdown(text);
	text = text
		.replace(PROTECTED, (_, index: string) => kept[Number(index)])
		.replace(/[ \t]{2,}/g, " ")
		.replace(/ +([.,;:!?])/g, "$1")
		.trim();
	if (!text) return { ok: false, error: "Kite returned no usable text. Try again." };
	const rewritingSamePrefix = context.mode === "rewrite" && META_PREFIX.test(context.input.trim());
	if (!rewritingSamePrefix && META_PREFIX.test(text))
		return { ok: false, error: "Kite answered with a note instead of the text. Try again." };
	const cap = composeLengthCap(context.mode, context.input.length);
	if (text.length > cap) {
		text = cutAtSentence(text, cap);
		warnings.add("truncated");
	}
	return { ok: true, text, warnings: [...warnings] };
}

// Link and address spellings that URL_PATTERN and EMAIL_PATTERN miss, shared by every check that compares a
// model's text with the mail it read (Write with Kite, summaries).

// Common generic and country domains. A domain must end in one of them to count as a link, so "e.g.", "i.e."
// and "Node.js" in ordinary prose are left alone.
const TLDS =
	"com|net|org|info|biz|io|co|app|dev|ai|me|tv|ly|xyz|online|site|email|cloud|link|shop|nl|de|fr|es|uk|be|ch|at|it|eu|us|ca|au|ru|cn|jp|in|br|se|no|dk|fi|pl|pt|ie|nz|za|test|example";
export const BARE_DOMAIN = new RegExp(
	`(?<![\\w@./:-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))\\b(\\/[^\\s<>()\\[\\]"'\`]*)?`,
	"gi",
);
// "name (at) example (dot) com", "name [at] example.com": spelled-out addresses in brackets. The local part starts
// where a run of address characters starts and the parts are bounded, so a long run in a hostile message cannot
// make the scan quadratic.
export const OBFUSCATED_ADDRESS =
	/(?<![\w.+-])([\w.+-]{1,64})\s{0,8}[[(]\s{0,8}at\s{0,8}[\])]\s{0,8}([\w-]{1,63}(?:(?:\s{0,8}[[(]\s{0,8}dot\s{0,8}[\])]\s{0,8}|\.)[\w-]{1,63}){1,8})/gi;
const CAPITALISED_ENDING = /^[A-Z][a-z]+$/;
const DOT_WORD = /\s*[[(]\s*dot\s*[\])]\s*/gi;

/** The address an obfuscated spelling stands for: `name (at) example (dot) com` is `name@example.com`. */
export function obfuscatedAddress(local: string, domain: string): string {
	return `${local}@${domain.replace(DOT_WORD, ".").replace(/\s+/g, "")}`.toLowerCase();
}

/**
 * The bare domains in `text`. With `sentenceSafe`, one whose last label is capitalised ("fine.No problem",
 * "end.In the end": two sentences with no space) and has no path is not counted, so a summary does not lose words
 * to a country-code domain; all-lowercase and all-capitals endings ("evil.com", "EVIL.COM") still are.
 */
export function bareDomainMatches(text: string, sentenceSafe = false): RegExpMatchArray[] {
	const matches = [...text.matchAll(BARE_DOMAIN)];
	if (!sentenceSafe) return matches;
	const kept: RegExpMatchArray[] = [];
	for (const match of matches) {
		const ending = match[1].slice(match[1].lastIndexOf(".") + 1);
		if (match[2] || !CAPITALISED_ENDING.test(ending)) kept.push(match);
	}
	return kept;
}

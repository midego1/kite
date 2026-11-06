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
// A capitalised ending that is also an English word, after one all-lowercase label: "fine.No problem".
const SENTENCE_ENDING = /^(?:At|Be|In|It|Me|No|Us)$/;
const LOWERCASE_LABEL = /^[a-z0-9-]+$/;
const DOT_WORD = /\s*[[(]\s*dot\s*[\])]\s*/gi;

/** The address an obfuscated spelling stands for: `name (at) example (dot) com` is `name@example.com`. */
export function obfuscatedAddress(local: string, domain: string): string {
	return `${local}@${domain.replace(DOT_WORD, ".").replace(/\s+/g, "")}`.toLowerCase();
}

/**
 * The bare domains in `text`. With `sentenceSafe`, two sentences glued without a space ("fine.No problem", "end.In
 * the end") are not counted: a lowercase word, a dot and a capitalised English word that is also a country-code
 * ending, with no path. Anything else stays a domain, so `Evil.Com`, `Paypal.Co`, `login.paypal.Com` and `evil.No/pay`
 * are removed like `evil.com`.
 */
export function bareDomainMatches(text: string, sentenceSafe = false): RegExpMatchArray[] {
	const matches = [...text.matchAll(BARE_DOMAIN)];
	if (!sentenceSafe) return matches;
	const kept: RegExpMatchArray[] = [];
	for (const match of matches) {
		const labels = match[1].split(".");
		const glued =
			!match[2] && labels.length === 2 && LOWERCASE_LABEL.test(labels[0]) && SENTENCE_ENDING.test(labels[1]);
		if (!glued) kept.push(match);
	}
	return kept;
}

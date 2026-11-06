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
// "name (at) example (dot) com", "name [at] example.com": spelled-out addresses in brackets.
export const OBFUSCATED_ADDRESS =
	/([\w.+-]+)\s*[[(]\s*at\s*[\])]\s*([\w-]+(?:(?:\s*[[(]\s*dot\s*[\])]\s*|\.)[\w-]+)+)/gi;
const DOT_WORD = /\s*[[(]\s*dot\s*[\])]\s*/gi;

/** The address an obfuscated spelling stands for: `name (at) example (dot) com` is `name@example.com`. */
export function obfuscatedAddress(local: string, domain: string): string {
	return `${local}@${domain.replace(DOT_WORD, ".").replace(/\s+/g, "")}`.toLowerCase();
}

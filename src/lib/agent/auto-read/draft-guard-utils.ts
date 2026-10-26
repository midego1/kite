const DRAFT_MAX_CHARS = 10_000;
export const META_PREFIX =
	/^(here is|here's|here are|i have drafted|i've drafted|i drafted|draft created|below is|sure[,!.]|certainly[,!.]|as an ai)/i;
export const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
export const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

type DraftGuardReason = "empty" | "too_long" | "meta_text" | "unknown_address" | "unknown_url";

export type DraftGuardResult = { ok: true; text: string } | { ok: false; reason: DraftGuardReason; offending?: string };

// Emphasis only where Markdown would render it: the markers sit at word boundaries and hug non-space text, so
// "report_final_v2.pdf", "snake_case", "5 * 3 * 2", "2*3" and "*not emphasis *" stay as they are.
const STRONG_STARS = /(?<![\w*])\*\*(\S(?:[^*\n]*?\S)?)\*\*(?![\w*])/g;
const STRONG_UNDERSCORES = /(?<![\w_])__(\S(?:[^_\n]*?\S)?)__(?![\w_])/g;
const EMPHASIS_STAR = /(?<![\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])/g;
const EMPHASIS_UNDERSCORE = /(?<![\w_])_(\S(?:[^_\n]*?\S)?)_(?![\w_])/g;

/**
 * Turns Markdown a model slipped into a plain-text draft back into plain text. `emphasis: false` keeps `*` and `_`
 * emphasis markers, for text whose author used those characters themselves.
 */
export function stripDraftMarkdown(body: string, options: { emphasis?: boolean } = {}): string {
	const emphasis = options.emphasis ?? true;
	return body
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => {
			const plain = line
				.replace(/^\s*```[^\n]*$/, "")
				.replace(/^\s{0,3}#{1,6}\s+/, "")
				.replace(/^\s{0,3}[-*+]\s+/, "• ")
				.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
				.replace(/~~([^~\n]+)~~/g, "$1")
				.replace(/`([^`\n]+)`/g, "$1");
			if (!emphasis) return plain;
			return plain
				.replace(STRONG_STARS, "$1")
				.replace(STRONG_UNDERSCORES, "$1")
				.replace(EMPHASIS_STAR, "$1")
				.replace(EMPHASIS_UNDERSCORE, "$1");
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function normalizeUrl(value: string): string {
	const trimmed = value.replace(TRAILING_PUNCTUATION, "");
	const withScheme = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
	return withScheme
		.replace(/^http:\/\//i, "https://")
		.replace(/^(https:\/\/[^/?#]+)/i, (origin) => origin.toLowerCase())
		.replace(/\/+$/, "");
}

function addresses(text: string): string[] {
	return (text.match(EMAIL_PATTERN) ?? []).map((address) => address.replace(TRAILING_PUNCTUATION, "").toLowerCase());
}

function urls(text: string): string[] {
	return (text.match(URL_PATTERN) ?? []).map(normalizeUrl);
}

export type ThreadReferences = { addresses: Set<string>; urls: Set<string> };

/** Every address and URL that appears in the thread (bodies and address headers), which a draft may repeat. */
export function collectThreadReferences(texts: (string | null | undefined)[]): ThreadReferences {
	const joined = texts.filter(Boolean).join("\n");
	return { addresses: new Set(addresses(joined)), urls: new Set(urls(joined)) };
}

/**
 * Checks a generated reply before it is saved: plain text only, no meta text such as "Here is a
 * draft", a length cap, and no address or URL the thread does not already contain.
 */
export function guardDraft(body: string, references: ThreadReferences): DraftGuardResult {
	const text = stripDraftMarkdown(body);
	if (!text) return { ok: false, reason: "empty" };
	if (text.length > DRAFT_MAX_CHARS) return { ok: false, reason: "too_long" };
	if (META_PREFIX.test(text)) return { ok: false, reason: "meta_text" };
	const address = addresses(text).find((candidate) => !references.addresses.has(candidate));
	if (address) return { ok: false, reason: "unknown_address", offending: address };
	const url = urls(text).find((candidate) => !references.urls.has(candidate));
	if (url) return { ok: false, reason: "unknown_url", offending: url };
	return { ok: true, text };
}

const DRAFT_MAX_CHARS = 10_000;
const META_PREFIX =
	/^(here is|here's|here are|i have drafted|i've drafted|i drafted|draft created|below is|sure[,!.]|certainly[,!.]|as an ai)/i;
const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

type DraftGuardReason = "empty" | "too_long" | "meta_text" | "unknown_address" | "unknown_url";

export type DraftGuardResult = { ok: true; text: string } | { ok: false; reason: DraftGuardReason; offending?: string };

/** Turns Markdown a model slipped into a plain-text draft back into plain text. */
export function stripDraftMarkdown(body: string): string {
	return body
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) =>
			line
				.replace(/^\s*```[^\n]*$/, "")
				.replace(/^\s{0,3}#{1,6}\s+/, "")
				.replace(/^\s{0,3}[-*+]\s+/, "• ")
				.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
				.replace(/\*\*([^*\n]+)\*\*/g, "$1")
				.replace(/__([^_\n]+)__/g, "$1")
				.replace(/\*([^*\n]+)\*/g, "$1")
				.replace(/_([^_\n]+)_/g, "$1")
				.replace(/~~([^~\n]+)~~/g, "$1")
				.replace(/`([^`\n]+)`/g, "$1"),
		)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function normalizeUrl(value: string): string {
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

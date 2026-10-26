import {
	EMAIL_PATTERN,
	META_PREFIX,
	URL_PATTERN,
	collectThreadReferences,
	normalizeUrl,
	stripDraftMarkdown,
} from "./auto-read/draft-guard-utils";
import type { ComposeMode, ComposeOutcome, ComposeWarning } from "./compose-types";

const WRITE_MAX_CHARS = 12_000;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** The longest text a request may return: 12,000 characters to write, three times the input for a rewrite. */
export function composeLengthCap(mode: ComposeMode, inputChars: number): number {
	return mode === "write" ? WRITE_MAX_CHARS : Math.max(300, inputChars * 3);
}

function cutAtSentence(text: string, max: number): string {
	const cut = text.slice(0, max);
	const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("\n\n"));
	return (end > max / 2 ? cut.slice(0, end + 1) : cut).trimEnd();
}

/**
 * Checks a finished composer answer before the panel may insert it: Markdown becomes plain text, an answer that
 * talks about the text instead of being it is refused, and an address or link the user's text, request and the
 * email being answered do not contain is removed and reported. Runs whatever the prompt said.
 */
export function checkComposeOutput(
	raw: string,
	context: { mode: ComposeMode; inputChars: number; references: (string | null | undefined)[] },
): ComposeOutcome {
	let text = stripDraftMarkdown(raw);
	if (!text) return { ok: false, error: "Kite returned no text. Try again." };
	if (META_PREFIX.test(text)) return { ok: false, error: "Kite answered with a note instead of the text. Try again." };
	const known = collectThreadReferences(context.references);
	const warnings = new Set<ComposeWarning>();
	text = text.replace(URL_PATTERN, (url) => {
		if (known.urls.has(normalizeUrl(url))) return url;
		warnings.add("removed_link");
		const trailing = url.match(TRAILING_PUNCTUATION)?.[0] ?? "";
		return trailing;
	});
	text = text.replace(EMAIL_PATTERN, (address) => {
		if (known.addresses.has(address.replace(TRAILING_PUNCTUATION, "").toLowerCase())) return address;
		warnings.add("removed_address");
		return "";
	});
	text = text
		.replace(/[ \t]{2,}/g, " ")
		.replace(/ +([.,;:!?])/g, "$1")
		.trim();
	const cap = composeLengthCap(context.mode, context.inputChars);
	if (text.length > cap) {
		text = cutAtSentence(text, cap);
		warnings.add("truncated");
	}
	if (!text) return { ok: false, error: "Kite returned no usable text. Try again." };
	return { ok: true, text, warnings: [...warnings] };
}

import {
	EMAIL_PATTERN,
	META_PREFIX,
	URL_PATTERN,
	collectThreadReferences,
	normalizeUrl,
	stripDraftMarkdown,
	type ThreadReferences,
} from "../auto-read/draft-guard-utils";
import type { PersonalInstructions } from "../instruction-types";
import type { SummaryLabel, SummaryOutcome, SummaryPoint } from "./summary-types";

export const SUMMARY_LABELS: readonly SummaryLabel[] = ["Asks", "Decisions", "Dates", "Next steps"];
export const OVERVIEW_MAX_CHARS = 400;
export const POINT_MAX_CHARS = 200;
export const POINTS_MAX = 5;
export const POINTS_TOTAL_MAX_CHARS = 1_200;
/** The language code of a summary whose language is unknown. */
export const UNKNOWN_LANGUAGE = "und";

const LANGUAGE_CODE = /^[a-z]{2}$/;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** A model's `language` as a lower-case ISO 639-1 code, else `und`. */
export function languageCode(value: unknown): string {
	const code = typeof value === "string" ? value.trim().toLowerCase() : "";
	return LANGUAGE_CODE.test(code) ? code : UNKNOWN_LANGUAGE;
}

/** The primary subtag of a browser language (`nl` from `nl-NL`), or null when it is not a two-letter code. */
export function primaryLanguage(value: string | null | undefined): string | null {
	const code = (value ?? "").trim().split(/[-_]/)[0].toLowerCase();
	return LANGUAGE_CODE.test(code) ? code : null;
}

/** Whether a summary in `summaryLanguage` can be translated for a reader whose language is `userLanguage`. */
export function canTranslate(summaryLanguage: string | null | undefined, userLanguage: string | null | undefined) {
	const from = languageCode(summaryLanguage);
	const to = languageCode(userLanguage);
	return from !== UNKNOWN_LANGUAGE && to !== UNKNOWN_LANGUAGE && from !== to;
}

/** A language's English name for the prompt ("Dutch" for `nl`), or the code itself when it has none. */
export function languageName(code: string, locale = "en"): string {
	try {
		return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}

async function sha256Prefix(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The first 16 hex characters of SHA-256 over the sorted message ids a summary covers. */
export function coverageDigest(ids: readonly string[]): Promise<string> {
	return sha256Prefix([...new Set(ids)].sort().join("\n"));
}

/**
 * The cache key part for a user's personal instructions: '' when their general and summary fields are both empty,
 * so everyone without them shares one summary, else a digest of the two fields and the user's name, which the
 * prompt's personal headings name, so two people with the same instructions never share a row written for one.
 */
export async function instructionsDigest(
	personal: Pick<PersonalInstructions, "general" | "summary" | "name"> | null,
): Promise<string> {
	const general = personal?.general.trim() ?? "";
	const summary = personal?.summary.trim() ?? "";
	if (!general && !summary) return "";
	return sha256Prefix(JSON.stringify([general, summary, personal?.name.trim() ?? ""]));
}

function extractJson(text: string): unknown {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```[a-z]*[ \t]*\n?([\s\S]*?)\n?```$/i);
	const candidate = (fenced ? fenced[1] : trimmed).trim();
	if (!candidate.startsWith("{")) return undefined;
	try {
		return JSON.parse(candidate);
	} catch {
		return undefined;
	}
}

/** Plain text on one line: Markdown removed, whitespace folded, `[untrusted link: …]` labels undone. */
function plain(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = stripDraftMarkdown(value.replace(/\[untrusted link: ([^\]\s]+)\]/g, "$1")).replace(/^• /gm, "");
	return text.replace(/\s+/g, " ").trim();
}

/** Cuts at the last word boundary within `max` characters (code points), with an ellipsis. */
function cut(text: string, max: number): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	const head = chars.slice(0, max - 1).join("");
	const space = head.lastIndexOf(" ");
	return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** The links and addresses in `text` that the summarised messages do not contain. */
function unknownReferences(text: string, references: ThreadReferences): string[] {
	const addresses = (text.match(EMAIL_PATTERN) ?? []).filter(
		(address) => !references.addresses.has(address.replace(TRAILING_PUNCTUATION, "").toLowerCase()),
	);
	const urls = (text.match(URL_PATTERN) ?? []).filter((url) => !references.urls.has(normalizeUrl(url)));
	return [...urls, ...addresses];
}

function withoutUnknown(text: string, references: ThreadReferences): string {
	let result = text;
	for (const value of unknownReferences(text, references)) result = result.split(value).join("");
	return result
		.replace(/\(\s*\)/g, "")
		.replace(/\s{2,}/g, " ")
		.replace(/ +([.,;:!?])/g, "$1")
		.trim();
}

function label(value: unknown): SummaryLabel | null {
	const text =
		typeof value === "string"
			? value
					.trim()
					.toLowerCase()
					.replace(/[:\s]+$/, "")
			: "";
	return SUMMARY_LABELS.find((candidate) => candidate.toLowerCase() === text) ?? null;
}

function checkPoints(value: unknown, references: ThreadReferences): SummaryPoint[] {
	if (!Array.isArray(value)) return [];
	const points: SummaryPoint[] = [];
	let total = 0;
	for (const item of value) {
		if (points.length >= POINTS_MAX) break;
		const { label: rawLabel, text: rawText } = (item ?? {}) as { label?: unknown; text?: unknown };
		const pointLabel = label(rawLabel);
		const text = cut(plain(rawText), POINT_MAX_CHARS);
		// A point naming a link or address the conversation does not contain is dropped whole.
		if (!pointLabel || !text || unknownReferences(text, references).length) continue;
		if (total + text.length > POINTS_TOTAL_MAX_CHARS) break;
		total += text.length;
		points.push({ label: pointLabel, text });
	}
	return points;
}

export type SummaryCheckContext = {
	/** The texts and addresses of the summarised messages, or the source summary of a translation. */
	references: (string | null | undefined)[];
	/** A translation's target language, which the answer's own `language` cannot change. */
	language?: string;
};

/**
 * Checks a model's summary before it is shown or cached: one JSON object `{ language, overview, points }`, plain
 * text only (Markdown stripped), an overview of at most 400 characters, at most five points under the four labels
 * of at most 200 characters each and 1,200 together. Links and addresses the messages do not contain are removed
 * from the overview, and a point naming one is dropped. An empty answer, or one that talks about the summary
 * ("Here is a summary…") instead of being it, is refused.
 */
export function checkSummaryOutput(raw: string, context: SummaryCheckContext): SummaryOutcome {
	const json = extractJson(raw);
	if (!json || typeof json !== "object" || Array.isArray(json))
		return { ok: false, error: "the reply is not a JSON object" };
	const value = json as { language?: unknown; overview?: unknown; points?: unknown };
	const references = collectThreadReferences(context.references);
	const overview = cut(withoutUnknown(plain(value.overview), references), OVERVIEW_MAX_CHARS);
	if (!overview) return { ok: false, error: "the overview is empty" };
	if (META_PREFIX.test(overview)) return { ok: false, error: "the overview describes the summary instead of being it" };
	return {
		ok: true,
		summary: {
			language: context.language ?? languageCode(value.language),
			overview,
			points: checkPoints(value.points, references),
		},
	};
}

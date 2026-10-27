import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import type { MetricKey, StyleMeasurement, WelfordState, WritingStyleProfileState } from "./writing-style-types";
import { detectLanguage, LANGUAGE_NAMES, type StyleLanguage } from "./writing-style-language-utils";
import { stripDelimiters } from "./untrusted-utils";

/** Bumped when a metric's definition changes; a stored profile with an older version starts over. */
export const WRITING_STYLE_METRICS_VERSION = 1;
/** Old mail fades: past this many samples each new message weighs 1/300. */
export const WELFORD_CAP = 300;
const TOP_K = 8;
const FORM_MAX_CHARS = 40;
const MIN_WORDS = 5;
const MAX_CHARS = 20_000;
export const MIN_SAMPLES = 10;
export const DESCRIPTION_MAX_CHARS = 500;

/** Every threshold the description uses, in one place so the tests pin them. */
export const STYLE_THRESHOLDS = {
	formUseShare: 0.5,
	formShareOfForms: 0.3,
	languageShare: 0.7,
	questions: 0.25,
	exclamationsRare: 0.2,
	exclamationsOften: 1.5,
	emojiNone: 0.05,
	emojiOften: 0.5,
	lists: 0.3,
	formal: 0.7,
	informal: 0.3,
	shortSentence: 15,
	longSentence: 22,
} as const;

export const METRIC_KEYS: readonly MetricKey[] = [
	"words",
	"sentenceWords",
	"paragraphs",
	"questionShare",
	"exclamationRate",
	"emojiRate",
	"listUse",
	"greetingUse",
	"signOffUse",
	"formalAddress",
];

const QUOTE_OPEN = /<div\b[^>]*\bdata-(?:kite|mailflare)-quote="1"[^>]*>/i;
const SIGNATURE_OPEN = /<div\b[^>]*\bdata-(?:kite|mailflare)-signature="1"[^>]*>/i;
const FORWARDED = /-{3,}\s*(?:Forwarded message|Doorgestuurd bericht|Weitergeleitete Nachricht|Message transféré)/i;
// "On Mon, Sam wrote:" and its Dutch, German, French and Spanish forms, which start a plain-text quote.
const QUOTE_INTRO = /^(?:on|op|am|le|el)\b.*(?:wrote|schreef|schrieb|a écrit|escribió):\s*$/i;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const EMOJI = /\p{Extended_Pictographic}/gu;
const HAS_WORD = /[\p{L}\p{N}]/u;
const LIST_LINE = /^\s*(?:[-*•]|\d{1,3}[.)])\s+/;

/**
 * The text the user wrote themselves in a composer send: without the quote, the signature block, a forwarded
 * message or (for plain text) quoted lines and the "On … wrote:" line before them. Lines are trimmed and runs of
 * blank lines collapse to one, so paragraphs are blocks separated by one blank line.
 */
export function ownText(
	html: string | null | undefined,
	text: string | null | undefined,
): { text: string; hasList: boolean } {
	let raw: string;
	let hasList = false;
	if (html) {
		let body = html;
		for (const marker of [QUOTE_OPEN, SIGNATURE_OPEN, FORWARDED]) {
			const match = marker.exec(body);
			if (match) body = body.slice(0, match.index);
		}
		hasList = /<(?:ul|ol)\b/i.test(body);
		raw = htmlToReadableText(body);
	} else {
		const lines: string[] = [];
		for (const line of (text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
			if (line === "-- " || FORWARDED.test(line)) break;
			if (line.trimStart().startsWith(">")) continue;
			lines.push(line);
		}
		while (lines.length && (QUOTE_INTRO.test(lines[lines.length - 1].trim()) || !lines[lines.length - 1].trim()))
			lines.pop();
		raw = lines.join("\n");
	}
	const normalized = raw
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { text: normalized, hasList: hasList || normalized.split("\n").some((line) => LIST_LINE.test(line)) };
}

const GREETINGS = [
	"good morning",
	"good afternoon",
	"good evening",
	"sehr geehrte",
	"sehr geehrter",
	"goedemorgen",
	"goedemiddag",
	"buenos días",
	"buenas tardes",
	"hi",
	"hello",
	"hey",
	"dear",
	"hiya",
	"greetings",
	"beste",
	"hoi",
	"hallo",
	"geachte",
	"liebe",
	"lieber",
	"moin",
	"bonjour",
	"bonsoir",
	"salut",
	"cher",
	"chère",
	"madame",
	"monsieur",
	"hola",
	"estimado",
	"estimada",
	"querido",
	"querida",
];

const SIGN_OFFS = [
	"met vriendelijke groet",
	"met vriendelijke groeten",
	"vriendelijke groet",
	"hartelijke groet",
	"mit freundlichen grüßen",
	"viele grüße",
	"liebe grüße",
	"beste grüße",
	"best regards",
	"kind regards",
	"warm regards",
	"many thanks",
	"thank you",
	"all the best",
	"bien à vous",
	"un saludo",
	"best",
	"regards",
	"thanks",
	"cheers",
	"sincerely",
	"groet",
	"groeten",
	"mvg",
	"gr",
	"grüße",
	"gruß",
	"lg",
	"cordialement",
	"amicalement",
	"bisous",
	"saludos",
	"atentamente",
	"gracias",
	"abrazos",
];

const startsWithPhrase = (lower: string, phrases: readonly string[]) =>
	phrases.find((phrase) => lower === phrase || new RegExp(`^${phrase}(?![\\p{L}])`, "u").test(lower)) ?? null;

/**
 * A greeting or sign-off line as an anonymous form: capitalised words after the opening phrase become `{name}`,
 * addresses, links, phone numbers and digits go, at most 40 characters. Null when nothing but the name is left.
 */
export function anonymiseForm(line: string, phrase: string): string | null {
	const rest = line.slice(phrase.length);
	const named = rest
		.replace(/\S+@\S+/g, "")
		.replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
		.replace(/\+?\d[\d\s().-]*/g, "")
		.replace(/(?:\s*\b\p{Lu}[\p{L}'’.-]*)+/gu, " {name}");
	const form = stripDelimiters(`${line.slice(0, phrase.length).toLowerCase()}${named.toLowerCase()}`)
		.replace(/["<>]/g, "")
		.replace(/\s+/g, " ")
		.replace(/\s+([,!.])/g, "$1")
		.trim();
	const chars = Array.from(form);
	return chars.length ? chars.slice(0, FORM_MAX_CHARS).join("").trim() : null;
}

function greetingOf(line: string): string | null {
	const words = line.match(WORD) ?? [];
	if (words.length === 0 || words.length > 6 || /[.?:;]$/.test(line)) return null;
	const phrase = startsWithPhrase(line.toLowerCase(), GREETINGS);
	return phrase ? anonymiseForm(line, phrase) : null;
}

function signOffOf(line: string): string | null {
	const words = line.match(WORD) ?? [];
	if (words.length === 0 || words.length > 4 || /[?:;]$/.test(line)) return null;
	const phrase = startsWithPhrase(line.toLowerCase(), SIGN_OFFS) ?? (line.endsWith(",") ? "" : null);
	if (phrase === null) return null;
	// A comma-ended line that is not a known sign-off ("Talk soon,") is anonymised the same way, names removed.
	return anonymiseForm(line, phrase || (words[0] ?? ""));
}

type Formality = { formal: (word: string) => boolean; informal: Set<string> };

const FORMALITY: Partial<Record<StyleLanguage, Formality>> = {
	nl: { formal: (word) => ["u", "uw"].includes(word.toLowerCase()), informal: new Set(["je", "jij", "jou", "jouw"]) },
	fr: { formal: (word) => word.toLowerCase() === "vous", informal: new Set(["tu", "toi", "ton", "ta", "tes"]) },
	es: {
		formal: (word) => ["usted", "ustedes"].includes(word.toLowerCase()),
		informal: new Set(["tú", "te", "ti", "tu", "tus"]),
	},
	// German "Sie" is also "they" and "she" at a sentence start, so only a capitalised form inside a sentence counts.
	de: {
		formal: (word) => ["Sie", "Ihnen", "Ihr", "Ihre", "Ihren", "Ihrem", "Ihrer"].includes(word),
		informal: new Set(["du", "dich", "dir", "dein", "deine", "deinen", "deinem", "deiner"]),
	},
};

/** Formal second-person forms out of all second-person forms, for a supported language that has any. */
function formalShare(language: StyleLanguage | null, text: string): number | null {
	const rules = language ? FORMALITY[language] : undefined;
	if (!rules) return null;
	let formal = 0;
	let informal = 0;
	for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
		const words = sentence.match(WORD) ?? [];
		words.forEach((word, index) => {
			if (language === "de" && index === 0) return;
			if (rules.formal(word)) formal++;
			else if (rules.informal.has(word.toLowerCase())) informal++;
		});
	}
	return formal + informal === 0 ? null : formal / (formal + informal);
}

const nonEmptyLines = (text: string) => text.split("\n").filter((line) => line.trim());

/**
 * The measurements of one sent message, or null when it is too short (under five words) or too long (over 20,000
 * characters) to say anything about how its author writes.
 */
export function measureMessage(own: { text: string; hasList: boolean }): StyleMeasurement | null {
	const text = own.text;
	const words = text.match(WORD) ?? [];
	if (words.length < MIN_WORDS || text.length > MAX_CHARS) return null;
	const lines = nonEmptyLines(text);
	const greeting = lines.length > 1 ? greetingOf(lines[0]) : null;
	const signOff = lines.length > 1 ? signOffOf(lines[lines.length - 1]) : null;
	// The greeting and sign-off lines are not sentences of the message itself.
	const body = lines.slice(greeting ? 1 : 0, signOff ? -1 : undefined).join("\n");
	const sentences = body.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => HAS_WORD.test(sentence));
	const sentenceCount = Math.max(1, sentences.length);
	const paragraphs = text
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.filter((block) => block && !(greeting && block === lines[0]) && !(signOff && block === lines[lines.length - 1]));
	const language = detectLanguage(words);
	return {
		values: {
			words: words.length,
			sentenceWords: (body.match(WORD) ?? []).length / sentenceCount,
			paragraphs: Math.max(1, paragraphs.length),
			questionShare: sentences.filter((sentence) => sentence.trim().endsWith("?")).length / sentenceCount,
			exclamationRate: ((text.match(/!/g) ?? []).length * 100) / words.length,
			emojiRate: ((text.match(EMOJI) ?? []).length * 100) / words.length,
			listUse: own.hasList ? 1 : 0,
			greetingUse: greeting ? 1 : 0,
			signOffUse: signOff ? 1 : 0,
			formalAddress: formalShare(language, text),
		},
		greeting,
		signOff,
		language,
	};
}

/** Welford's running mean and variance, with the count capped so that old mail fades. */
export function welfordStep(state: WelfordState | undefined, x: number): WelfordState {
	const { n, mean, m2 } = state ?? { n: 0, mean: 0, m2: 0 };
	const next = Math.min(n + 1, WELFORD_CAP);
	const delta = x - mean;
	const nextMean = mean + delta / next;
	const keep = n + 1 > WELFORD_CAP ? m2 * ((WELFORD_CAP - 1) / WELFORD_CAP) : m2;
	return { n: next, mean: nextMean, m2: keep + delta * (x - nextMean) };
}

/** The standard deviation, shown only from ten samples on. */
export function welfordDeviation(state: WelfordState): number | null {
	return state.n >= MIN_SAMPLES ? Math.sqrt(state.m2 / (state.n - 1)) : null;
}

/** Counts one more use of `form`, keeping the eight most frequent; the least frequent other form makes room. */
export function bumpTopK(counts: Record<string, number>, form: string | null): Record<string, number> {
	if (!form) return counts;
	const next = { ...counts, [form]: (counts[form] ?? 0) + 1 };
	const keys = Object.keys(next);
	if (keys.length > TOP_K) {
		const [evict] = keys.filter((key) => key !== form).sort((a, b) => next[a] - next[b] || b.localeCompare(a));
		delete next[evict];
	}
	return next;
}

export function emptyProfile(): WritingStyleProfileState {
	return { sampleCount: 0, stats: {}, greetings: {}, signOffs: {}, languages: {} };
}

/** The profile after one more measured message. */
export function updateProfile(profile: WritingStyleProfileState, measured: StyleMeasurement): WritingStyleProfileState {
	const stats = { ...profile.stats };
	for (const key of METRIC_KEYS) {
		const value = measured.values[key];
		if (value !== null && Number.isFinite(value)) stats[key] = welfordStep(stats[key], value);
	}
	return {
		sampleCount: profile.sampleCount + 1,
		stats,
		greetings: bumpTopK(profile.greetings, measured.greeting),
		signOffs: bumpTopK(profile.signOffs, measured.signOff),
		languages: bumpTopK(profile.languages, measured.language),
	};
}

function readableStep(value: number): number {
	if (value < 10) return 1;
	if (value < 50) return 5;
	return value < 200 ? 10 : 50;
}

/** "40 to 110": mean ± one standard deviation, rounded to a readable step, at least 1. */
function range(state: WelfordState): [number, number] | null {
	const deviation = welfordDeviation(state);
	if (deviation === null) return null;
	const round = (value: number) => {
		const step = readableStep(Math.abs(value));
		return Math.max(1, Math.round(value / step) * step);
	};
	return [round(state.mean - deviation), round(state.mean + deviation)];
}

function topForm(counts: Record<string, number>, use: WelfordState | undefined): string | null {
	if (!use || use.mean < STYLE_THRESHOLDS.formUseShare) return null;
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return best && best[1] / total >= STYLE_THRESHOLDS.formShareOfForms ? best[0] : null;
}

function mainLanguage(languages: Record<string, number>): Exclude<StyleLanguage, "other"> | null {
	const total = Object.values(languages).reduce((sum, count) => sum + count, 0);
	const [best] = Object.entries(languages).sort((a, b) => b[1] - a[1]);
	if (!best || best[0] === "other" || best[1] / total < STYLE_THRESHOLDS.languageShare) return null;
	return best[0] as Exclude<StyleLanguage, "other">;
}

const FORMAL_WORDS: Partial<Record<StyleLanguage, [string, string]>> = {
	nl: ["u", "je"],
	de: ["Sie", "du"],
	fr: ["vous", "tu"],
	es: ["usted", "tú"],
};

function lengthSentence(stats: WritingStyleProfileState["stats"]): string | null {
	const words = stats.words && range(stats.words);
	const paragraphs = stats.paragraphs && range(stats.paragraphs);
	const sentenceWords = stats.sentenceWords?.mean;
	if (!words) return null;
	const length = words[0] === words[1] ? `about ${words[0]} words` : `${words[0]} to ${words[1]} words`;
	const blocks = paragraphs
		? paragraphs[0] === paragraphs[1]
			? ` in ${paragraphs[0] === 1 ? "one paragraph" : `about ${paragraphs[0]} paragraphs`}`
			: ` in ${paragraphs[0]} to ${paragraphs[1]} paragraphs`
		: "";
	const kind =
		sentenceWords === undefined
			? ""
			: `, with ${sentenceWords < STYLE_THRESHOLDS.shortSentence ? "short" : sentenceWords < STYLE_THRESHOLDS.longSentence ? "medium-length" : "long"} sentences (about ${Math.round(sentenceWords)} words)`;
	return `Usually ${length}${blocks}${kind}.`;
}

function formsSentence(profile: WritingStyleProfileState): string | null {
	const greeting = topForm(profile.greetings, profile.stats.greetingUse);
	const signOff = topForm(profile.signOffs, profile.stats.signOffUse);
	if (greeting && signOff) return `Opens with "${greeting}" and closes with "${signOff}".`;
	if (greeting) return `Opens with "${greeting}".`;
	return signOff ? `Closes with "${signOff}".` : null;
}

function formalitySentence(profile: WritingStyleProfileState, language: StyleLanguage | null): string | null {
	const formal = profile.stats.formalAddress;
	if (!formal || formal.n < 5) return null;
	const words = language ? FORMAL_WORDS[language] : undefined;
	if (formal.mean >= STYLE_THRESHOLDS.formal) return `Addresses people formally${words ? ` (${words[0]})` : ""}.`;
	if (formal.mean <= STYLE_THRESHOLDS.informal) return `Addresses people informally${words ? ` (${words[1]})` : ""}.`;
	return null;
}

function habitsSentence(stats: WritingStyleProfileState["stats"]): string | null {
	const habits: string[] = [];
	if (stats.questionShare && stats.questionShare.mean > STYLE_THRESHOLDS.questions) habits.push("often asks questions");
	if (stats.listUse && stats.listUse.mean > STYLE_THRESHOLDS.lists) habits.push("uses bullet lists for several points");
	const exclamations = stats.exclamationRate?.mean;
	if (exclamations !== undefined && exclamations < STYLE_THRESHOLDS.exclamationsRare)
		habits.push("rarely uses exclamation marks");
	else if (exclamations !== undefined && exclamations > STYLE_THRESHOLDS.exclamationsOften)
		habits.push("often uses exclamation marks");
	const emoji = stats.emojiRate?.mean;
	if (emoji !== undefined && emoji < STYLE_THRESHOLDS.emojiNone) habits.push("does not use emoji");
	else if (emoji !== undefined && emoji > STYLE_THRESHOLDS.emojiOften) habits.push("uses emoji");
	if (!habits.length) return null;
	const text = habits.join("; ");
	return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

const NAME_HINT = "Replace {name} with the recipient's first name, or leave the greeting out when you do not know it.";

/**
 * A few sentences of plain English that tell a model how the user writes, at most 500 characters, or null below ten
 * samples. `withoutFormality` leaves the formality out, for a request to make text more formal or more casual.
 */
export function describeWritingStyle(
	profile: WritingStyleProfileState,
	options: { withoutFormality?: boolean } = {},
): string | null {
	if (profile.sampleCount < MIN_SAMPLES) return null;
	const language = mainLanguage(profile.languages);
	const sentences = [
		language ? `Writes in ${LANGUAGE_NAMES[language]}.` : null,
		lengthSentence(profile.stats),
		formsSentence(profile),
		options.withoutFormality ? null : formalitySentence(profile, language),
		habitsSentence(profile.stats),
	].filter((sentence): sentence is string => !!sentence);
	if (sentences.some((sentence) => sentence.includes("{name}"))) sentences.push(NAME_HINT);
	// Drop the least important sentences from the end until the description fits; the name hint goes with "{name}".
	while (sentences.join(" ").length > DESCRIPTION_MAX_CHARS && sentences.length > 1) {
		const dropped = sentences.splice(sentences.length - (sentences.at(-1) === NAME_HINT ? 2 : 1), 1)[0];
		if (dropped.includes("{name}") && sentences.at(-1) === NAME_HINT) sentences.pop();
	}
	const text = sentences.join(" ");
	return text ? Array.from(text).slice(0, DESCRIPTION_MAX_CHARS).join("") : null;
}

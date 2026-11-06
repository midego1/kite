import { EMAIL_PATTERN, URL_PATTERN } from "../auto-read/draft-guard-utils";
import { MIN_LANGUAGE_WORDS, STOP_WORDS, leadingLanguage } from "../writing-style-language-utils";

/**
 * The language of a message, told apart in the browser with no model and no dictionary: the script for most of the
 * world's writing, stop words for mail in Latin letters. Only an answer it is sure of counts; anything mixed or too
 * short is null, and the reader then offers Translate only in the message's menu.
 */

/** What is read of a message: enough to tell, and the same cost for a long newsletter. */
const SAMPLE_CHARS = 5_000;
/** Letters a script-based answer needs, so a signature or a quoted name does not decide it. */
const MIN_SCRIPT_LETTERS = 12;
/** The share of the letters a script must have; mail often mixes in Latin names and links. */
const MIN_SCRIPT_SHARE = 0.4;
const MIN_LATIN_SHARE = 0.6;
/** Japanese always has some kana; Chinese has none, apart from a stray character. */
const MIN_KANA_SHARE = 0.1;

const LETTER = /[\p{L}\p{M}]/gu;
const LATIN_WORD = /\p{Script=Latin}+/gu;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/** Scripts that say the language outright. */
const SINGLE_LANGUAGE_SCRIPTS: readonly (readonly [RegExp, string])[] = [
	[/\p{Script=Thai}/gu, "th"],
	[/\p{Script=Hangul}/gu, "ko"],
	[/\p{Script=Greek}/gu, "el"],
	[/\p{Script=Hebrew}/gu, "he"],
	[/\p{Script=Armenian}/gu, "hy"],
	[/\p{Script=Georgian}/gu, "ka"],
	[/\p{Script=Bengali}/gu, "bn"],
	[/\p{Script=Tamil}/gu, "ta"],
	[/\p{Script=Telugu}/gu, "te"],
	[/\p{Script=Kannada}/gu, "kn"],
	[/\p{Script=Malayalam}/gu, "ml"],
	[/\p{Script=Gujarati}/gu, "gu"],
	[/\p{Script=Gurmukhi}/gu, "pa"],
	[/\p{Script=Khmer}/gu, "km"],
	[/\p{Script=Lao}/gu, "lo"],
	[/\p{Script=Myanmar}/gu, "my"],
	[/\p{Script=Sinhala}/gu, "si"],
	[/\p{Script=Ethiopic}/gu, "am"],
];

/** Scripts shared by several languages: told apart by letters only one of them uses, or not at all. */
const SHARED_SCRIPTS: readonly (readonly [RegExp, (sample: string) => string | null])[] = [
	[
		/\p{Script=Han}|[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
		(sample) => {
			const han = count(sample, /\p{Script=Han}/gu);
			const kana = count(sample, KANA);
			return kana / (han + kana) >= MIN_KANA_SHARE ? "ja" : "zh";
		},
	],
	[
		/\p{Script=Arabic}/gu,
		(sample) => {
			if (/[ٹڈڑںے]/u.test(sample)) return "ur";
			return /[پچژگ]/u.test(sample) ? "fa" : "ar";
		},
	],
	[
		// Hindi, Marathi and Nepali share this script: only their common verbs tell them apart.
		/\p{Script=Devanagari}/gu,
		(sample) => (/(?:^|\s)(?:है|हैं)(?=[\s।,.]|$)/u.test(sample) && !/आहे|आणि|हुन्छ|छन्/u.test(sample) ? "hi" : null),
	],
	[
		/\p{Script=Cyrillic}/gu,
		(sample) => {
			if (/[іїєґ]/iu.test(sample)) return "uk";
			return /[ыэё]/iu.test(sample) ? "ru" : null;
		},
	],
];

/** About forty frequent words of the other languages mail in Latin letters is often written in. */
const MORE_STOP_WORDS: Record<string, string> = {
	it: "il lo gli di che e la un una per non con sono ma come più anche questo questa della delle dei nel nella si ho hai ha abbiamo siamo essere grazie sul alla al ti mi ci vi lei loro",
	pt: "o os as um uma que em não para com por mais como mas foi ao dos das você seu sua ou quando muito nos já está também só pelo pela até isso ela entre era depois sem mesmo aos ter obrigado",
	sv: "och att det som en på är av för med har jag inte till den ett vi kan du om men var ska vill så från eller detta mycket efter sig hade här nu också tack hej",
	da: "og at det som en på er af for med har jeg ikke til den et vi kan du om men var skal vil så fra eller dette meget efter sig havde her nu også tak hej",
	no: "og at det som en på er av for med har jeg ikke til den et vi kan du om men var skal vil så fra eller dette mye etter seg hadde her nå også takk hei",
	fi: "ja on ei että se oli hän mutta ovat kun niin myös kuin mitä tämä sen jos olen olet voi tai vain sekä minä sinä me te he tässä siitä kiitos hyvä",
	pl: "i w nie na to że się z do jest jak po co ale tak za od czy dla przez tego są ma już oraz być jego lub tym które może bardzo dzień dobry dziękuję",
	tr: "ve bir bu için ile de da ne gibi daha çok ama en olarak var kadar sonra ben sen biz siz olan her ya merhaba teşekkürler lütfen",
	id: "dan yang di ke dari untuk dengan ini itu pada tidak akan ada saya kami anda dalam atau juga sudah bisa oleh terima kasih karena lebih",
	ro: "și în de la cu nu pe pentru că este un o sunt din mai ce au dar sau care vă mulțumesc bună ziua am fost să se",
	cs: "a v na je se že to s do ale pro jak ve po tak by jsem jsme jste není nebo ale když děkuji dobrý den",
	hu: "a az és hogy nem is egy ez de van meg volt már csak még mint ki köszönöm kérem szia vagyok lesz",
};

const LATIN_SETS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries([
	...Object.entries(STOP_WORDS).map(([language, words]) => [language, new Set(words)] as const),
	...Object.entries(MORE_STOP_WORDS).map(([language, words]) => [language, new Set(words.split(" "))] as const),
]);

function count(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

/**
 * The non-Latin script that holds enough of the letters, if one does. A shared script may stay undecided, and so
 * does mail with two such scripts.
 */
function languageOfScript(sample: string, letters: number): { language: string | null } | null {
	const holds = (pattern: RegExp) => count(sample, pattern) / letters >= MIN_SCRIPT_SHARE;
	const single = SINGLE_LANGUAGE_SCRIPTS.filter(([pattern]) => holds(pattern));
	const shared = SHARED_SCRIPTS.filter(([pattern]) => holds(pattern));
	if (single.length + shared.length > 1) return { language: null };
	if (single.length) return { language: single[0][1] };
	return shared.length ? { language: shared[0][1](sample) } : null;
}

function languageOfLatinWords(sample: string, letters: number): string | null {
	if (count(sample, /\p{Script=Latin}/gu) / letters < MIN_LATIN_SHARE) return null;
	const words = sample.match(LATIN_WORD) ?? [];
	return words.length < MIN_LANGUAGE_WORDS ? null : leadingLanguage(words, LATIN_SETS);
}

/** The ISO 639-1 code of a message's language, or null when the text does not say so clearly. */
export function detectMessageLanguage(text: string): string | null {
	const sample = text.slice(0, SAMPLE_CHARS).replace(URL_PATTERN, " ").replace(EMAIL_PATTERN, " ");
	const letters = count(sample, LETTER);
	if (letters < MIN_SCRIPT_LETTERS) return null;
	const script = languageOfScript(sample, letters);
	return script ? script.language : languageOfLatinWords(sample, letters);
}

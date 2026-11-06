/** The languages the style profile tells apart; anything else is `other`. */
export type StyleLanguage = "en" | "nl" | "de" | "fr" | "es" | "other";

export const LANGUAGE_NAMES: Record<Exclude<StyleLanguage, "other">, string> = {
	en: "English",
	nl: "Dutch",
	de: "German",
	fr: "French",
	es: "Spanish",
};

// About forty of each language's most frequent words, chosen to overlap little with the others.
export const STOP_WORDS: Record<Exclude<StyleLanguage, "other">, string[]> = {
	en: "the and to of a in is that for it you with on as are this be at have was but not your we can will from they or if would there about what so my me our an all just know do".split(
		" ",
	),
	nl: "de het een en van is dat niet je ik op te zijn met voor er maar om ook als wat naar dan nog bij wel geen kan wij jij hij zij mijn uw ons wordt worden heb hebben deze dit".split(
		" ",
	),
	de: "der die das und ist nicht ich es ein eine zu den mit sich auf für im dem von sie wir auch wie aber noch nur oder wenn bei mir dass haben wird kann sind mein ihr euch".split(
		" ",
	),
	fr: "le la les et est un une des pas je que qui en du dans pour ce il sur avec ne vous nous mais ou au se plus sont son cette ont être faire bien aussi très votre".split(
		" ",
	),
	es: "el la los las y es un una que de en no por con para se lo le su al del pero como más este esta muy también hay estoy tengo usted ustedes nosotros gracias".split(
		" ",
	),
};

const SETS = Object.fromEntries(
	Object.entries(STOP_WORDS).map(([language, words]) => [language, new Set(words)]),
) as Record<Exclude<StyleLanguage, "other">, Set<string>>;
export const MIN_LANGUAGE_WORDS = 20;

/**
 * The language with the most stop words, when they make up at least 15% of the words and it leads the runner-up
 * clearly; else null.
 */
export function leadingLanguage<T extends string>(
	words: readonly string[],
	sets: Readonly<Record<T, ReadonlySet<string>>>,
): T | null {
	const lower = words.map((word) => word.toLowerCase());
	const scores = (Object.keys(sets) as T[])
		.map((language) => ({ language, hits: lower.filter((word) => sets[language].has(word)).length }))
		.sort((a, b) => b.hits - a.hits);
	const [best, second] = scores;
	if (best.hits < words.length * 0.15 || best.hits < second.hits * 1.5) return null;
	return best.language;
}

/** The language of a message from a stop-word count (`leadingLanguage`), or null for fewer than 20 words. */
export function detectLanguage(words: readonly string[]): StyleLanguage | null {
	if (words.length < MIN_LANGUAGE_WORDS) return null;
	return leadingLanguage(words, SETS) ?? "other";
}

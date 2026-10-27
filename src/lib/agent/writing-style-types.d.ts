import type { StyleLanguage } from "./writing-style-language-utils";

export type MetricKey =
	| "words"
	| "sentenceWords"
	| "paragraphs"
	| "questionShare"
	| "exclamationRate"
	| "emojiRate"
	| "listUse"
	| "greetingUse"
	| "signOffUse"
	| "formalAddress";

/** Welford's running state for one metric: count (capped), mean and sum of squared differences. */
export type WelfordState = { n: number; mean: number; m2: number };

/** One sent message's measurements; a null value leaves its metric unchanged. */
export type StyleMeasurement = {
	values: Record<MetricKey, number | null>;
	greeting: string | null;
	signOff: string | null;
	language: StyleLanguage | null;
};

/** A stored profile: statistics and anonymised forms only, never text. */
export type WritingStyleProfileState = {
	sampleCount: number;
	stats: Partial<Record<MetricKey, WelfordState>>;
	greetings: Record<string, number>;
	signOffs: Record<string, number>;
	languages: Record<string, number>;
};

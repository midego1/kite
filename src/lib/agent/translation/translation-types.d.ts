import type { SummaryState } from "../summaries/summary-types";

/**
 * One piece of a message that can be translated. `start` and `end` are its place in the stored body; `text` is what
 * the model reads, and `pre` and `post` the white space around it, which stays.
 */
export type TranslationSlot = {
	start: number;
	end: number;
	text: string;
	pre: string;
	post: string;
	/** Part of the quoted history, translated only when asked. */
	quoted: boolean;
};

export type TranslationSource = {
	format: "html" | "text";
	/** The stored body the slots point into; for text, with its line ends normalised. */
	source: string;
	slots: TranslationSlot[];
};

/** The parts of a message one model request carries, as slot indexes, and whether the cap left any out. */
export type TranslationPlan = { chunks: number[][]; cut: boolean };

export type TranslationPromptInput = {
	/** Only in the first request of a message. */
	subject: string | null;
	segments: string[];
	/** ISO 639-1 code of the target language. */
	target: string;
	nonce?: string;
};

/** A checked answer to one request: plain text, one piece per piece sent. */
export type CheckedTranslation = { language: string; subject: string | null; segments: string[] };

/** The stored row's `text`: `segments` follows the source's slots, null for a slot not translated. */
export type StoredTranslation = { from: string; subject: string | null; segments: (string | null)[] };

/** A translated message as the reader shows it. Everything in it goes through the same sanitizer as the original. */
export type MessageTranslation = {
	target: string;
	/** ISO 639-1 code of the original, or `und`. */
	sourceLanguage: string;
	subject: string | null;
	/** The translated HTML body, or null for a plain-text message. */
	html: string | null;
	/** The translated text body, or null for an HTML message. */
	text: string | null;
	/** The message was too long: the end stays in the original language. */
	cut: boolean;
	/** Quoted history was left out and can be asked for. */
	quotedPending: boolean;
	model: string | null;
};

export type TranslationState = {
	translation: MessageTranslation | null;
	reason?: SummaryState["reason"];
	migrationPending?: boolean;
};

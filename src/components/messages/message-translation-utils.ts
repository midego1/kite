import { translateLanguageOptions } from "@/components/compose/write-with-kite-utils";
import { MAILBOX_AI_OFF_TEXT } from "@/lib/agent/mailbox-ai-utils";
import type { SummaryState } from "@/lib/agent/summaries/summary-types";
import {
	isSummaryEligible,
	languageName,
	primaryLanguage,
	UNKNOWN_LANGUAGE,
} from "@/lib/agent/summaries/summary-utils";
import { getLatestEmailContent, htmlToReadableText } from "@/lib/email/reply-content-utils";
import type { TranslationAvailability, TranslationBody } from "./message-translation-types";

const DEFAULT_TARGET = "en";
/** Norwegian's written forms read as one language here, as the detector cannot tell them apart. */
const SAME_LANGUAGE: Record<string, string> = { nb: "no", nn: "no" };

/** The primary codes of the browser's languages, in order: every one of them is a language this person reads. */
export function readingLanguages(languages: readonly string[]): string[] {
	const codes = languages.map(primaryLanguage).map((code) => (code ? (SAME_LANGUAGE[code] ?? code) : null));
	return [...new Set(codes.filter((code): code is string => !!code))];
}

/** The language to translate into: the one chosen before, else the browser's first, else English. */
export function translationTarget(chosen: string | null, reading: readonly string[]): string {
	return chosen ?? reading[0] ?? DEFAULT_TARGET;
}

/** Whether the quiet bar offers a translation: a language Kite is sure of, and one this person does not read. */
export function offersTranslation(detected: string | null, reading: readonly string[], target: string): boolean {
	return !!detected && detected !== target && !reading.includes(detected);
}

/** The text the local detection reads: the subject and the message's own words, without its quoted history. */
export function translationSample(body: TranslationBody): string {
	const text = body.textBody?.trim() ? body.textBody : htmlToReadableText(body.htmlBody);
	return `${body.subject ?? ""}\n${getLatestEmailContent(text)}`;
}

/** Write with Kite's list, with the chosen language in it even when it came from another browser. */
export function translationTargets(
	browserLanguage: string | undefined,
	target: string,
): { code: string; name: string }[] {
	// A browser language without a two-letter code (`fil`) has nothing the translation route could store it under.
	const options = translateLanguageOptions(browserLanguage).filter((option) => option.code.length === 2);
	return options.some((option) => option.code === target)
		? options
		: [{ code: target, name: languageName(target) }, ...options];
}

/**
 * Whether Translate works for a message: the same conditions as Summarize, read from the same state. Without a
 * message, whether it works in this mailbox at all, for the conversation's cards to check their own message against.
 */
export function translationAvailability(
	state: SummaryState | null,
	message?: { status: string; spamVerdict?: string | null } | null,
): TranslationAvailability {
	if (state?.reason === "mailbox_ai_off") return "ai_off";
	// `not_eligible` is about the open message alone: a later message of the conversation may still be translated.
	const open = state?.eligible || state?.reason === "not_eligible";
	if (!open || state?.migrationPending) return "hidden";
	return !message || isSummaryEligible(message) ? "ready" : "hidden";
}

/** "Translated from Thai", or without the language when neither the model nor Kite could tell. */
export function translatedFromLabel(language: string): string {
	return language === UNKNOWN_LANGUAGE ? "Translated" : `Translated from ${languageName(language)}`;
}

/** Why the menu entry does nothing, for the one state in which it stays visible. */
export function translationDisabledReason(availability: TranslationAvailability): string | undefined {
	return availability === "ai_off" ? MAILBOX_AI_OFF_TEXT : undefined;
}

/** The list with `language` in it or, when it was there, without it. */
export function toggledLanguage(languages: readonly string[], language: string): string[] {
	return languages.includes(language) ? languages.filter((code) => code !== language) : [...languages, language];
}

export function translationUrl(messageId: string, target?: string): string {
	const url = `/api/messages/${encodeURIComponent(messageId)}/translation`;
	return target ? `${url}?target=${encodeURIComponent(target)}` : url;
}

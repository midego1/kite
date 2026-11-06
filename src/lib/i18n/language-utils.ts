import type { LayoutInterfaceLanguage } from "@/lib/preferences/layout-types";
import type { InterfaceLanguage } from "./i18n-types";

export const INTERFACE_LANGUAGE_STORAGE_KEY = "kite-interface-language";
export const DEFAULT_INTERFACE_LANGUAGE: LayoutInterfaceLanguage = "auto";

/** The languages the interface is translated into. A language's own name is never translated. */
export const INTERFACE_LANGUAGES: { value: InterfaceLanguage; label: string }[] = [
	{ value: "en", label: "English" },
	{ value: "nl", label: "Nederlands" },
	{ value: "ar", label: "العربية" },
];

const TRANSLATED = new Set<string>(INTERFACE_LANGUAGES.map((language) => language.value));

export function isInterfaceLanguageChoice(value: unknown): value is LayoutInterfaceLanguage {
	return value === "auto" || (typeof value === "string" && TRANSLATED.has(value));
}

export function parseInterfaceLanguage(stored: string | null): LayoutInterfaceLanguage {
	return isInterfaceLanguageChoice(stored) ? stored : DEFAULT_INTERFACE_LANGUAGE;
}

/** The language part of a language tag, in lower case: `nl` for `nl-BE`. */
function primarySubtag(language: string | null | undefined): string {
	return (language ?? "").split(/[-_]/)[0]!.toLowerCase();
}

/** Automatic takes the browser's first language when Kite speaks it, and English otherwise. */
export function resolveInterfaceLanguage(
	preference: LayoutInterfaceLanguage,
	browserLanguage: string | null | undefined,
): InterfaceLanguage {
	if (preference !== "auto") return preference;
	const browser = primarySubtag(browserLanguage);
	return TRANSLATED.has(browser) ? (browser as InterfaceLanguage) : "en";
}

/**
 * The locale for dates and numbers. English keeps the browser's own (undefined), as it always has; a translation uses
 * the browser's regional variant when it is the same language (`nl-BE`), and the plain language otherwise.
 */
export function interfaceLocale(
	language: InterfaceLanguage,
	browserLanguage: string | null | undefined,
): string | undefined {
	if (language === "en") return undefined;
	return primarySubtag(browserLanguage) === language ? (browserLanguage ?? language) : language;
}

/** The inline equivalent of `resolveInterfaceLanguage`, for the script that runs before the page paints. */
export function languageBootstrapExpression(saved: string, browser: string): string {
	const known = JSON.stringify(INTERFACE_LANGUAGES.map((language) => language.value));
	return `(${known}.includes(${saved}) ? ${saved} : ${known}.includes(${browser}.split(/[-_]/)[0].toLowerCase()) ? ${browser}.split(/[-_]/)[0].toLowerCase() : "en")`;
}

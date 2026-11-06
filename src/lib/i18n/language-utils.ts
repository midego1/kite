import type { LayoutInterfaceLanguage } from "@/lib/preferences/layout-types";
import type { InterfaceLanguage } from "./i18n-types";

export const INTERFACE_LANGUAGE_STORAGE_KEY = "kite-interface-language";
export const DEFAULT_INTERFACE_LANGUAGE: LayoutInterfaceLanguage = "auto";

/**
 * The languages the interface is translated into. A language's own name is never translated. `automatic` says Automatic
 * may pick it from the browser: Arabic is an unreviewed draft (`src/locales/GLOSSARY.md`), so for now only someone who
 * chooses it gets it. Give it `automatic: true` once a native speaker has reviewed it.
 */
export const INTERFACE_LANGUAGES: { value: InterfaceLanguage; label: string; automatic: boolean }[] = [
	{ value: "en", label: "English", automatic: true },
	{ value: "nl", label: "Nederlands", automatic: true },
	{ value: "ar", label: "العربية", automatic: false },
];

const TRANSLATED = new Set<string>(INTERFACE_LANGUAGES.map((language) => language.value));
const AUTOMATIC = new Set<string>(
	INTERFACE_LANGUAGES.filter((language) => language.automatic).map((language) => language.value),
);

/**
 * Pages anyone can open without an account: the home page, sign-in and setup, booking and contact pages and public Drive
 * links. They are not translated yet, so they stay English and left to right whatever the language setting says, unless
 * this browser explicitly chose a Direction.
 */
const UNTRANSLATED_PAGE =
	/^\/(?:$|(?:login|register|setup|onboarding|forgot-password|reset-password|book|c|d)(?:\/|$))/;

export function isUntranslatedPage(pathname: string): boolean {
	return UNTRANSLATED_PAGE.test(pathname);
}

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

/** Automatic takes the browser's first language when it is one Automatic may pick, and English otherwise. @public Exercised by the unit tests. */
export function resolveInterfaceLanguage(
	preference: LayoutInterfaceLanguage,
	browserLanguage: string | null | undefined,
): InterfaceLanguage {
	if (preference !== "auto") return preference;
	const browser = primarySubtag(browserLanguage);
	return AUTOMATIC.has(browser) ? (browser as InterfaceLanguage) : "en";
}

/** The language a page shows: the setting's, or English on a page that is not translated. */
export function pageLanguage(
	preference: LayoutInterfaceLanguage,
	browserLanguage: string | null | undefined,
	pathname: string,
): InterfaceLanguage {
	return isUntranslatedPage(pathname) ? "en" : resolveInterfaceLanguage(preference, browserLanguage);
}

/**
 * The locale for dates and numbers. English keeps the browser's own (undefined), as it always has; a translation uses
 * the browser's regional variant when it is the same language (`nl_BE` reads as `nl-BE`), and the plain language when the
 * browser's tag is another language or not one `Intl` accepts.
 */
export function interfaceLocale(
	language: InterfaceLanguage,
	browserLanguage: string | null | undefined,
): string | undefined {
	if (language === "en") return undefined;
	if (primarySubtag(browserLanguage) !== language) return language;
	try {
		return Intl.getCanonicalLocales(browserLanguage!.replaceAll("_", "-"))[0] ?? language;
	} catch {
		return language;
	}
}

/** The inline equivalent of `pageLanguage`, for the script that runs before the page paints. */
export function languageBootstrapExpression(saved: string, browser: string, pathname: string): string {
	const known = JSON.stringify([...TRANSLATED]);
	const automatic = JSON.stringify([...AUTOMATIC]);
	const primary = `${browser}.split(/[-_]/)[0].toLowerCase()`;
	return `(${UNTRANSLATED_PAGE}.test(${pathname}) ? "en" : ${known}.includes(${saved}) ? ${saved} : ${automatic}.includes(${primary}) ? ${primary} : "en")`;
}

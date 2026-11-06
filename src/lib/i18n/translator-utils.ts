import type { InterfaceLanguage, MessageCatalog, MessageValues, Translator } from "./i18n-types";
import { formatMessage, type MessageFormats } from "./message-format-utils";

/** A key may start with `context|` to keep two meanings of one English word apart: `folder|Archive`. */
function sourceText(key: string): string {
	return key.slice(key.indexOf("|") + 1);
}

/**
 * Keys are the English source strings, so English needs no catalog and a key a catalog does not have falls back to
 * English on its own. `locale` is for numbers; the plural rules always come from the language itself.
 */
export function createTranslator(
	language: InterfaceLanguage,
	locale: string | undefined,
	catalog: MessageCatalog,
): Translator {
	const formats: MessageFormats = {
		plural: new Intl.PluralRules(language),
		number: new Intl.NumberFormat(locale),
	};
	const t = (key: string, values: MessageValues = {}) =>
		formatMessage(catalog[key] || sourceText(key), values, formats);
	return { language, locale, t };
}

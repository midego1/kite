/** Values a message can interpolate; numbers are formatted for the interface language. */
export type MessageValues = Record<string, string | number>;

/** A translation catalog: the English source string (with its `context|` prefix, if any) to its translation. */
export type MessageCatalog = Record<string, string>;

export type Translate = (key: string, values?: MessageValues) => string;

export type InterfaceLanguage = "en" | "nl" | "ar";

/** The language in use and how to format for it. */
export interface Translator {
	language: InterfaceLanguage;
	/** For `Intl` and `toLocale*`; undefined keeps the browser's own locale, which is what English has always used. */
	locale: string | undefined;
	t: Translate;
}

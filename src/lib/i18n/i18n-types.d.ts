/** Values a message can interpolate; numbers are formatted for the interface language. */
export type MessageValues = Record<string, string | number>;

/** A translation catalog: the English source string (with its `context|` prefix, if any) to its translation. */
export type MessageCatalog = Record<string, string>;

/** A string marked with `msg()`, which the catalog check can see; only a literal or one of these can be translated. */
export type MessageKey = string & { readonly __messageKey: true };

/** `K` when it is a literal or a `MessageKey`; a plain `string` asks for a `MessageKey`, so it does not compile. */
export type TranslationKey<K extends string> = K & (string extends K ? MessageKey : K);

export type Translate = <K extends string>(key: TranslationKey<K>, values?: MessageValues) => string;

export type InterfaceLanguage = "en" | "nl" | "ar";

/** The language in use and how to format for it. */
export interface Translator {
	language: InterfaceLanguage;
	/** For `Intl` and `toLocale*`; undefined keeps the browser's own locale, which is what English has always used. */
	locale: string | undefined;
	t: Translate;
}

import type { MessageValues, Translator } from "./i18n-types";
import { createTranslator } from "./translator-utils";

const ENGLISH = createTranslator("en", undefined, {});

let current: Translator = ENGLISH;
const listeners = new Set<() => void>();

export function subscribeToTranslator(onChange: () => void): () => void {
	listeners.add(onChange);
	return () => listeners.delete(onChange);
}

export const currentTranslator = (): Translator => current;

/** What the server renders and hydration starts from: text on the page is always English until the provider ran. */
export const englishTranslator = (): Translator => ENGLISH;

export function setTranslator(next: Translator): void {
	if (next === current) return;
	current = next;
	for (const listener of listeners) listener();
}

/**
 * Translates outside a component, for helpers called while rendering. A component calls `useT()` instead, so a language
 * change draws it again.
 */
export function t(key: string, values?: MessageValues): string {
	return current.t(key, values);
}

/**
 * Marks a string in a table as translatable without translating it yet: the table stays a constant and whoever draws
 * the entry calls `t(entry.label)`. The catalog check finds strings through this mark.
 */
export const msg = <T extends string>(key: T): T => key;

/** The locale for `Intl` and `toLocale*` calls; undefined (the browser's own) in English. */
export const currentLocale = (): string | undefined => current.locale;

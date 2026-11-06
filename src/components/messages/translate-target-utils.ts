/** The language the reader translates mail into, an ISO 639-1 code; it follows the account as a layout choice. */
export const TRANSLATE_TO_STORAGE_KEY = "kite-translate-to";
/** The languages the reader no longer offers to translate, comma-separated; a layout choice too. */
export const TRANSLATE_NEVER_STORAGE_KEY = "kite-translate-never";
/** Fired when either choice changes in this tab. */
export const TRANSLATE_CHOICE_CHANGE_EVENT = "kite:translate-choice-changed";

const LANGUAGE_CODE = /^[a-z]{2}$/;

/** A stored target as a code; null when none was made or it is malformed. */
export function parseTranslateTarget(stored: string | null): string | null {
	return stored && LANGUAGE_CODE.test(stored) ? stored : null;
}

/** A stored list as codes; anything malformed is left out. */
export function parseTranslateNever(stored: string | null): string[] {
	return (stored ?? "").split(",").filter((code) => LANGUAGE_CODE.test(code));
}

/** The stored text of a choice, or null with blocked storage. */
export function readTranslateChoice(storageKey: string): string | null {
	try {
		return localStorage.getItem(storageKey);
	} catch {
		return null;
	}
}

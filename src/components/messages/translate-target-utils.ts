/** The language the reader translates mail into, an ISO 639-1 code; it follows the account as a layout choice. */
export const TRANSLATE_TO_STORAGE_KEY = "kite-translate-to";
/** Fired when the choice changes in this tab. */
export const TRANSLATE_TO_CHANGE_EVENT = "kite:translate-to-changed";

const LANGUAGE_CODE = /^[a-z]{2}$/;

/** The stored choice, or null when none was made, it is malformed or storage is blocked. */
export function readTranslateTarget(): string | null {
	try {
		const stored = localStorage.getItem(TRANSLATE_TO_STORAGE_KEY);
		return stored && LANGUAGE_CODE.test(stored) ? stored : null;
	} catch {
		return null;
	}
}

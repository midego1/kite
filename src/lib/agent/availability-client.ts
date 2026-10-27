/** Also the key other tabs watch, so enabling the assistant in one tab shows its buttons in the rest. */
export const ASSISTANT_AVAILABILITY_STORAGE_KEY = "kite-assistant-enabled";
const STORAGE_KEY = ASSISTANT_AVAILABILITY_STORAGE_KEY;

export function readInitialAssistantAvailability(): boolean | null {
	if (typeof window === "undefined") return null;
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		return stored === null ? null : stored === "true";
	} catch {
		return null;
	}
}

export function saveAssistantAvailability(enabled: boolean) {
	try {
		localStorage.setItem(STORAGE_KEY, String(enabled));
	} catch {
		/* Storage is optional. */
	}
}

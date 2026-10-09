const STORAGE_KEY = "kite-message-list-visible";
const WITH_ASSISTANT_KEY = "kite-message-list-with-assistant";
export const MESSAGE_LIST_VISIBILITY_EVENT = "kite:message-list-visibility";

export function readInitialMessageListVisible() {
	if (typeof window === "undefined") return true;
	try {
		return localStorage.getItem(STORAGE_KEY) !== "false";
	} catch {
		return true;
	}
}

export function saveMessageListVisible(visible: boolean) {
	try {
		localStorage.setItem(STORAGE_KEY, String(visible));
	} catch {
		/* Storage is optional. */
	}
	if (typeof window !== "undefined") window.dispatchEvent(new Event(MESSAGE_LIST_VISIBILITY_EVENT));
}

/** Whether the list stays beside an open message while the assistant panel is open; off by default to make room. */
export function readMessageListWithAssistant() {
	if (typeof window === "undefined") return false;
	try {
		return localStorage.getItem(WITH_ASSISTANT_KEY) === "true";
	} catch {
		return false;
	}
}

export function saveMessageListWithAssistant(visible: boolean) {
	try {
		localStorage.setItem(WITH_ASSISTANT_KEY, String(visible));
	} catch {
		/* Storage is optional. */
	}
	if (typeof window !== "undefined") window.dispatchEvent(new Event(MESSAGE_LIST_VISIBILITY_EVENT));
}

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "kite-conversation-view";
const CHANGE_EVENT = "kite:conversation-view-changed";

/** Whether lists are grouped by conversation, readable outside React (e.g. to preload a list). */
export function readConversationViewEnabled(): boolean {
	return readStored();
}

function readStored(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
}

/**
 * Whether lists collapse each conversation to one row. On by default and
 * remembered per browser; every open list follows a change immediately.
 */
export function useConversationView(): [boolean, (next: boolean) => void] {
	const [enabled, setEnabled] = useState(true);

	useEffect(() => {
		const sync = () => setEnabled(readStored());
		sync();
		window.addEventListener(CHANGE_EVENT, sync);
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(CHANGE_EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, []);

	const update = useCallback((next: boolean) => {
		try {
			localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
		} catch {
			// Private mode or blocked storage: the toggle still applies for this page.
		}
		setEnabled(next);
		window.dispatchEvent(new Event(CHANGE_EVENT));
	}, []);

	return [enabled, update];
}

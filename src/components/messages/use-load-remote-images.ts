import { useCallback, useLayoutEffect, useState } from "react";

const STORAGE_KEY = "kite-load-remote-images";
const CHANGE_EVENT = "kite:load-remote-images-changed";

function readStored() {
	try {
		return localStorage.getItem(STORAGE_KEY) === "on";
	} catch {
		return false;
	}
}

/** Whether messages load remote images without asking. Off by default: remote images can track reads. */
export function useLoadRemoteImages(): [boolean, (enabled: boolean) => void] {
	const [enabled, setEnabled] = useState(false);

	useLayoutEffect(() => {
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
			// The preference still applies until this page is closed.
		}
		setEnabled(next);
		window.dispatchEvent(new Event(CHANGE_EVENT));
	}, []);

	return [enabled, update];
}

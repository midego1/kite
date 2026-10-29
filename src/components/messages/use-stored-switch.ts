import { useCallback, useLayoutEffect, useState } from "react";

/** Reads an on/off choice stored as `on` or `off`; anything else, or blocked storage, is the default. */
export function readStoredSwitch(storageKey: string, defaultOn: boolean): boolean {
	try {
		const stored = localStorage.getItem(storageKey);
		return defaultOn ? stored !== "off" : stored === "on";
	} catch {
		return defaultOn;
	}
}

/**
 * An on/off choice remembered in this browser. Every open view follows a change at once: this tab through
 * `changeEvent`, other tabs through the storage event. `onChange` runs after a change made here.
 */
export function useStoredSwitch(
	storageKey: string,
	changeEvent: string,
	defaultOn: boolean,
	onChange?: (next: boolean) => void,
): [boolean, (next: boolean) => void] {
	const [enabled, setEnabled] = useState(defaultOn);

	useLayoutEffect(() => {
		// Only readable in the browser, and applied before paint.
		const sync = () => setEnabled(readStoredSwitch(storageKey, defaultOn));
		sync();
		window.addEventListener(changeEvent, sync);
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(changeEvent, sync);
			window.removeEventListener("storage", sync);
		};
	}, [storageKey, changeEvent, defaultOn]);

	const update = useCallback(
		(next: boolean) => {
			try {
				localStorage.setItem(storageKey, next ? "on" : "off");
			} catch {
				// Private mode or blocked storage: the choice still applies until this page is closed.
			}
			setEnabled(next);
			window.dispatchEvent(new Event(changeEvent));
			onChange?.(next);
		},
		[storageKey, changeEvent, onChange],
	);

	return [enabled, update];
}

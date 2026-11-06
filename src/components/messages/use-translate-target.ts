import { useCallback, useLayoutEffect, useState } from "react";
import { queueLayoutSave } from "@/components/layout-preferences-client";
import { LAYOUT_PREFERENCES_APPLIED_EVENT } from "@/components/layout-preferences-utils";
import { readTranslateTarget, TRANSLATE_TO_CHANGE_EVENT, TRANSLATE_TO_STORAGE_KEY } from "./translate-target-utils";

/** A choice storage refused, kept for this page so the open views do not fall back to the old one. */
let unstored: string | null = null;

/**
 * The language this user chose for translating mail, null until they choose one. Remembered in the browser and
 * saved to the account like the layout choices; every open view follows a change at once.
 */
export function useTranslateTarget(): [string | null, (next: string) => void] {
	const [target, setTarget] = useState<string | null>(null);

	useLayoutEffect(() => {
		const sync = () => setTarget(unstored ?? readTranslateTarget());
		sync();
		const events = [TRANSLATE_TO_CHANGE_EVENT, LAYOUT_PREFERENCES_APPLIED_EVENT, "storage"];
		for (const event of events) window.addEventListener(event, sync);
		return () => {
			for (const event of events) window.removeEventListener(event, sync);
		};
	}, []);

	const update = useCallback((next: string) => {
		try {
			localStorage.setItem(TRANSLATE_TO_STORAGE_KEY, next);
			unstored = null;
		} catch {
			// Private mode or blocked storage: the choice still applies until this page is closed.
			unstored = next;
		}
		setTarget(next);
		window.dispatchEvent(new Event(TRANSLATE_TO_CHANGE_EVENT));
		queueLayoutSave({ translateTo: next });
	}, []);

	return [target, update];
}

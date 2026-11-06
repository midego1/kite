import { useCallback, useLayoutEffect, useState } from "react";
import { queueLayoutSave } from "@/components/layout-preferences-client";
import { LAYOUT_PREFERENCES_APPLIED_EVENT } from "@/components/layout-preferences-utils";
import { readTranslateTarget, TRANSLATE_TO_CHANGE_EVENT, TRANSLATE_TO_STORAGE_KEY } from "./translate-target-utils";

/**
 * The language this user chose for translating mail, null until they choose one. Remembered in the browser and
 * saved to the account like the layout choices; every open view follows a change at once.
 */
export function useTranslateTarget(): [string | null, (next: string) => void] {
	const [target, setTarget] = useState<string | null>(null);

	useLayoutEffect(() => {
		const sync = () => setTarget(readTranslateTarget());
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
		} catch {
			// Private mode or blocked storage: the choice still applies until this page is closed.
		}
		setTarget(next);
		window.dispatchEvent(new Event(TRANSLATE_TO_CHANGE_EVENT));
		queueLayoutSave({ translateTo: next });
	}, []);

	return [target, update];
}

import { useCallback, useLayoutEffect, useState } from "react";
import { queueLayoutSave } from "@/components/layout-preferences-client";
import { LAYOUT_PREFERENCES_APPLIED_EVENT } from "@/components/layout-preferences-utils";
import {
	parseTranslateNever,
	parseTranslateTarget,
	readTranslateChoice,
	TRANSLATE_CHOICE_CHANGE_EVENT,
	TRANSLATE_NEVER_STORAGE_KEY,
	TRANSLATE_TO_STORAGE_KEY,
} from "./translate-target-utils";

/** Choices storage refused, kept for this page so the open views do not fall back to the old ones. */
const unstored = new Map<string, string>();

/**
 * One translation choice of this user. Remembered in the browser and saved to the account like the layout choices;
 * every open view follows a change at once.
 */
function useTranslateChoice<T>(
	storageKey: string,
	parse: (stored: string | null) => T,
	format: (value: T) => string,
	save: (value: T) => void,
): [T, (next: T) => void] {
	const [value, setValue] = useState<T>(() => parse(null));

	useLayoutEffect(() => {
		const sync = () => setValue(parse(unstored.get(storageKey) ?? readTranslateChoice(storageKey)));
		sync();
		const events = [TRANSLATE_CHOICE_CHANGE_EVENT, LAYOUT_PREFERENCES_APPLIED_EVENT, "storage"];
		for (const event of events) window.addEventListener(event, sync);
		return () => {
			for (const event of events) window.removeEventListener(event, sync);
		};
	}, [storageKey, parse]);

	const update = useCallback(
		(next: T) => {
			try {
				localStorage.setItem(storageKey, format(next));
				unstored.delete(storageKey);
			} catch {
				// Private mode or blocked storage: the choice still applies until this page is closed.
				unstored.set(storageKey, format(next));
			}
			setValue(next);
			window.dispatchEvent(new Event(TRANSLATE_CHOICE_CHANGE_EVENT));
			save(next);
		},
		[storageKey, format, save],
	);

	return [value, update];
}

const sameText = (value: string | null) => value ?? "";
const saveTarget = (translateTo: string | null) => {
	if (translateTo) queueLayoutSave({ translateTo });
};
const joined = (languages: string[]) => languages.join(",");
const saveNever = (translateNever: string[]) => queueLayoutSave({ translateNever });

/** The language this user chose for translating mail, null until they choose one. */
export function useTranslateTarget() {
	return useTranslateChoice(TRANSLATE_TO_STORAGE_KEY, parseTranslateTarget, sameText, saveTarget);
}

/** The languages this user asked Kite not to offer to translate. */
export function useTranslateNever() {
	return useTranslateChoice(TRANSLATE_NEVER_STORAGE_KEY, parseTranslateNever, joined, saveNever);
}

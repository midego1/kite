"use client";

import { useSyncExternalStore } from "react";
import {
	APPEARANCE_CHANGED_EVENT,
	readAppearancePreference,
	saveAppearancePreference,
	type AppearancePreference,
} from "@/components/appearance-preferences";
import { queueLayoutSave } from "@/components/layout-preferences-client";
import { LAYOUT_PREFERENCES_APPLIED_EVENT } from "@/components/layout-preferences-utils";

function subscribe(onChange: () => void) {
	window.addEventListener(APPEARANCE_CHANGED_EVENT, onChange);
	window.addEventListener(LAYOUT_PREFERENCES_APPLIED_EVENT, onChange);
	window.addEventListener("storage", onChange);
	return () => {
		window.removeEventListener(APPEARANCE_CHANGED_EVENT, onChange);
		window.removeEventListener(LAYOUT_PREFERENCES_APPLIED_EVENT, onChange);
		window.removeEventListener("storage", onChange);
	};
}

export function useAppearancePreference<T extends string>(
	preference: AppearancePreference<T>,
): [T, (value: T) => void] {
	const value = useSyncExternalStore(
		subscribe,
		() => readAppearancePreference(preference),
		() => preference.defaultValue,
	);
	return [
		value,
		(next) => {
			saveAppearancePreference(preference, next);
			// A choice with a layout key follows the account (`layout-preferences-client.ts`).
			if (preference.layoutKey) queueLayoutSave({ [preference.layoutKey]: next });
		},
	];
}

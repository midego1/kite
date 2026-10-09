"use client";

import { useSyncExternalStore } from "react";
import {
	APPEARANCE_CHANGED_EVENT,
	readAppearancePreference,
	saveAppearancePreference,
	type AppearancePreference,
} from "@/components/appearance-preferences";

function subscribe(onChange: () => void) {
	window.addEventListener(APPEARANCE_CHANGED_EVENT, onChange);
	window.addEventListener("storage", onChange);
	return () => {
		window.removeEventListener(APPEARANCE_CHANGED_EVENT, onChange);
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
	return [value, (next) => saveAppearancePreference(preference, next)];
}

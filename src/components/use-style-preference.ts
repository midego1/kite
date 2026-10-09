"use client";

import { useSyncExternalStore } from "react";
import {
	DEFAULT_STYLE,
	isStylePreference,
	readStylePreference,
	saveStylePreference,
	STYLE_CHANGED_EVENT,
	type StylePreference,
} from "@/components/theme-utils";

// The last saved choice, so pickers still reflect it when localStorage is unavailable.
let sessionStyle: StylePreference | null = null;

function subscribeToStyle(onChange: () => void) {
	const sync = (event: Event) => {
		const detail = (event as CustomEvent<unknown>).detail;
		if (isStylePreference(detail)) sessionStyle = detail;
		onChange();
	};
	window.addEventListener(STYLE_CHANGED_EVENT, sync);
	window.addEventListener("storage", onChange);
	return () => {
		window.removeEventListener(STYLE_CHANGED_EVENT, sync);
		window.removeEventListener("storage", onChange);
	};
}

function getStyleSnapshot(): StylePreference {
	return sessionStyle ?? readStylePreference();
}

export function useStylePreference(): [StylePreference, (style: StylePreference) => void] {
	const style = useSyncExternalStore(subscribeToStyle, getStyleSnapshot, () => DEFAULT_STYLE);
	return [style, saveStylePreference];
}

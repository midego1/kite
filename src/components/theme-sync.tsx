"use client";

import { useEffect } from "react";
import {
	applyStyle,
	applyTheme,
	readStylePreference,
	readThemePreference,
	STYLE_CHANGED_EVENT,
	THEME_CHANGED_EVENT,
} from "@/components/theme-utils";
import { applyStoredAppearancePreferences } from "@/components/appearance-preferences";

// Keeps the html class and style in step with the saved preferences and, for "system", with the OS setting.
export function ThemeSync() {
	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const sync = () => {
			applyTheme(readThemePreference());
			applyStyle(readStylePreference());
			applyStoredAppearancePreferences();
		};
		sync();
		media.addEventListener("change", sync);
		window.addEventListener(THEME_CHANGED_EVENT, sync);
		window.addEventListener(STYLE_CHANGED_EVENT, sync);
		window.addEventListener("storage", sync);
		return () => {
			media.removeEventListener("change", sync);
			window.removeEventListener(THEME_CHANGED_EVENT, sync);
			window.removeEventListener(STYLE_CHANGED_EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, []);
	return null;
}

"use client";

import { useLayoutEffect } from "react";
import { LAYOUT_PREFERENCES_APPLIED_EVENT } from "@/components/layout-preferences-utils";
import { READING_LAYOUT_CHANGE_EVENT } from "@/components/messages/reading-layout-utils";
import { readInterfaceLanguage } from "@/components/messages/use-reading-layout";
import { applyInterfaceLanguage } from "@/lib/i18n/language-loader";

function applyStoredLanguage() {
	void applyInterfaceLanguage(readInterfaceLanguage(), navigator.language);
}

/**
 * Keeps the catalog and `<html lang>` on the stored choice. It runs after hydration, so the first client render stays
 * the English the server sent. Unlike a direction change, new text costs nothing that is being typed, so a change from
 * another tab or device applies as soon as it arrives.
 */
export function InterfaceLanguageSync() {
	useLayoutEffect(() => {
		applyStoredLanguage();
		window.addEventListener(READING_LAYOUT_CHANGE_EVENT, applyStoredLanguage);
		window.addEventListener(LAYOUT_PREFERENCES_APPLIED_EVENT, applyStoredLanguage);
		window.addEventListener("storage", applyStoredLanguage);
		return () => {
			window.removeEventListener(READING_LAYOUT_CHANGE_EVENT, applyStoredLanguage);
			window.removeEventListener(LAYOUT_PREFERENCES_APPLIED_EVENT, applyStoredLanguage);
			window.removeEventListener("storage", applyStoredLanguage);
		};
	}, []);
	return null;
}

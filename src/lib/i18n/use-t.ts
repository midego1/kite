"use client";

import { useSyncExternalStore } from "react";
import type { Translate } from "./i18n-types";
import { currentTranslator, englishTranslator, subscribeToTranslator } from "./translator";

/** The translate function of the interface language; a component that calls it is drawn again when the language changes. */
export function useT(): Translate {
	return useSyncExternalStore(subscribeToTranslator, currentTranslator, englishTranslator).t;
}

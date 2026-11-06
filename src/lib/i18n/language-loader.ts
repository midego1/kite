import type { LayoutInterfaceLanguage } from "@/lib/preferences/layout-types";
import { loadCatalog } from "./catalogs";
import type { InterfaceLanguage } from "./i18n-types";
import { interfaceLocale, resolveInterfaceLanguage } from "./language-utils";
import { currentTranslator, englishTranslator, setTranslator } from "./translator";
import { createTranslator } from "./translator-utils";

let wanted: InterfaceLanguage = "en";
let started = false;
let firstLoadRunning = false;
const listeners = new Set<() => void>();

function setFirstLoadRunning(running: boolean) {
	firstLoadRunning = running;
	for (const listener of listeners) listener();
}

export function subscribeToLanguageLoad(onChange: () => void): () => void {
	listeners.add(onChange);
	return () => listeners.delete(onChange);
}

/**
 * False while the page's first catalog is on its way, so the mailbox does not draw English for a moment. Only the first
 * one counts: a later switch must not take down a page someone is working in.
 */
export const isInterfaceLanguageReady = () => !firstLoadRunning;

/** Switches to a language, fetching its catalog once. A catalog that cannot load leaves English on the page. */
export async function applyInterfaceLanguage(
	preference: LayoutInterfaceLanguage,
	browserLanguage: string | null | undefined,
): Promise<void> {
	const language = resolveInterfaceLanguage(preference, browserLanguage);
	const first = !started;
	started = true;
	document.documentElement.lang = language;
	if (language === wanted && language === currentTranslator().language) return;
	wanted = language;
	if (language === "en") {
		setTranslator(englishTranslator());
		return;
	}
	if (first) setFirstLoadRunning(true);
	const translator = await loadCatalog(language).then(
		(catalog) => createTranslator(language, interfaceLocale(language, browserLanguage), catalog),
		// The chunk failed (offline, or a deploy replaced it): the next change or page load tries again.
		() => englishTranslator(),
	);
	if (wanted === language) setTranslator(translator);
	if (first) setFirstLoadRunning(false);
}

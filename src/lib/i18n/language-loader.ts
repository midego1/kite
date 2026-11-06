import type { LayoutInterfaceLanguage } from "@/lib/preferences/layout-types";
import { loadCatalog } from "./catalogs";
import type { InterfaceLanguage } from "./i18n-types";
import { interfaceLocale, isUntranslatedPage, pageLanguage } from "./language-utils";
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
 * False while the first catalog of a signed-in page is on its way, so the mailbox does not draw English for a moment.
 * Only that one counts: a later switch must not take down a page someone is working in.
 */
export const isInterfaceLanguageReady = () => !firstLoadRunning;

/**
 * Puts the page in its language, fetching the catalog once. A page that is not translated stays English, and leaving it
 * counts as a first load again. A catalog that cannot load leaves English on the page; the next change or page load tries
 * again.
 */
export async function applyInterfaceLanguage(
	preference: LayoutInterfaceLanguage,
	browserLanguage: string | null | undefined,
	pathname: string,
	load = loadCatalog,
): Promise<void> {
	const language = pageLanguage(preference, browserLanguage, pathname);
	const translated = !isUntranslatedPage(pathname);
	const first = translated && !started;
	started = translated;
	document.documentElement.lang = language;
	if (language === wanted && language === currentTranslator().language) return;
	wanted = language;
	if (language === "en") {
		setTranslator(englishTranslator());
		return;
	}
	if (first) setFirstLoadRunning(true);
	try {
		const catalog = await load(language);
		if (wanted === language)
			setTranslator(createTranslator(language, interfaceLocale(language, browserLanguage), catalog));
	} catch {
		if (wanted === language) setTranslator(englishTranslator());
	} finally {
		if (first) setFirstLoadRunning(false);
	}
}

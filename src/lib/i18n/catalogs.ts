import type { InterfaceLanguage, MessageCatalog } from "./i18n-types";

type TranslatedLanguage = Exclude<InterfaceLanguage, "en">;

/** One chunk per language, loaded only by someone reading it: English downloads no catalog at all. */
const CATALOG_LOADERS: Record<TranslatedLanguage, () => Promise<{ default: MessageCatalog }>> = {
	nl: () => import("@/locales/nl.json"),
	ar: () => import("@/locales/ar.json"),
};

export async function loadCatalog(language: TranslatedLanguage): Promise<MessageCatalog> {
	return (await CATALOG_LOADERS[language]()).default;
}

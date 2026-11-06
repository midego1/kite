import { INTERFACE_LANGUAGE_STORAGE_KEY, languageBootstrapExpression } from "@/lib/i18n/language-utils";
import { msg } from "@/lib/i18n/translator";
import type { LayoutInterfaceDirection } from "@/lib/preferences/layout-types";

export type InterfaceDirection = "ltr" | "rtl";

export const INTERFACE_DIRECTION_STORAGE_KEY = "kite-interface-direction";
export const DEFAULT_INTERFACE_DIRECTION: LayoutInterfaceDirection = "auto";
/** Fired when the user picks a direction in this tab, which applies at once. */
export const INTERFACE_DIRECTION_CHOSEN_EVENT = "kite:interface-direction-chosen";

export const INTERFACE_DIRECTION_OPTIONS: { value: LayoutInterfaceDirection; label: string; description: string }[] = [
	{
		value: "auto",
		label: msg("direction|Automatic"),
		description: msg("Follows the interface language: right to left for Arabic, left to right for the others."),
	},
	{
		value: "ltr",
		label: msg("Left to right"),
		description: msg("The menu on the left and text starting on the left."),
	},
	{
		value: "rtl",
		label: msg("Right to left"),
		description: msg("The menu on the right and text starting on the right."),
	},
];

/**
 * Languages written right to left, unless a script subtag says otherwise (`sd-Deva`, `ar-Latn`), and any language
 * explicitly in an RTL script (`pa-Arab`).
 */
const RTL_LANGUAGE =
	/^(?:(?:ar|arc|ckb|dv|fa|he|iw|ji|ks|ps|sd|ug|ur|yi)(?:-(?!latn|deva|cyrl)|$)|[a-z]{2,3}-(?:arab|hebr)\b)/i;

/** @public Exercised by the unit tests. */
export function isRtlLanguage(language: string | null | undefined): boolean {
	return RTL_LANGUAGE.test(language ?? "");
}

export function parseInterfaceDirection(stored: string | null): LayoutInterfaceDirection {
	return stored === "ltr" || stored === "rtl" || stored === "auto" ? stored : DEFAULT_INTERFACE_DIRECTION;
}

/**
 * Automatic follows the interface language, not the browser's: nobody gets a mirrored English interface unasked, and an
 * explicit choice always wins. `language` is the resolved interface language (`resolveInterfaceLanguage`).
 */
export function resolveInterfaceDirection(
	preference: LayoutInterfaceDirection,
	language: string | null | undefined,
): InterfaceDirection {
	if (preference !== "auto") return preference;
	return isRtlLanguage(language) ? "rtl" : "ltr";
}

/** What `<html dir>` says right now; left to right on the server and before the bootstrap script. */
export function documentDirection(): InterfaceDirection {
	return typeof document !== "undefined" && document.documentElement.dir === "rtl" ? "rtl" : "ltr";
}

/** Turns a physical horizontal distance into one along the reading direction, for drag and swipe code. */
export function toInlineDelta(physical: number): number {
	return documentDirection() === "rtl" ? -physical : physical;
}

/**
 * Horizontal arrow keys named by what they mean: the one pointing along the reading direction goes forward. Other
 * keys come back unchanged. For arrow handling that the Radix direction context does not reach.
 */
export function logicalArrowKey(key: string): string {
	if (documentDirection() !== "rtl") return key;
	if (key === "ArrowLeft") return "ArrowRight";
	if (key === "ArrowRight") return "ArrowLeft";
	return key;
}

/**
 * Runs in <head> before paint, so the first frame is already mirrored and `lang` is right (same approach as the theme).
 * Blocked storage only loses the stored choices. Keep it in sync with resolveInterfaceLanguage and
 * resolveInterfaceDirection.
 */
export const interfaceDirectionBootstrapScript = `(() => {
	let direction = null;
	let language = null;
	try {
		direction = localStorage.getItem(${JSON.stringify(INTERFACE_DIRECTION_STORAGE_KEY)});
		language = localStorage.getItem(${JSON.stringify(INTERFACE_LANGUAGE_STORAGE_KEY)});
	} catch {}
	const browser = navigator.language || "";
	const resolved = ${languageBootstrapExpression("language", "browser")};
	const rtl = direction === "rtl" || (direction !== "ltr" && ${RTL_LANGUAGE}.test(resolved));
	document.documentElement.lang = resolved;
	document.documentElement.dir = rtl ? "rtl" : "ltr";
})();`;

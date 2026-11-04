import type { LayoutInterfaceDirection } from "@/lib/preferences/layout-types";

export type InterfaceDirection = "ltr" | "rtl";

export const INTERFACE_DIRECTION_STORAGE_KEY = "kite-interface-direction";
export const DEFAULT_INTERFACE_DIRECTION: LayoutInterfaceDirection = "auto";

export const INTERFACE_DIRECTION_OPTIONS: { value: LayoutInterfaceDirection; label: string; description: string }[] = [
	{ value: "auto", label: "Automatic", description: "Follows your browser's language." },
	{ value: "ltr", label: "Left to right", description: "The menu on the left and text starting on the left." },
	{ value: "rtl", label: "Right to left", description: "The menu on the right and text starting on the right." },
];

/**
 * Languages written right to left, unless a script subtag says otherwise (`sd-Deva`, `ar-Latn`), and any language
 * explicitly in an RTL script (`pa-Arab`). Only the browser's first language counts: someone who reads Arabic as a
 * second language keeps the interface they chose first.
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

// Runs in <head> before paint, so the first frame is already mirrored (same approach as the theme). Blocked storage
// only loses the stored choice, not the browser language. Keep it in sync with resolveInterfaceDirection above.
export const interfaceDirectionBootstrapScript = `(() => {
	let saved = null;
	try {
		saved = localStorage.getItem(${JSON.stringify(INTERFACE_DIRECTION_STORAGE_KEY)});
	} catch {}
	const rtl = saved === "rtl" || (saved !== "ltr" && ${RTL_LANGUAGE}.test(navigator.language || ""));
	document.documentElement.dir = rtl ? "rtl" : "ltr";
})();`;

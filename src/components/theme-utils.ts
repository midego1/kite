export type ThemePreference = "light" | "dark" | "system";
export type StylePreference = "kite" | "classic";

export const THEME_STORAGE_KEY = "kite-theme";
export const THEME_CHANGED_EVENT = "kite:theme-changed";
export const STYLE_STORAGE_KEY = "kite-style";
export const STYLE_CHANGED_EVENT = "kite:style-changed";
export const DEFAULT_STYLE: StylePreference = "kite";

// Runs in <head> before paint, so the first frame already has the right theme and style (same approach
// as the sidebar width). Keep it in sync with resolveTheme/applyTheme/applyStyle below.
export const themeBootstrapScript = `(() => {
	try {
		const saved = localStorage.getItem("kite-theme");
		const preference = saved === "light" || saved === "dark" ? saved : "system";
		const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
		document.documentElement.classList.toggle("dark", dark);
		document.documentElement.classList.toggle("light", !dark);
		document.documentElement.dataset.style = localStorage.getItem("kite-style") === "classic" ? "classic" : "kite";
	} catch {}
})();`;

export function isStylePreference(value: unknown): value is StylePreference {
	return value === "kite" || value === "classic";
}

export function readStylePreference(): StylePreference {
	if (typeof window === "undefined") return DEFAULT_STYLE;
	try {
		const saved = localStorage.getItem(STYLE_STORAGE_KEY);
		return isStylePreference(saved) ? saved : DEFAULT_STYLE;
	} catch {
		return DEFAULT_STYLE;
	}
}

export function applyStyle(style: StylePreference): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.style = style;
}

export function saveStylePreference(style: StylePreference): void {
	try {
		if (style === DEFAULT_STYLE) localStorage.removeItem(STYLE_STORAGE_KEY);
		else localStorage.setItem(STYLE_STORAGE_KEY, style);
	} catch {
		// Storage can be unavailable in private windows; the style still applies for this page.
	}
	applyStyle(style);
	if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(STYLE_CHANGED_EVENT, { detail: style }));
}

export function isThemePreference(value: unknown): value is ThemePreference {
	return value === "light" || value === "dark" || value === "system";
}

export function readThemePreference(): ThemePreference {
	if (typeof window === "undefined") return "system";
	try {
		const saved = localStorage.getItem(THEME_STORAGE_KEY);
		return isThemePreference(saved) ? saved : "system";
	} catch {
		return "system";
	}
}

export function resolveTheme(preference: ThemePreference): "light" | "dark" {
	if (preference !== "system") return preference;
	if (typeof window === "undefined") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(preference: ThemePreference): void {
	if (typeof document === "undefined") return;
	const dark = resolveTheme(preference) === "dark";
	document.documentElement.classList.toggle("dark", dark);
	document.documentElement.classList.toggle("light", !dark);
}

export function saveThemePreference(preference: ThemePreference): void {
	try {
		if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
		else localStorage.setItem(THEME_STORAGE_KEY, preference);
	} catch {
		// Storage can be unavailable in private windows; the theme still applies for this page.
	}
	applyTheme(preference);
	if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: preference }));
}

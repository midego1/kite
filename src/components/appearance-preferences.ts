// No "use client" and no React hooks: the root layout (a Server Component) imports
// appearanceBootstrapScript as a plain string. The hook lives in use-appearance-preference.ts.

export type AppearancePreference<T extends string> = {
	storageKey: string;
	/** Attribute on <html> as `data-<attribute>`; the default value removes it. */
	attribute: string;
	defaultValue: T;
	options: { value: T; label: string }[];
};

export type FontPreference = "auto" | "manrope" | "geist" | "inter" | "system";
export type TextSizePreference = "small" | "default" | "large" | "larger";

export const APPEARANCE_CHANGED_EVENT = "kite:appearance-changed";

export const FONT_PREFERENCE: AppearancePreference<FontPreference> = {
	storageKey: "kite-font",
	attribute: "font",
	defaultValue: "auto",
	options: [
		{ value: "auto", label: "Match style" },
		{ value: "manrope", label: "Manrope" },
		{ value: "geist", label: "Geist" },
		{ value: "inter", label: "Inter" },
		{ value: "system", label: "System font" },
	],
};

export const TEXT_SIZE_PREFERENCE: AppearancePreference<TextSizePreference> = {
	storageKey: "kite-text-size",
	attribute: "text-size",
	defaultValue: "default",
	options: [
		{ value: "small", label: "Small" },
		{ value: "default", label: "Default" },
		{ value: "large", label: "Large" },
		{ value: "larger", label: "Larger" },
	],
};

export type AssistantLayoutPreference = "sidebar" | "floating";

export const ASSISTANT_LAYOUT_PREFERENCE: AppearancePreference<AssistantLayoutPreference> = {
	storageKey: "kite-assistant-layout",
	attribute: "assistant-layout",
	defaultValue: "sidebar",
	options: [
		{ value: "sidebar", label: "Side panel" },
		{ value: "floating", label: "Chat window" },
	],
};

export type AssistantStepsPreference = "live" | "collapsed" | "hidden";

export const ASSISTANT_STEPS_PREFERENCE: AppearancePreference<AssistantStepsPreference> = {
	storageKey: "kite-assistant-steps",
	attribute: "assistant-steps",
	defaultValue: "live",
	options: [
		{ value: "live", label: "Show while working" },
		{ value: "collapsed", label: "Collapsed" },
		{ value: "hidden", label: "Hidden" },
	],
};

export type AssistantDetailPreference = "minimal" | "emails" | "full";

export const ASSISTANT_DETAIL_PREFERENCE: AppearancePreference<AssistantDetailPreference> = {
	storageKey: "kite-assistant-detail",
	attribute: "assistant-detail",
	defaultValue: "emails",
	options: [
		{ value: "minimal", label: "Step names only" },
		{ value: "emails", label: "Steps and emails" },
		{ value: "full", label: "Everything" },
	],
};

export const APPEARANCE_PREFERENCES = [FONT_PREFERENCE, TEXT_SIZE_PREFERENCE] as const;

function isOption<T extends string>(preference: AppearancePreference<T>, value: unknown): value is T {
	return preference.options.some((option) => option.value === value);
}

export function readAppearancePreference<T extends string>(preference: AppearancePreference<T>): T {
	if (typeof window === "undefined") return preference.defaultValue;
	try {
		const saved = localStorage.getItem(preference.storageKey);
		return isOption(preference, saved) ? saved : preference.defaultValue;
	} catch {
		return preference.defaultValue;
	}
}

export function applyAppearancePreference<T extends string>(preference: AppearancePreference<T>, value: T): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (value === preference.defaultValue) root.removeAttribute(`data-${preference.attribute}`);
	else root.setAttribute(`data-${preference.attribute}`, value);
}

export function saveAppearancePreference<T extends string>(preference: AppearancePreference<T>, value: T): void {
	try {
		if (value === preference.defaultValue) localStorage.removeItem(preference.storageKey);
		else localStorage.setItem(preference.storageKey, value);
	} catch {
		// Storage can be unavailable in private windows; the choice still applies for this page.
	}
	applyAppearancePreference(preference, value);
	window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGED_EVENT));
}

export function applyStoredAppearancePreferences(): void {
	for (const preference of APPEARANCE_PREFERENCES) {
		applyAppearancePreference<string>(preference, readAppearancePreference<string>(preference));
	}
}

/** Runs in <head> before paint, mirroring applyStoredAppearancePreferences. */
export const appearanceBootstrapScript = `(() => {
	try {
		const prefs = ${JSON.stringify(
			APPEARANCE_PREFERENCES.map((preference) => ({
				key: preference.storageKey,
				attribute: preference.attribute,
				fallback: preference.defaultValue,
				values: preference.options.map((option) => option.value),
			})),
		)};
		for (const pref of prefs) {
			const saved = localStorage.getItem(pref.key);
			if (saved && saved !== pref.fallback && pref.values.includes(saved)) document.documentElement.setAttribute("data-" + pref.attribute, saved);
		}
	} catch {}
})();`;

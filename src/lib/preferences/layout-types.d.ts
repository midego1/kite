export type LayoutReadingPane = "none" | "right" | "below";
export type LayoutDensity = "default" | "comfortable" | "compact";
/** The Font choice under Settings → Appearance (`FONT_PREFERENCE` in `src/components/appearance-preferences.ts`). */
export type LayoutFont = "auto" | "manrope" | "geist" | "inter" | "system" | "opendyslexic";
/** Whether a dyslexia-friendly font also replaces the fonts of HTML mail (`EMAIL_FONT_PREFERENCE`). */
export type LayoutEmailFont = "original" | "reader";
/** Where a dyslexia-friendly font applies: reading text only, or the whole interface (`FONT_SCOPE_PREFERENCE`). */
export type LayoutFontScope = "text" | "everywhere";

/** The layout choices that follow the account; a key that is absent was never chosen. */
export interface LayoutPreferences {
	readingPane?: LayoutReadingPane;
	density?: LayoutDensity;
	conversationView?: boolean;
	/** The message list's width beside the reading pane, in pixels. */
	listWidth?: number;
	/** The message list's height above the reading pane, in pixels. */
	listHeight?: number;
	font?: LayoutFont;
	emailFont?: LayoutEmailFont;
	fontScope?: LayoutFontScope;
}

/** What `GET` and `PATCH /api/settings/layout` answer. */
export interface LayoutPreferencesResponse {
	/** False until migration 0080: the layout then stays in this browser only. */
	ready: boolean;
	/** Null when the account has never saved a layout. */
	layout: LayoutPreferences | null;
}

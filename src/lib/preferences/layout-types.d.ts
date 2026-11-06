export type LayoutReadingPane = "none" | "right" | "below";
export type LayoutDensity = "default" | "comfortable" | "compact";
/** The Font choice under Settings → Appearance (`FONT_PREFERENCE` in `src/components/appearance-preferences.ts`). */
export type LayoutFont = "auto" | "manrope" | "geist" | "inter" | "system" | "opendyslexic";
/** Whether a dyslexia-friendly font also replaces the fonts of HTML mail (`EMAIL_FONT_PREFERENCE`). */
export type LayoutEmailFont = "original" | "reader";
/** Where a dyslexia-friendly font applies: reading text only, or the whole interface (`FONT_SCOPE_PREFERENCE`). */
export type LayoutFontScope = "text" | "everywhere";
/** Which way the interface reads: `auto` follows the browser language (`interface-direction-utils.ts`). */
export type LayoutInterfaceDirection = "auto" | "ltr" | "rtl";
/** The interface language: `auto` follows the browser language (`src/lib/i18n/language-utils.ts`). */
export type LayoutInterfaceLanguage = "auto" | "en" | "nl" | "ar";

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
	interfaceDirection?: LayoutInterfaceDirection;
	interfaceLanguage?: LayoutInterfaceLanguage;
	/** The language the reader translates mail into, an ISO 639-1 code. */
	translateTo?: string;
	/** Languages the reader no longer offers to translate, as ISO 639-1 codes. */
	translateNever?: string[];
}

/** What `GET` and `PATCH /api/settings/layout` answer. */
export interface LayoutPreferencesResponse {
	/** False until migration 0080: the layout then stays in this browser only. */
	ready: boolean;
	/** Null when the account has never saved a layout. */
	layout: LayoutPreferences | null;
}

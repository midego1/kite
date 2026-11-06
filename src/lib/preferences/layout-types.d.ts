export type LayoutReadingPane = "none" | "right" | "below";
export type LayoutDensity = "default" | "comfortable" | "compact";
/** How the message list shows each row's mailbox and connected account: a small marker, the full chip, or nothing. */
export type LayoutListLabels = "compact" | "full" | "off";
/** The Font choice under Settings → Appearance (`FONT_PREFERENCE` in `src/components/appearance-preferences.ts`). */
export type LayoutFont = "auto" | "manrope" | "geist" | "inter" | "system" | "opendyslexic";
/** Whether a dyslexia-friendly font also replaces the fonts of HTML mail (`EMAIL_FONT_PREFERENCE`). */
export type LayoutEmailFont = "original" | "reader";
/** Where a dyslexia-friendly font applies: reading text only, or the whole interface (`FONT_SCOPE_PREFERENCE`). */
export type LayoutFontScope = "text" | "everywhere";
/** Which way the interface reads: `auto` follows the browser language (`interface-direction-utils.ts`). */
export type LayoutInterfaceDirection = "auto" | "ltr" | "rtl";

/** The colours a label dot or icon can be given (`LABEL_COLORS` in `src/components/messages/label-colors-utils.ts`). */
export type LayoutLabelColor = "blue" | "purple" | "pink" | "red" | "orange" | "amber" | "green" | "teal";
/**
 * The colours chosen for the marks in the message list, by mailbox id and by connected account id. A mailbox or account
 * that is absent has none chosen: the mailbox gets its automatic colour and the account's icon stays neutral.
 */
export interface LayoutLabelColors {
	mailboxes?: Record<string, LayoutLabelColor>;
	accounts?: Record<string, LayoutLabelColor>;
}

/** The layout choices that follow the account; a key that is absent was never chosen. */
export interface LayoutPreferences {
	readingPane?: LayoutReadingPane;
	density?: LayoutDensity;
	conversationView?: boolean;
	listLabels?: LayoutListLabels;
	labelColors?: LayoutLabelColors;
	/** The message list's width beside the reading pane, in pixels. */
	listWidth?: number;
	/** The message list's height above the reading pane, in pixels. */
	listHeight?: number;
	font?: LayoutFont;
	emailFont?: LayoutEmailFont;
	fontScope?: LayoutFontScope;
	interfaceDirection?: LayoutInterfaceDirection;
}

/** What `GET` and `PATCH /api/settings/layout` answer. */
export interface LayoutPreferencesResponse {
	/** False until migration 0080: the layout then stays in this browser only. */
	ready: boolean;
	/** Null when the account has never saved a layout. */
	layout: LayoutPreferences | null;
}

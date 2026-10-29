export type LayoutReadingPane = "none" | "right" | "below";
export type LayoutDensity = "default" | "comfortable" | "compact";

/** The layout choices that follow the account; a key that is absent was never chosen. */
export interface LayoutPreferences {
	readingPane?: LayoutReadingPane;
	density?: LayoutDensity;
	conversationView?: boolean;
	/** The message list's width beside the reading pane, in pixels. */
	listWidth?: number;
	/** The message list's height above the reading pane, in pixels. */
	listHeight?: number;
}

/** What `GET` and `PATCH /api/settings/layout` answer. */
export interface LayoutPreferencesResponse {
	/** False until migration 0080: the layout then stays in this browser only. */
	ready: boolean;
	/** Null when the account has never saved a layout. */
	layout: LayoutPreferences | null;
}

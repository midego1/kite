import type { LayoutPreferences } from "@/lib/preferences/layout-types";
import { columnWidthStorageKeys } from "./column-width-preferences";
import { CONVERSATION_VIEW_STORAGE_KEY } from "./messages/conversation-view-utils";
import { MESSAGE_DENSITY_STORAGE_KEY, READING_PANE_STORAGE_KEY } from "./messages/reading-layout-utils";

/** `off` keeps this browser's own layout: it neither loads the account's nor saves its own. */
export const LAYOUT_SYNC_DEVICE_KEY = "kite-layout-sync";
/** Fired when the device switch above changes in this tab. */
export const LAYOUT_SYNC_CHANGE_EVENT = "kite:layout-sync-changed";
/** Fired after the account's layout was written into this browser, for views that read sizes once. */
export const LAYOUT_PREFERENCES_APPLIED_EVENT = "kite:layout-preferences-applied";

/** The browser storage entries that hold a layout, in the formats the views read. */
export function layoutStorageEntries(layout: LayoutPreferences, userId: string): [string, string][] {
	const entries: [string, string][] = [];
	if (layout.readingPane) entries.push([READING_PANE_STORAGE_KEY, layout.readingPane]);
	if (layout.density) entries.push([MESSAGE_DENSITY_STORAGE_KEY, layout.density]);
	if (layout.conversationView !== undefined)
		entries.push([CONVERSATION_VIEW_STORAGE_KEY, layout.conversationView ? "on" : "off"]);
	if (layout.listWidth !== undefined)
		for (const key of columnWidthStorageKeys("message-list", userId)) entries.push([key, String(layout.listWidth)]);
	if (layout.listHeight !== undefined)
		for (const key of columnWidthStorageKeys("message-list-height", userId))
			entries.push([key, String(layout.listHeight)]);
	return entries;
}

/** The layout without the choices made here and not saved yet, which must not be overwritten. */
export function withoutKeys(layout: LayoutPreferences, unsaved: LayoutPreferences): LayoutPreferences {
	const result: Record<string, unknown> = { ...layout };
	for (const key of Object.keys(unsaved)) delete result[key];
	return result as LayoutPreferences;
}

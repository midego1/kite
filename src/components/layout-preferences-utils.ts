import type { LayoutPreferences } from "@/lib/preferences/layout-types";
import { parseLayoutPreferences } from "@/lib/preferences/layout-utils";
import { columnWidthStorageKeys } from "./column-width-preferences";
import { CONVERSATION_VIEW_STORAGE_KEY } from "./messages/conversation-view-utils";
import { MESSAGE_DENSITY_STORAGE_KEY, READING_PANE_STORAGE_KEY } from "./messages/reading-layout-utils";

/** `off` keeps this browser's own layout: it neither loads the account's nor saves its own. */
export const LAYOUT_SYNC_DEVICE_KEY = "kite-layout-sync";
/** Fired when the device switch above changes in this tab. */
export const LAYOUT_SYNC_CHANGE_EVENT = "kite:layout-sync-changed";
/** Fired after the account's layout was written into this browser, for views that read sizes once. */
export const LAYOUT_PREFERENCES_APPLIED_EVENT = "kite:layout-preferences-applied";

type ReadableStorage = Pick<Storage, "getItem">;

/**
 * The choices this browser holds explicitly, offered to an account that has never saved a layout. A choice
 * left at its default was never stored, so it stays out and other browsers keep theirs. List sizes stay out
 * too: the list stores its default size as soon as it is shown, so only a resize is sent (`queueLayoutSave`).
 */
export function readLocalLayout(storage: ReadableStorage): LayoutPreferences {
	const conversationView = storage.getItem(CONVERSATION_VIEW_STORAGE_KEY);
	return parseLayoutPreferences({
		readingPane: storage.getItem(READING_PANE_STORAGE_KEY),
		density: storage.getItem(MESSAGE_DENSITY_STORAGE_KEY),
		conversationView: conversationView === "on" ? true : conversationView === "off" ? false : undefined,
	});
}

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

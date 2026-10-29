import type { LayoutPreferences, LayoutPreferencesResponse } from "@/lib/preferences/layout-types";
import {
	LAYOUT_PREFERENCES_APPLIED_EVENT,
	LAYOUT_SYNC_CHANGE_EVENT,
	LAYOUT_SYNC_DEVICE_KEY,
	layoutStorageEntries,
	withoutKeys,
} from "./layout-preferences-utils";
import { CONVERSATION_VIEW_CHANGE_EVENT } from "./messages/conversation-view-utils";
import { READING_LAYOUT_CHANGE_EVENT } from "./messages/reading-layout-utils";

const LAYOUT_API = "/api/settings/layout";
/** Dragging the list fires a size per frame; only where it stops is saved. */
const SAVE_DELAY_MS = 600;

/**
 * The account's layout follows it to every browser: `localStorage` stays the cache every view reads, this
 * module loads the account's choices into it once the session is known and saves each choice made here.
 * Before migration 0080, or with the device switch off, it does nothing and the layout stays in the browser.
 */
let session: { userId: string; ready: boolean } | null = null;
let unsaved: LayoutPreferences = {};
let timer: ReturnType<typeof setTimeout> | undefined;

function browserStorage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function isLayoutSyncEnabled(): boolean {
	try {
		return browserStorage()?.getItem(LAYOUT_SYNC_DEVICE_KEY) !== "off";
	} catch {
		return false;
	}
}

/** The device switch: off keeps this browser's layout to itself; on loads the account's layout again. */
export function setLayoutSyncEnabled(enabled: boolean): void {
	try {
		if (enabled) browserStorage()?.removeItem(LAYOUT_SYNC_DEVICE_KEY);
		else browserStorage()?.setItem(LAYOUT_SYNC_DEVICE_KEY, "off");
	} catch {
		// Blocked storage: nothing is remembered either way.
	}
	unsaved = {};
	window.dispatchEvent(new Event(LAYOUT_SYNC_CHANGE_EVENT));
	if (enabled && session) void startLayoutSync(session.userId);
}

/** Saves a choice made in this browser to the account, shortly after the last change. */
export function queueLayoutSave(layout: LayoutPreferences): void {
	if (!isLayoutSyncEnabled()) return;
	unsaved = { ...unsaved, ...layout };
	// Until the account's layout has loaded the choice waits, and wins over the loaded one.
	if (!session?.ready) return;
	clearTimeout(timer);
	timer = setTimeout(() => void flushLayoutSave(), SAVE_DELAY_MS);
}

/** Sends the unsaved choices now; `keepalive` lets it finish while the page is closing. */
export async function flushLayoutSave(): Promise<void> {
	clearTimeout(timer);
	const current = session;
	if (!current?.ready || !Object.keys(unsaved).length) return;
	const layout = unsaved;
	unsaved = {};
	try {
		const response = await fetch(LAYOUT_API, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ layout }),
			keepalive: true,
		});
		// The table went missing (a restore from before 0080): stay with this browser's layout.
		if (response.status === 409) current.ready = false;
	} catch {
		// Offline: the choice is in this browser already and goes with the next one.
		unsaved = { ...layout, ...unsaved };
	}
}

/** Writes the account's layout into this browser and tells the open views, only when something differs. */
function applyLayout(layout: LayoutPreferences, userId: string): void {
	const storage = browserStorage();
	if (!storage) return;
	let changed = false;
	try {
		for (const [key, value] of layoutStorageEntries(layout, userId)) {
			if (storage.getItem(key) === value) continue;
			storage.setItem(key, value);
			changed = true;
		}
	} catch {
		// Full or blocked storage: the views keep what they show.
	}
	if (!changed) return;
	for (const event of [READING_LAYOUT_CHANGE_EVENT, CONVERSATION_VIEW_CHANGE_EVENT, LAYOUT_PREFERENCES_APPLIED_EVENT])
		window.dispatchEvent(new Event(event));
}

/**
 * Loads the account's layout into this browser; called again when the tab comes back. Only choices made
 * after this shipped are saved: what a browser stored before stays its own until the user changes it, so
 * an account never takes on whichever browser happened to load first.
 */
export async function startLayoutSync(userId: string): Promise<void> {
	const current = { userId, ready: false };
	if (session?.userId !== userId) unsaved = {};
	session = current;
	if (!isLayoutSyncEnabled()) return;
	let data: LayoutPreferencesResponse;
	try {
		const response = await fetch(LAYOUT_API, { cache: "no-store" });
		if (!response.ok) return;
		data = (await response.json()) as LayoutPreferencesResponse;
	} catch {
		return;
	}
	if (session !== current || !data.ready) return;
	current.ready = true;
	// The server answers only validated choices (`parseStoredLayout`).
	if (data.layout) applyLayout(withoutKeys(data.layout, unsaved), userId);
	await flushLayoutSave();
}

/** Signed out or switched accounts: nothing more is saved for the previous one. */
export function stopLayoutSync(): void {
	clearTimeout(timer);
	session = null;
	unsaved = {};
}

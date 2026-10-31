import type { LayoutPreferences, LayoutPreferencesResponse } from "@/lib/preferences/layout-types";
import {
	isRetryableLayoutLoad,
	LAYOUT_LOAD_RETRY_DELAYS_MS,
	LAYOUT_PREFERENCES_APPLIED_EVENT,
	LAYOUT_SYNC_CHANGE_EVENT,
	LAYOUT_SYNC_DEVICE_KEY,
	type LayoutSaveMarks,
	layoutStorageEntries,
	withoutKeys,
	withoutSavedSince,
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
 *
 * While the account's layout loads, choices made here wait (and win over the loaded ones); once it loaded,
 * or every attempt failed, they are saved. Saves merge on the server, so saving without a load is safe.
 */
let session: { userId: string; loading: boolean } | null = null;
let unsaved: LayoutPreferences = {};
let timer: ReturnType<typeof setTimeout> | undefined;
/** The server cannot store a layout (before migration 0080): nothing is loaded or saved again until a reload. */
let unavailable = false;
/** Orders loads against saves, so a load answered after a save cannot put the saved choice back. */
let tick = 0;
const saveMarks: LayoutSaveMarks = new Map();
/** Counts account switches and sign-outs, so a save answered afterwards leaves the next account alone. */
let generation = 0;

function markSaves(layout: LayoutPreferences, inFlight: 1 | -1): void {
	tick += 1;
	for (const key of Object.keys(layout)) {
		const mark = saveMarks.get(key) ?? { touched: 0, inFlight: 0 };
		saveMarks.set(key, { touched: tick, inFlight: Math.max(0, mark.inFlight + inFlight) });
	}
}

/** Forgets everything about the previous account: its unsaved choices and its saves in flight. */
function forgetAccount(): void {
	clearTimeout(timer);
	unsaved = {};
	saveMarks.clear();
	generation += 1;
}

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
	if (!isLayoutSyncEnabled() || unavailable) return;
	unsaved = { ...unsaved, ...layout };
	if (!session || session.loading) return;
	clearTimeout(timer);
	timer = setTimeout(() => void flushLayoutSave(), SAVE_DELAY_MS);
}

/**
 * Sends the unsaved choices now; `keepalive` lets it finish while the page is closing. Choices made while
 * the account's layout loads normally wait for it, but a page that is going away (`closing`) sends them
 * anyway: saves merge on the server, and the save marks keep a later load from putting them back.
 */
export async function flushLayoutSave({ closing = false }: { closing?: boolean } = {}): Promise<void> {
	clearTimeout(timer);
	if (!session || (session.loading && !closing) || unavailable || !Object.keys(unsaved).length) return;
	const layout = unsaved;
	const sentFor = generation;
	unsaved = {};
	markSaves(layout, 1);
	try {
		const response = await fetch(LAYOUT_API, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ layout }),
			keepalive: true,
		});
		// The table went missing (a restore from before 0080): stay with this browser's layout.
		if (response.status === 409) unavailable = true;
	} catch {
		// Offline: the choice is in this browser already and goes with the next one, for the same account.
		if (sentFor === generation) unsaved = { ...layout, ...unsaved };
	} finally {
		// After an account switch the marks belong to the next account; this answer says nothing about them.
		if (sentFor === generation) markSaves(layout, -1);
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

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One load, retried with backoff while the session stays the same; null when every attempt failed. */
async function loadLayout(
	current: NonNullable<typeof session>,
): Promise<{ data: LayoutPreferencesResponse; loadTick: number } | null> {
	for (let attempt = 0; ; attempt += 1) {
		tick += 1;
		const loadTick = tick;
		let status: number | null = null;
		try {
			const response = await fetch(LAYOUT_API, { cache: "no-store" });
			if (response.ok) return { data: (await response.json()) as LayoutPreferencesResponse, loadTick };
			status = response.status;
		} catch {
			// The network: tried again below.
		}
		const delay = LAYOUT_LOAD_RETRY_DELAYS_MS[attempt];
		if (delay === undefined || !isRetryableLayoutLoad(status)) return null;
		await wait(delay);
		if (session !== current) return null;
	}
}

/**
 * Loads the account's layout into this browser; called again when the tab comes back. Only choices made
 * after this shipped are saved: what a browser stored before stays its own until the user changes it, so
 * an account never takes on whichever browser happened to load first.
 */
export async function startLayoutSync(userId: string): Promise<void> {
	if (session?.userId !== userId) forgetAccount();
	const current = { userId, loading: true };
	session = current;
	if (!isLayoutSyncEnabled() || unavailable) return;
	const loaded = await loadLayout(current);
	if (session !== current) return;
	// Switched off on this device while the load was out: keep this browser's layout as it is.
	if (!isLayoutSyncEnabled()) {
		current.loading = false;
		return;
	}
	if (loaded && !loaded.data.ready) {
		unavailable = true;
		return;
	}
	current.loading = false;
	// The server answers only validated choices (`parseStoredLayout`).
	if (loaded?.data.layout)
		applyLayout(withoutKeys(withoutSavedSince(loaded.data.layout, saveMarks, loaded.loadTick), unsaved), userId);
	await flushLayoutSave();
}

/**
 * Signed out or switched accounts: nothing more is saved for the previous one. The next session asks the
 * server again whether it can store a layout.
 */
export function stopLayoutSync(): void {
	forgetAccount();
	session = null;
	unavailable = false;
}

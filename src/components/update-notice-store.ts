"use client";

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { NO_UPDATE_DETAILS } from "./update-available-utils";
import type { UpdateDetails, UpdateNoticeState } from "./update-available-types";

const INITIAL: UpdateNoticeState = {
	available: false,
	dismissed: false,
	lists: 0,
	reloading: false,
	detectedAt: null,
	details: NO_UPDATE_DETAILS,
	open: false,
	read: false,
};

let snapshot = INITIAL;
const listeners = new Set<() => void>();

function update(next: Partial<UpdateNoticeState>) {
	snapshot = { ...snapshot, ...next };
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Shared by the host (which checks versions), the pinned list row and the toast fallback. */
export function useUpdateNotice(): UpdateNoticeState {
	return useSyncExternalStore(
		subscribe,
		() => snapshot,
		() => INITIAL,
	);
}

export function announceUpdate(details: UpdateDetails = NO_UPDATE_DETAILS) {
	update({ available: true, dismissed: false, detectedAt: Date.now(), details });
}

export function dismissUpdateNotice() {
	update({ dismissed: true, open: false });
}

/** The row was opened: "What's new" takes the reader, and the row reads as read from now on. */
export function openUpdateReader() {
	update({ open: true, read: true });
}

/** A message was opened, the list was left or Back was chosen. */
export function closeUpdateReader() {
	if (snapshot.open) update({ open: false });
}

/** Reload was chosen on either surface; the host's one `ReloadFlight` takes it from here. */
export function requestReload() {
	if (!snapshot.reloading) update({ reloading: true });
}

/** The reload did not happen (the user cancelled the browser's prompt): the notice comes back for another try. */
export function cancelReload() {
	update({ reloading: false });
}

/** Signing out hides the notice without letting the tab announce again (the host remembers it showed). */
export function hideUpdateNotice() {
	update({ available: false, open: false });
}

/** A message list on screen takes over from the toast; returns the call that gives it back. */
function registerUpdateList(): () => void {
	update({ lists: snapshot.lists + 1 });
	return () => update({ lists: Math.max(0, snapshot.lists - 1) });
}

/** Registers a message list for as long as it is on screen. */
export function useRegisterUpdateList(onScreen: boolean) {
	useEffect(() => (onScreen ? registerUpdateList() : undefined), [onScreen]);
}

/** Provided by MessageSplitLayout: the list it holds can open "What's new" in its reader. */
export const UpdateReaderHostContext = createContext(false);

export function useUpdateReaderHost(): boolean {
	return useContext(UpdateReaderHostContext);
}

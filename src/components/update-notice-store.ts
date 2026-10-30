"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { UpdateNoticeState } from "./update-available-types";

const INITIAL: UpdateNoticeState = { available: false, dismissed: false, lists: 0 };

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

export function announceUpdate() {
	update({ available: true, dismissed: false });
}

export function dismissUpdateNotice() {
	update({ dismissed: true });
}

/** Signing out hides the notice without letting the tab announce again (the host remembers it showed). */
export function hideUpdateNotice() {
	update({ available: false });
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

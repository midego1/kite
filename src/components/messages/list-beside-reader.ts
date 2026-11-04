import { useSyncExternalStore } from "react";

/*
 * Whether the message list is on screen next to (or above) the open message. The split layout knows it from the
 * fold posture, the reading-pane choice, the room there is and the hide-list toggle; the phone tab bar reads it
 * to stay put on a message route that still shows the list, instead of guessing from the path.
 */

let shown = false;
const listeners = new Set<() => void>();

export function setListBesideReader(next: boolean) {
	if (shown === next) return;
	shown = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useListBesideReader(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => shown,
		() => false,
	);
}

import type { ChangeEvent, MouseEvent } from "react";
import type { Message } from "@/hooks/types";

type SelectedMessage = { id: string; read: boolean };

/**
 * The ids from the anchor row to the target row, inclusive and in list order, for
 * Shift-click selection. Without a usable anchor only the target is returned.
 */
export function getRangeSelectionIds(orderedIds: string[], anchorId: string | null, targetId: string): string[] {
	const target = orderedIds.indexOf(targetId);
	if (target === -1) return [];
	const anchor = anchorId ? orderedIds.indexOf(anchorId) : -1;
	if (anchor === -1) return [targetId];
	const [start, end] = anchor < target ? [anchor, target] : [target, anchor];
	return orderedIds.slice(start, end + 1);
}

/** Drops selected ids that no longer have a row; returns the same array when nothing changed. */
export function pruneSelection<T extends { id: string }>(selected: T[], rows: Array<{ id: string }>): T[] {
	if (selected.length === 0) return selected;
	const present = new Set(rows.map((row) => row.id));
	const kept = selected.filter((item) => present.has(item.id));
	return kept.length === selected.length ? selected : kept;
}

/** Selects or clears `ids` among the loaded messages, keeping the rest of the selection. */
export function applySelection(
	current: SelectedMessage[],
	messages: Message[],
	ids: string[],
	selected: boolean,
): SelectedMessage[] {
	if (!selected) return current.filter((item) => !ids.includes(item.id));
	const next = new Map(current.map((item) => [item.id, item]));
	for (const message of messages) {
		if (ids.includes(message.id) && !next.has(message.id)) {
			next.set(message.id, { id: message.id, read: message.read && !(message.threadUnread ?? 0) });
		}
	}
	return Array.from(next.values());
}

/**
 * Change and mouse-down handlers for a row checkbox. React drives a checkbox's
 * onChange from the click event, so its native event carries Shift; mouse-down
 * with Shift is cancelled so the click does not also select the text in between.
 */
export function rowCheckboxHandlers(
	messageId: string,
	onSelectedChange: (messageId: string, selected: boolean, extendRange?: boolean) => void,
) {
	return {
		onChange: (event: ChangeEvent<HTMLInputElement>) =>
			onSelectedChange(messageId, event.target.checked, (event.nativeEvent as globalThis.MouseEvent).shiftKey),
		onMouseDown: (event: MouseEvent<HTMLInputElement>) => {
			if (event.shiftKey) event.preventDefault();
		},
	};
}

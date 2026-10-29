import type { MouseEvent } from "react";
import type { CheckboxChangeEvent } from "@/components/ui/checkbox-types";
import type { Message } from "@/hooks/types";
import { isSendPending } from "@/lib/messages/send-state-utils";

type SelectedMessage = { id: string; read: boolean; mailboxId?: string | null };

/**
 * The ids from the anchor row to the target row, inclusive and in list order, for
 * Shift-click selection. Without a usable anchor only the target is returned.
 */
function getRangeSelectionIds(orderedIds: string[], anchorId: string | null, targetId: string): string[] {
	const target = orderedIds.indexOf(targetId);
	if (target === -1) return [];
	const anchor = anchorId ? orderedIds.indexOf(anchorId) : -1;
	if (anchor === -1) return [targetId];
	const [start, end] = anchor < target ? [anchor, target] : [target, anchor];
	return orderedIds.slice(start, end + 1);
}

/** How a row click selects instead of opening: `toggle` is Cmd (Apple) or Ctrl, `shift` extends a range. */
export type RowClickModifiers = { shift: boolean; toggle: boolean };

/** Apple devices use Cmd to toggle a row, everything else Ctrl. */
export function isApplePlatform(platform: string): boolean {
	return /Mac|iPhone|iPad/i.test(platform);
}

/**
 * The selecting modifiers of a row click, or null when the click opens the message as usual. Only the primary
 * button counts (a middle click never reaches onClick anyway) and Alt, or Ctrl on Apple devices where it is a
 * context click, leaves the click to the browser.
 */
export function rowClickModifiers(
	event: Pick<MouseEvent, "button" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
	apple: boolean,
): RowClickModifiers | null {
	if (event.button !== 0 || event.altKey) return null;
	if (apple ? event.ctrlKey : event.metaKey) return null;
	const toggle = apple ? event.metaKey : event.ctrlKey;
	return event.shiftKey || toggle ? { shift: event.shiftKey, toggle } : null;
}

/**
 * The message id a detail route names (`/inbox/<id>`, `/drafts/<id>`), or undefined on the list itself. Drafts
 * open in the composer from their own route, outside the split layout that passes the open message down.
 */
export function openIdFromPath(pathname: string, hrefPrefix: string): string | undefined {
	const prefix = `${hrefPrefix}/`;
	if (!pathname.startsWith(prefix)) return undefined;
	return pathname.slice(prefix.length).split("/")[0] || undefined;
}

/** The row a range grows from: the last anchor still in the list, else the open message, else none. */
export function resolveSelectionAnchor(
	orderedIds: string[],
	anchorId: string | null,
	openId: string | null | undefined,
): string | null {
	if (anchorId && orderedIds.includes(anchorId)) return anchorId;
	return openId && orderedIds.includes(openId) ? openId : null;
}

type RowSelectionPlan = { selectedIds: string[]; anchorId: string | null };

/**
 * The selection after a modifier-click on `targetId`, desktop style. Cmd/Ctrl toggles the row, and when nothing
 * was selected yet the open message joins first. Shift selects the rows from the anchor to the target in list
 * order, replacing the selection; with Cmd/Ctrl too the range is added to it. A range keeps its anchor so the
 * next Shift-click re-extends from the same row. Only rows in `orderedIds` (the loaded ones) can be selected, so
 * a range never reaches past what the list has loaded.
 */
export function planRowSelection(input: {
	orderedIds: string[];
	selectedIds: string[];
	anchorId: string | null;
	openId?: string | null;
	targetId: string;
	modifiers: RowClickModifiers;
}): RowSelectionPlan {
	const { orderedIds, selectedIds, targetId, modifiers } = input;
	if (!orderedIds.includes(targetId)) return { selectedIds, anchorId: input.anchorId };
	const anchor = resolveSelectionAnchor(orderedIds, input.anchorId, input.openId);
	if (modifiers.shift) {
		const range = getRangeSelectionIds(orderedIds, anchor, targetId);
		const next = modifiers.toggle ? orderedIds.filter((id) => range.includes(id) || selectedIds.includes(id)) : range;
		return { selectedIds: next, anchorId: anchor ?? targetId };
	}
	const open = input.openId && orderedIds.includes(input.openId) ? input.openId : null;
	const base = selectedIds.length === 0 && open ? [open] : selectedIds;
	const next = base.includes(targetId) ? base.filter((id) => id !== targetId) : [...base, targetId];
	return { selectedIds: next, anchorId: targetId };
}

/** Makes `ids` the whole selection: other rows leave it, rows not selected yet join from `messages`. */
export function replaceSelection(current: SelectedMessage[], messages: Message[], ids: string[]): SelectedMessage[] {
	return applySelection(
		current.filter((item) => ids.includes(item.id)),
		messages,
		ids,
		true,
	);
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
			next.set(message.id, {
				id: message.id,
				read: message.read && !(message.threadUnread ?? 0),
				...(message.mailboxId ? { mailboxId: message.mailboxId } : {}),
				// Drafts and sends waiting to go out are told apart, since the toolbar treats them differently.
				...(message.status === "draft" || isSendPending(message.status) ? { status: message.status } : {}),
			});
		}
	}
	return Array.from(next.values());
}

/**
 * Change and mouse-down handlers for a row checkbox. Checkbox passes the click that
 * toggled it as onChange's native event, so it carries Shift; mouse-down
 * with Shift is cancelled so the click does not also select the text in between.
 */
export function rowCheckboxHandlers(
	messageId: string,
	onSelectedChange: (messageId: string, selected: boolean, extendRange?: boolean) => void,
) {
	return {
		onChange: (event: CheckboxChangeEvent) =>
			onSelectedChange(messageId, event.target.checked, (event.nativeEvent as globalThis.MouseEvent).shiftKey),
		onMouseDown: (event: MouseEvent<HTMLElement>) => {
			if (event.shiftKey) event.preventDefault();
		},
	};
}

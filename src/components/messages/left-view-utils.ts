import type { BulkMessageAction, BulkMessageResponse } from "@/app/api/messages/bulk/types";

/** Fired with the messages an action moved, so an open reader whose message left its list can close. */
export const MESSAGES_LEFT_VIEW_EVENT = "kite:messages-left-view";

/** How the messages changed: moved to another folder, deleted for good, snoozed, or woken from a snooze. */
export type LeftViewKind = "move" | "delete" | "snooze" | "unsnooze";

export type MessagesLeftView = { kind: LeftViewKind; ids: string[] };

const movingActions = new Set<string>(["archive", "trash", "spam", "phishing", "inbox", "folder"]);

/**
 * What a bulk action did to the list, as an event: the messages the server says it moved (`moved`), or the ones
 * asked for when the response does not say. Null for an action that leaves mail where it is (read state, restore).
 */
export function bulkActionLeftView(
	action: BulkMessageAction | string,
	messageIds: readonly string[],
	data?: Pick<BulkMessageResponse, "moved"> | null,
): MessagesLeftView | null {
	if (action !== "delete" && !movingActions.has(action)) return null;
	const ids = [...new Set(data?.moved ?? messageIds)];
	return ids.length > 0 ? { kind: action === "delete" ? "delete" : "move", ids } : null;
}

/**
 * Whether messages changed this way are gone from a list of `folder` (a user folder lists as "inbox" with a
 * `folderId`). Starred lists starred mail wherever it is filed, so only Delete takes it out; snoozed mail leaves
 * the Inbox alone, and waking it leaves Snoozed.
 */
export function leavesList(kind: LeftViewKind, folder: string, folderId?: string | null): boolean {
	if (kind === "delete") return true;
	if (kind === "snooze") return folder === "inbox" && !folderId;
	if (kind === "unsnooze") return folder === "snoozed";
	return folder !== "starred";
}

/**
 * The row the focus goes to once `leftIds` are gone: the next remaining one, else the previous, else none. The open
 * message is found by what each row stands for (`idsOfRow`), so an older message of a conversation, whose row is
 * keyed by the newest one, still has its place in the list.
 */
export function neighbourAfterLeaving(
	orderedIds: readonly string[],
	openId: string,
	leftIds: readonly string[],
	idsOfRow: (rowId: string) => readonly string[] = (rowId) => [rowId],
): string | null {
	const index = orderedIds.findIndex((rowId) => rowId === openId || idsOfRow(rowId).includes(openId));
	if (index < 0) return null;
	const left = new Set([...leftIds, openId, orderedIds[index]]);
	return (
		orderedIds.slice(index + 1).find((id) => !left.has(id)) ??
		orderedIds
			.slice(0, index)
			.reverse()
			.find((id) => !left.has(id)) ??
		null
	);
}

export function announceMessagesLeftView(change: MessagesLeftView | null) {
	if (!change || change.ids.length === 0) return;
	window.dispatchEvent(new CustomEvent<MessagesLeftView>(MESSAGES_LEFT_VIEW_EVENT, { detail: change }));
}

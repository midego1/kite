import type { BulkMessageAction, BulkMessageResponse } from "@/app/api/messages/bulk/types";

/** Fired with the ids of messages an action took out of the list they were in, so an open reader can close. */
export const MESSAGES_LEFT_VIEW_EVENT = "kite:messages-left-view";

const leavingActions = new Set<string>(["archive", "trash", "spam", "phishing", "inbox", "folder", "delete"]);

/**
 * The messages an action took out of their list. A response with `undo` names exactly what moved, the
 * conversation members the server took along included and refused mail (a send still queued, sent mail
 * reported as spam) left out; otherwise it is the ones asked for. Empty for an action that leaves mail where it is.
 */
export function idsLeavingView(
	action: BulkMessageAction | string,
	messageIds: readonly string[],
	data?: Pick<BulkMessageResponse, "undo"> | null,
): string[] {
	if (!leavingActions.has(action)) return [];
	return [...new Set(data?.undo ? data.undo.map((state) => state.id) : messageIds)];
}

/** Whether the open message is among the ones that left, so the reader should go back to the empty pane. */
export function openMessageLeft(openMessageId: string | undefined, ids: readonly string[]): boolean {
	return !!openMessageId && ids.includes(openMessageId);
}

export function announceMessagesLeftView(ids: readonly string[]) {
	if (ids.length === 0) return;
	window.dispatchEvent(new CustomEvent<string[]>(MESSAGES_LEFT_VIEW_EVENT, { detail: [...ids] }));
}

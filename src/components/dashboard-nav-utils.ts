import type { BulkMessageAction, BulkMessageResponse } from "@/app/api/messages/bulk/types";
import { offerUndoForMove } from "@/components/messages/undo-utils";
import type { MessageCounts, MessageFolder } from "@/hooks/types";
import { authFetch } from "@/lib/auth/client";

export function getFolderNavCount(folder: MessageFolder, counts: MessageCounts["folders"]): number | undefined {
	return counts[folder].unread;
}

async function moveMessages(payload: { messageIds: string[]; action: BulkMessageAction; folderId?: string }) {
	const response = await authFetch("/api/messages/bulk", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!response.ok) throw new Error("Unable to move messages");
	window.dispatchEvent(new Event("kite:messages-changed"));
	offerUndoForMove(payload.action, (await response.json().catch(() => null)) as BulkMessageResponse | null);
}

export function moveMessagesToSystemFolder(messageIds: string[], action: "archive" | "spam" | "trash") {
	return moveMessages({ messageIds, action });
}

export function moveMessagesToCustomFolder(messageIds: string[], folderId: string) {
	return moveMessages({ messageIds, action: "folder", folderId });
}

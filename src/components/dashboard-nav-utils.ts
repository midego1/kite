import type { BulkMessageAction, BulkMessageResponse } from "@/app/api/messages/bulk/types";
import { confirmReportSpam } from "@/components/messages/spam-report";
import { offerUndoForMove } from "@/components/messages/undo-utils";
import { postBulkMessageAction } from "@/components/messages/bulk-request";
import type { MessageCounts, MessageFolder } from "@/hooks/types";
import { DEFAULT_FOLDER_COLOR } from "@/lib/folders/colors";
import { Folder } from "lucide-react";
import type { NavLink } from "./components-nav-types";
import type { CustomFolder } from "./dashboard-nav-types";

export function getFolderNavCount(folder: MessageFolder, counts: MessageCounts["folders"]): number | undefined {
	// Counts cached from before the Screener existed have no entry for it.
	return counts[folder]?.unread;
}

async function moveMessages(payload: { messageIds: string[]; action: BulkMessageAction; folderId?: string }) {
	const response = await postBulkMessageAction(payload);
	if (!response) return;
	if (!response.ok) throw new Error("Unable to move messages");
	window.dispatchEvent(new Event("kite:messages-changed"));
	offerUndoForMove(payload.action, (await response.json().catch(() => null)) as BulkMessageResponse | null);
}

export async function moveMessagesToSystemFolder(messageIds: string[], action: "archive" | "spam" | "trash") {
	// Dropping mail on Spam reports it like the button does, so it asks first.
	if (action === "spam" && !(await confirmReportSpam(messageIds.length))) return;
	return moveMessages({ messageIds, action });
}

function moveMessagesToCustomFolder(messageIds: string[], folderId: string) {
	return moveMessages({ messageIds, action: "folder", folderId });
}

/**
 * Whether someone picked a folder's colour. The flag says so for the default blue too; any other colour was picked
 * whatever the flag says, which keeps folders coloured before migration 0086 (and while it is pending) tinted.
 */
function isPickedFolderColor(folder: CustomFolder): boolean {
	return folder.colorIsCustom === true || folder.color.toLowerCase() !== DEFAULT_FOLDER_COLOR;
}

/** A user folder's sidebar link; dropping mail on it files the mail there (within the folder's own mailbox). */
export function customFolderNavLink(folder: CustomFolder, unread: number | undefined): NavLink {
	return {
		href: `/folders/${folder.id}`,
		label: folder.name,
		icon: Folder,
		preloadMessages: true,
		iconColor: folder.color,
		railIconColor: isPickedFolderColor(folder) ? folder.color : undefined,
		count: unread,
		onMessageDrop: (messageIds: string[]) => void moveMessagesToCustomFolder(messageIds, folder.id),
	};
}

/** Which parts of the Folders section show: the one mailbox's list, or All mailboxes' groups. */
export function folderSectionState({
	allMailboxes,
	minimal,
	open,
	count,
	overflow,
}: {
	allMailboxes: boolean;
	minimal: boolean;
	open: boolean;
	count: number;
	overflow: boolean;
}) {
	const shown = minimal || open;
	return {
		groups: allMailboxes && shown,
		list: !allMailboxes && shown,
		empty: !allMailboxes && !minimal && open && count === 0,
		toggle: !allMailboxes && open && overflow,
	};
}

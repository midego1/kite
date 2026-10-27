"use client";

import { useSelectedMailbox } from "@/components/mailbox-provider";
import { singleMailboxOf } from "@/lib/mailboxes/scope-utils";
import { useMailboxFolders } from "./use-mailbox-folders";
import { useMessageAccess } from "./use-message-access";

/**
 * What the bulk toolbar offers for a selection. Mail moves only within its own mailbox, so folders
 * are listed while the selection is in one mailbox the user may manage; read-only shared mail can
 * only be marked read, so the moving actions are off when nothing else is selected.
 */
export function useBulkSelectionAccess(mailboxIds: Array<string | null | undefined> | undefined, pending: boolean) {
	const { selectedMailbox } = useSelectedMailbox();
	const access = useMessageAccess();
	const ids = mailboxIds ?? [selectedMailbox?.id];
	const folderMailboxId = singleMailboxOf(ids);
	const folders = useMailboxFolders(folderMailboxId && access.canManage(folderMailboxId) ? folderMailboxId : undefined);
	return {
		folders,
		spansMailboxes: !folderMailboxId && new Set(ids.filter(Boolean)).size > 1,
		manageDisabled: pending || !ids.some((id) => access.canManage(id)),
	};
}

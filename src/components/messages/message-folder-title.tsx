"use client";

import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMessageCounts } from "@/hooks/use-message-counts";
import type { MessageFolderConfig } from "./types";
import { useEmailPageTitle } from "./use-email-page-title";
import { ALL_MAILBOXES_LABEL, getMailboxAddress } from "./utils";

/** Owns the folder title when a single-column message has no mounted list. */
export function MessageFolderTitle({ config }: { config: MessageFolderConfig }) {
	const { selectedMailbox, allMailboxes, mailboxScope, isLoading } = useSelectedMailbox();
	const { counts } = useMessageCounts(mailboxScope, !isLoading);
	const count = config.folderId ? counts.customFolders[config.folderId] : counts.folders[config.folder];
	useEmailPageTitle(
		{
			location: config.title,
			total: count?.total ?? 0,
			unread: count?.unread ?? 0,
			emailAddress: allMailboxes ? ALL_MAILBOXES_LABEL : getMailboxAddress(selectedMailbox),
		},
		isLoading,
	);
	return null;
}

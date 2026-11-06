"use client";

import { Folder } from "lucide-react";
import { useMemo } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useFoldersByMailbox } from "./use-mailbox-folders";
import type { MessageFolderConfig } from "./types";
import { useT } from "@/lib/i18n/use-t";

export function useCustomFolderConfig(folderId: string): MessageFolderConfig {
	const t = useT();
	const { viewMailboxes } = useSelectedMailbox();
	// In All mailboxes the folder can belong to any listed mailbox.
	const foldersByMailbox = useFoldersByMailbox(viewMailboxes.map((mailbox) => mailbox.id));
	const folderName =
		[...foldersByMailbox.values()].flat().find((folder) => folder.id === folderId)?.name ?? t("Folder");

	return useMemo(
		() => ({
			folder: "inbox",
			folderId,
			title: folderName,
			emptyText: t("No emails in this folder"),
			hrefPrefix: `/folders/${folderId}`,
			icon: Folder,
			showRowBadge: false,
		}),
		[folderId, folderName],
	);
}

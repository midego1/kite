"use client";

import { MailOpen } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMessageCounts } from "@/hooks/use-message-counts";
import type { ReadingPaneEmptyStateProps } from "./reading-layout-types";

export function ReadingPaneEmptyState({ config }: ReadingPaneEmptyStateProps) {
	const { selectedMailbox, isLoading: mailboxesLoading } = useSelectedMailbox();
	const { counts, isLoading } = useMessageCounts(selectedMailbox?.id, !mailboxesLoading);
	const folderCount = config.folderId ? counts.customFolders[config.folderId] : counts.folders[config.folder];
	const unread = folderCount?.unread ?? 0;

	return (
		<div className="flex h-full items-center justify-center p-8" data-testid="reading-pane-empty">
			<div className="text-center">
				<div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-400">
					<MailOpen className="h-6 w-6" />
				</div>
				<h2 className="mt-4 text-base font-medium text-neutral-700">Select a message to read</h2>
				<p className={`mt-1 text-sm text-neutral-500 ${isLoading || mailboxesLoading ? "invisible" : ""}`}>
					{unread > 0 ? `${unread} unread in ${config.title}` : "Nothing selected"}
				</p>
			</div>
		</div>
	);
}

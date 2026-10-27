"use client";

import { useRef } from "react";
import { MailOpen } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { MigrationsNoticeCard } from "@/components/migrations-banner";
import { useMigrationsCardSlot } from "@/components/use-migrations-notice";
import { useMessageCounts } from "@/hooks/use-message-counts";
import type { ReadingPaneEmptyStateProps } from "./reading-layout-types";

export function ReadingPaneEmptyState({ config }: ReadingPaneEmptyStateProps) {
	const { mailboxScope, isLoading: mailboxesLoading } = useSelectedMailbox();
	const { counts, isLoading } = useMessageCounts(mailboxScope, !mailboxesLoading);
	const folderCount = config.folderId ? counts.customFolders[config.folderId] : counts.folders[config.folder];
	const unread = folderCount?.unread ?? 0;
	const paneRef = useRef<HTMLDivElement>(null);
	// While this pane is on screen it carries the database notice, and the top banner steps aside.
	useMigrationsCardSlot(paneRef);

	return (
		<div ref={paneRef} className="flex h-full items-center justify-center p-8" data-testid="reading-pane-empty">
			<div className="flex w-full flex-col items-center gap-8 text-center">
				<MigrationsNoticeCard />
				<div>
					<div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-400">
						<MailOpen className="h-6 w-6" />
					</div>
					<h2 className="mt-4 text-base font-medium text-neutral-700">Select a message to read</h2>
					<p className={`mt-1 text-sm text-neutral-500 ${isLoading || mailboxesLoading ? "invisible" : ""}`}>
						{unread > 0 ? `${unread} unread in ${config.title}` : "Nothing selected"}
					</p>
				</div>
			</div>
		</div>
	);
}

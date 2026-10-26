"use client";

import { useSelectedMailbox } from "@/components/mailbox-provider";
import { getMailboxName } from "@/components/mailbox-selector-utils";
import { useFoldersByMailbox } from "@/components/messages/use-mailbox-folders";
import type { MessageCounts } from "@/hooks/types";
import { NavItem } from "./components-nav";
import { customFolderNavLink } from "./dashboard-nav-utils";
import { ReorderableList } from "./reorderable-list";

/**
 * User folders in the All mailboxes view: each mailbox's folders under its name, each group in its
 * own reorderable list, so a folder is never dragged into another mailbox's group.
 */
export function AllMailboxesFolders({
	customFolderCounts,
	minimal,
}: {
	customFolderCounts: MessageCounts["customFolders"];
	minimal: boolean;
}) {
	const { viewMailboxes } = useSelectedMailbox();
	const foldersByMailbox = useFoldersByMailbox(viewMailboxes.map((mailbox) => mailbox.id));
	const groups = viewMailboxes
		.map((mailbox) => ({ mailbox, folders: foldersByMailbox.get(mailbox.id) ?? [] }))
		.filter((group) => group.folders.length > 0);

	if (groups.length === 0) {
		return minimal ? null : (
			<div className="mx-6 rounded-lg border border-dashed border-neutral-200 px-3 py-3 text-xs text-neutral-500">
				No folders yet
			</div>
		);
	}
	return (
		<>
			{groups.map(({ mailbox, folders }) => (
				<div key={mailbox.id} role="group" aria-label={`${getMailboxName(mailbox)} folders`}>
					{!minimal && (
						<p className="truncate px-6 pb-0.5 pt-2 text-xs font-medium text-neutral-500">{getMailboxName(mailbox)}</p>
					)}
					<ReorderableList
						storageKey={`kite:nav:layout:folders:${mailbox.id}`}
						enabled={!minimal}
						lists={[
							{
								id: "folders",
								items: folders.map((folder) => ({
									id: folder.id,
									node: <NavItem wrap link={customFolderNavLink(folder, customFolderCounts[folder.id]?.unread)} />,
								})),
							},
						]}
					/>
				</div>
			))}
		</>
	);
}

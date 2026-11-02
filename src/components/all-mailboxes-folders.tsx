"use client";

import { useSelectedMailbox } from "@/components/mailbox-provider";
import { getMailboxAddress, getMailboxName } from "@/components/mailbox-selector-utils";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useFoldersByMailbox } from "@/components/messages/use-mailbox-folders";
import type { MessageCounts } from "@/hooks/types";
import { FolderNavItem } from "./folders/folder-nav-item";
import { ReorderableList } from "./reorderable-list";
import type { FolderTarget } from "./use-all-mailboxes-nav";

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
									node: (
										<FolderNavItem
											folder={folder}
											unread={customFolderCounts[folder.id]?.unread}
											canManage={(mailbox.permission ?? "full_access") === "full_access"}
										/>
									),
								})),
							},
						]}
					/>
				</div>
			))}
		</>
	);
}

/** The create-folder dialog's mailbox picker, shown in All mailboxes only. */
export function FolderMailboxField({ target }: { target: FolderTarget }) {
	if (target.choices.length === 0) return null;
	return (
		<div className="space-y-2">
			<Label htmlFor="folderMailbox">Mailbox</Label>
			<Select id="folderMailbox" value={target.mailboxId ?? ""} onChange={(event) => target.choose(event.target.value)}>
				{target.choices.map((mailbox) => (
					<option key={mailbox.id} value={mailbox.id}>
						{getMailboxAddress(mailbox)}
					</option>
				))}
			</Select>
		</div>
	);
}

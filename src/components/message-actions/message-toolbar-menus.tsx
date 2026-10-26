"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Clock, Folder, FolderInput } from "lucide-react";
import { createElement, useState } from "react";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import { SnoozePicker } from "@/components/messages/snooze-picker";
import { useMailboxFolders } from "@/components/messages/use-mailbox-folders";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { MoveMessageActionItem } from "./types";

const menuItemClass =
	"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100";

/** The reader toolbar's Snooze button, with the same picker as the list rows. */
export function SnoozeToolbarButton({
	messageId,
	snoozable,
	disabled,
	iconSize,
}: {
	messageId: string;
	/** Only received mail in the Inbox can be snoozed. */
	snoozable: boolean;
	disabled: boolean;
	iconSize: number;
}) {
	const [open, setOpen] = useState(false);
	if (!snoozable) return null;
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Tooltip label={open ? null : "Snooze"}>
				<Popover.Trigger asChild>
					<Button type="button" variant="ghost" size="roundedSM" aria-label="Snooze" disabled={disabled}>
						<Clock size={iconSize} />
					</Button>
				</Popover.Trigger>
			</Tooltip>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={6}
					collisionPadding={8}
					aria-label="Snooze"
					className="z-50 w-72 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg"
				>
					<SnoozePicker messageId={messageId} onSnoozed={() => setOpen(false)} />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** The mailbox's own folders, loaded when the Move menu opens. */
function FolderItems({ mailboxId, onMove }: { mailboxId: string | null; onMove: (folderId: string) => void }) {
	const folders = useMailboxFolders(mailboxId ?? undefined);
	if (folders.length === 0) return null;
	return (
		<>
			<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
			<DropdownMenu.Label className="mt-1 px-3 pb-1 pt-2 text-sm font-medium text-neutral-500">
				Folders
			</DropdownMenu.Label>
			{folders.map((folder) => (
				<DropdownMenu.Item key={folder.id} className={menuItemClass} onSelect={() => onMove(folder.id)}>
					<Folder className="h-4 w-4 shrink-0" style={{ color: folder.color }} />
					<span className="truncate">{folder.name}</span>
				</DropdownMenu.Item>
			))}
		</>
	);
}

/** The reader toolbar's Move menu: the standard folders the message can go to, then the mailbox's own. */
export function MoveToolbarMenu({
	actions,
	mailboxId,
	disabled,
	iconSize,
	onAction,
}: {
	actions: MoveMessageActionItem[];
	mailboxId: string | null;
	disabled: boolean;
	iconSize: number;
	onAction: (action: BulkMessageAction, folderId?: string) => void;
}) {
	return (
		<DropdownMenu.Root>
			<Tooltip label="Move to">
				<DropdownMenu.Trigger asChild>
					<Button type="button" variant="ghost" size="roundedSM" aria-label="Move to" disabled={disabled}>
						<FolderInput size={iconSize} />
					</Button>
				</DropdownMenu.Trigger>
			</Tooltip>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={4}
					className="z-[130] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-54 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg"
				>
					{actions.map((item) => (
						<DropdownMenu.Item key={item.action} className={menuItemClass} onSelect={() => onAction(item.action)}>
							{createElement(item.icon, { size: 16 })}
							{item.label}
						</DropdownMenu.Item>
					))}
					<FolderItems mailboxId={mailboxId} onMove={(folderId) => onAction("folder", folderId)} />
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

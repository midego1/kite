"use client";

import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	Folder,
	FolderInput,
	Inbox,
	Mail,
	MailOpen,
	MoreVertical,
	ShieldAlert,
	ShieldCheck,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button } from "@/components/ui/button";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMailboxFolders } from "./use-mailbox-folders";
import { Tooltip } from "@/components/ui/tooltip";
import { supportsPermanentDelete } from "@/lib/messages/permanent-delete-utils";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { BulkMessageToolbarProps } from "./types";

const menuItemClass =
	"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100";
const menuLabelClass = "mt-1 px-3 pb-1 pt-2 text-sm font-medium text-neutral-500";
const menuContentClass =
	"z-[130] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-54 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg";

export function BulkMessageToolbar({
	selectedCount,
	hasUnreadSelection,
	hideSelectedCount = false,
	onAction,
	onClearSelection,
	pending,
	folder,
}: BulkMessageToolbarProps) {
	// In archived, spam and trash the usual button would be a no-op, so it becomes the way back to the inbox.
	const archive =
		folder === "archived"
			? { action: "inbox", label: "Unarchive", Icon: ArchiveRestore }
			: { action: "archive", label: "Archive", Icon: Archive };
	const spam =
		folder === "spam"
			? { action: "inbox", label: "Not spam", Icon: ShieldCheck }
			: { action: "spam", label: "Report spam", Icon: ShieldAlert };
	const trash =
		folder === "trash"
			? { action: "inbox", label: "Restore", Icon: Undo2 }
			: { action: "trash", label: "Delete", Icon: Trash2 };
	// Trash and Spam also offer the irreversible delete; the page confirms before running it.
	const canDeleteForever = supportsPermanentDelete(folder);
	const moveOptions = [
		{ value: "inbox", label: "Inbox", Icon: Inbox, hidden: !folder || folder === "inbox" },
		{ value: "archive", label: "Archived", Icon: Archive, hidden: folder === "archived" },
		{ value: "spam", label: "Spam", Icon: ShieldAlert, hidden: folder === "spam" },
		{ value: "trash", label: "Trash", Icon: Trash2, hidden: folder === "trash" },
	].filter((option) => !option.hidden);
	const { selectedMailbox } = useSelectedMailbox();
	const folders = useMailboxFolders(selectedMailbox?.id);
	return (
		<div className="flex min-w-0 items-center gap-2 text-neutral-600 w-full">
			{!hideSelectedCount && (
				<span className="mr-2 text-sm font-medium text-neutral-800">{selectedCount} selected</span>
			)}
			<span className="flex-1 md:hidden" />
			<Tooltip label={archive.label} className="max-md:hidden">
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onAction(archive.action as BulkMessageAction)}
					disabled={pending}
					aria-label={archive.label}
				>
					<archive.Icon className="h-4 w-4" />
				</Button>
			</Tooltip>
			<Tooltip label={spam.label} className="max-md:hidden">
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onAction(spam.action as BulkMessageAction)}
					disabled={pending}
					aria-label={spam.label}
				>
					<spam.Icon className="h-4 w-4" />
				</Button>
			</Tooltip>
			<Tooltip label={trash.label}>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onAction(trash.action as BulkMessageAction)}
					disabled={pending}
					aria-label={trash.label}
				>
					<trash.Icon className="h-4 w-4" />
				</Button>
			</Tooltip>
			{canDeleteForever && (
				<Tooltip label="Delete forever">
					<Button
						variant="ghost"
						size="sm"
						className="text-red-600 hover:text-red-700"
						onClick={() => onAction("delete")}
						disabled={pending}
						aria-label="Delete forever"
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</Tooltip>
			)}
			<Tooltip label={hasUnreadSelection ? "Mark as read" : "Mark as unread"}>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onAction(hasUnreadSelection ? "read" : "unread")}
					disabled={pending}
					aria-label={hasUnreadSelection ? "Mark as read" : "Mark as unread"}
				>
					{hasUnreadSelection ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
				</Button>
			</Tooltip>
			<span className="flex-1 max-md:hidden" />
			<DropdownMenu.Root>
				<Tooltip label="Move selected messages" className="max-md:hidden">
					<DropdownMenu.Trigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="max-md:hidden gap-1.5 bg-white text-xs font-medium text-neutral-700"
							disabled={pending}
							aria-label="Move selected messages"
						>
							<FolderInput className="h-4 w-4" />
							Move to
							<ChevronDown className="h-3.5 w-3.5 text-neutral-500" />
						</Button>
					</DropdownMenu.Trigger>
				</Tooltip>
				<DropdownMenu.Portal>
					<DropdownMenu.Content align="end" sideOffset={4} className={menuContentClass}>
						{moveOptions.map(({ value, label, Icon }) => (
							<DropdownMenu.Item
								key={value}
								className={menuItemClass}
								onSelect={() => onAction(value as BulkMessageAction)}
							>
								<Icon className="h-4 w-4" />
								{label}
							</DropdownMenu.Item>
						))}
						{folders.length > 0 && (
							<>
								<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
								<DropdownMenu.Label className={menuLabelClass}>Folders</DropdownMenu.Label>
								{folders.map((item) => (
									<DropdownMenu.Item
										key={item.id}
										className={menuItemClass}
										onSelect={() => onAction("folder", item.id)}
									>
										<Folder className="h-4 w-4 shrink-0" style={{ color: item.color }} />
										<span className="truncate">{item.name}</span>
									</DropdownMenu.Item>
								))}
							</>
						)}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			<Tooltip label="Clear selection" className="max-md:hidden">
				<Button variant="ghost" size="sm" onClick={onClearSelection} disabled={pending} aria-label="Clear selection">
					<X className="h-4 w-4" />
				</Button>
			</Tooltip>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<Button variant="ghost" size="sm" className="md:hidden" disabled={pending} aria-label="More actions">
						<MoreVertical className="h-4 w-4" />
					</Button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						align="end"
						sideOffset={4}
						className="z-[130] min-w-44 rounded-xl border border-neutral-200 bg-white p-1 shadow-xl md:hidden"
					>
						<DropdownMenu.Item className={menuItemClass} onSelect={() => onAction(archive.action as BulkMessageAction)}>
							<archive.Icon className="h-4 w-4" />
							{archive.label}
						</DropdownMenu.Item>
						<DropdownMenu.Item className={menuItemClass} onSelect={() => onAction(spam.action as BulkMessageAction)}>
							<spam.Icon className="h-4 w-4" />
							{spam.label}
						</DropdownMenu.Item>
						{canDeleteForever && (
							<DropdownMenu.Item className={`${menuItemClass} text-red-600`} onSelect={() => onAction("delete")}>
								<Trash2 className="h-4 w-4" />
								Delete forever
							</DropdownMenu.Item>
						)}
						<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
						<DropdownMenu.Item className={menuItemClass} onSelect={onClearSelection}>
							<X className="h-4 w-4" />
							Clear selection
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</div>
	);
}

"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip } from "@/components/ui/tooltip";
import { getEmptyFolderLabel } from "@/lib/messages/permanent-delete-utils";
import { BulkMessageToolbar } from "./bulk-message-toolbar";
import { FolderHeading } from "./folder-heading";
import type { MessageListFilter, MessageListHeaderProps } from "./message-list-header-types";
import { getSelectionToolbarFolder } from "./utils";

const FILTERS: Array<{ value: MessageListFilter; label: string }> = [
	{ value: "all", label: "All mail" },
	{ value: "unread", label: "Unread" },
];

/**
 * "All mail" and "Unread" over the list, as in the mail clients Kite's layout follows. They filter the list
 * below rather than switch panels, so they are pressed toggle buttons, not tabs.
 */
function ListFilterToggle({ filter }: { filter: NonNullable<MessageListHeaderProps["filter"]> }) {
	return (
		<div
			role="group"
			aria-label="Show"
			className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-neutral-100 p-0.5"
		>
			{FILTERS.map((option) => {
				const pressed = filter.value === option.value;
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={pressed}
						onClick={() => filter.onChange(option.value)}
						className={clsx(
							"inline-flex cursor-pointer items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600",
							pressed ? "bg-white text-blue-700 shadow-sm" : "text-neutral-600 hover:text-neutral-900",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

function ListPager({ pager, compact }: Pick<MessageListHeaderProps, "pager" | "compact">) {
	return (
		<div className={clsx("flex items-center gap-1 text-neutral-500", compact && "ml-auto")}>
			<span className="whitespace-nowrap px-1 text-xs text-neutral-500">
				{pager.range.start} - {pager.range.end} of {pager.range.total}
			</span>
			<Tooltip label="Previous page">
				<Button
					variant="ghost"
					size="sm"
					disabled={!pager.canPrevious}
					onClick={pager.previous}
					aria-label="Previous page"
				>
					<ChevronLeft className="h-4 w-4" />
				</Button>
			</Tooltip>
			<Tooltip label="Next page">
				<Button variant="ghost" size="sm" disabled={!pager.canNext} onClick={pager.next} aria-label="Next page">
					<ChevronRight className="h-4 w-4" />
				</Button>
			</Tooltip>
		</div>
	);
}

function EmptyFolderButton({
	emptyFolder,
	compact,
}: {
	emptyFolder: NonNullable<MessageListHeaderProps["emptyFolder"]>;
	compact: boolean;
}) {
	const label = getEmptyFolderLabel(emptyFolder.folder);
	return (
		<Tooltip label={label}>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				aria-label={label}
				disabled={emptyFolder.disabled}
				onClick={emptyFolder.run}
				className="gap-1.5 text-xs font-medium text-red-600 hover:text-red-700"
			>
				<Trash2 className="h-4 w-4" />
				{!compact && <span className="max-md:hidden">{emptyFolder.emptying ? "Emptying…" : label}</span>}
			</Button>
		</Tooltip>
	);
}

/** The top of a folder list: its title, the select-all box or the bulk toolbar, the unread filter and paging. */
export function MessageListHeader({
	config,
	compact,
	showTitle,
	nested,
	selection,
	filter,
	pager,
	emptyFolder,
}: MessageListHeaderProps) {
	const bulk = selection.count > 0 && !compact;
	const headerIcons = config.headerIcons ?? [];
	const tools = (
		<>
			{emptyFolder && <EmptyFolderButton emptyFolder={emptyFolder} compact={compact} />}
			{!compact && headerIcons.map((Icon, index) => <Icon key={index} className="h-4 w-4 text-neutral-500" />)}
		</>
	);
	return (
		<div className="shrink-0 border-b border-neutral-200">
			<div className={clsx("flex h-14 items-center gap-3", compact ? "px-4" : "px-4.5 md:px-6")}>
				<FolderHeading title={config.title} nested={nested} />
				<Tooltip label="Select all visible messages">
					<Checkbox
						checked={selection.allVisible}
						disabled={selection.disabled}
						onChange={(event) => selection.toggleAll(event.target.checked)}
						aria-label="Select all visible messages"
					/>
				</Tooltip>
				{bulk ? (
					<BulkMessageToolbar
						selectedCount={selection.count}
						hasUnreadSelection={selection.hasUnread}
						onAction={selection.run}
						onClearSelection={selection.clear}
						pending={selection.pending}
						folder={getSelectionToolbarFolder(config)}
						mailboxIds={selection.mailboxIds}
					/>
				) : (
					showTitle && (
						<p aria-hidden="true" className="min-w-0 truncate pl-1 text-base font-semibold text-neutral-900">
							{config.title}
						</p>
					)
				)}
				{!bulk && (
					<div className="ml-auto flex shrink-0 items-center gap-2">
						{filter && <ListFilterToggle filter={filter} />}
						{!compact && <ListPager pager={pager} compact={false} />}
						{!compact && tools}
					</div>
				)}
			</div>
			{compact && (
				<div className="flex h-9 items-center gap-1 border-t border-neutral-100 px-3">
					{tools}
					<ListPager pager={pager} compact />
				</div>
			)}
		</div>
	);
}

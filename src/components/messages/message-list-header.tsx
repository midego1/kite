"use client";

import clsx from "clsx";
import Link from "next/link";
import { Check, ChevronLeft, ChevronRight, PanelLeft, SlidersHorizontal, Trash2 } from "lucide-react";
import { MailSearchInput } from "@/components/mail-search/mail-search-input";
import { useSidebar } from "@/components/sidebar-state";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Tooltip } from "@/components/ui/tooltip";
import { getEmptyFolderLabel } from "@/lib/messages/permanent-delete-utils";
import { BulkMessageToolbar } from "./bulk-message-toolbar";
import { FolderHeading } from "./folder-heading";
import type { MessageListHeaderProps } from "./message-list-header-types";
import { MessageListChips } from "./message-list-chips";
import { getSelectionToolbarFolder } from "./utils";

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

/** Zero's panel icon at the top left of the list: hides or shows the sidebar (desktop only). */
function SidebarToggleButton() {
	const { minimal, toggle } = useSidebar();
	const label = minimal ? "Show menu" : "Hide menu";
	return (
		<Tooltip label={label}>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				aria-label={label}
				onClick={toggle}
				className="h-8 w-8 shrink-0 p-0 text-neutral-500 hover:text-neutral-900 max-md:hidden"
			>
				<PanelLeft className="h-4 w-4" />
			</Button>
		</Tooltip>
	);
}

/**
 * The top of a folder list, after Zero's: the panel icon, the title, "Select" and the list settings, then the
 * search field and the category chips. Checkboxes show while selecting; the bulk toolbar replaces the title
 * once something is selected. The pager row appears only when there is more than one page.
 */
export function MessageListHeader({
	config,
	compact,
	selectionInPane,
	nested,
	selection,
	selecting,
	filter,
	pager,
	emptyFolder,
	screenerVisible,
}: MessageListHeaderProps) {
	// Only a selection pane beside the list replaces the toolbar; compact styling alone (a phone) must not.
	const bulk = selection.count > 0 && !selectionInPane;
	const headerIcons = config.headerIcons ?? [];
	const paged = pager.canPrevious || pager.canNext;
	return (
		<div className="shrink-0">
			<div className="flex h-14 items-center gap-2 border-b border-neutral-200 px-3">
				<FolderHeading title={config.title} nested={nested} />
				<SidebarToggleButton />
				{(selecting.value || selection.count > 0) && (
					<Tooltip label="Select all visible messages">
						<Checkbox
							checked={selection.allVisible}
							disabled={selection.disabled}
							onChange={(event) => selection.toggleAll(event.target.checked)}
							aria-label="Select all visible messages"
						/>
					</Tooltip>
				)}
				{bulk ? (
					<BulkMessageToolbar
						selectedCount={selection.count}
						hasUnreadSelection={selection.hasUnread}
						onAction={selection.run}
						onClearSelection={selection.clear}
						pending={selection.pending}
						folder={getSelectionToolbarFolder(config)}
					/>
				) : (
					<p aria-hidden="true" className="min-w-0 truncate text-base font-medium text-neutral-900">
						{config.title}
					</p>
				)}
				{!bulk && (
					<div className="ml-auto flex shrink-0 items-center gap-1">
						{emptyFolder && <EmptyFolderButton emptyFolder={emptyFolder} compact={compact} />}
						{!compact && headerIcons.map((Icon, index) => <Icon key={index} className="h-4 w-4 text-neutral-500" />)}
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-pressed={selecting.value}
							onClick={() => selecting.onChange(!selecting.value)}
							className={clsx(
								"h-8 gap-1.5 px-2 text-sm font-normal",
								selecting.value ? "bg-neutral-100 text-neutral-900" : "text-neutral-500 hover:text-neutral-900",
							)}
						>
							<Check className="h-4 w-4" />
							Select
						</Button>
						<Separator orientation="vertical" className="mx-1 h-4" />
						<Tooltip label="List settings">
							<Link
								href="/settings/inbox"
								aria-label="List settings"
								className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
							>
								<SlidersHorizontal className="h-4 w-4" />
							</Link>
						</Tooltip>
					</div>
				)}
			</div>
			<div className="flex flex-col gap-3 px-3 pb-2 pt-3">
				<MailSearchInput variant="panel" />
				<MessageListChips config={config} filter={filter} screenerVisible={screenerVisible} />
			</div>
			{paged && !bulk && (
				<div className="flex h-8 items-center justify-end px-3">
					<ListPager pager={pager} compact />
				</div>
			)}
		</div>
	);
}

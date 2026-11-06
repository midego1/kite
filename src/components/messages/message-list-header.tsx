"use client";

import clsx from "clsx";
import Link from "next/link";
import { useLayoutEffect } from "react";
import { Check, PanelLeft, SlidersHorizontal, Trash2 } from "lucide-react";
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
import { useT } from "@/lib/i18n/use-t";

function EmptyFolderButton({
	emptyFolder,
	compact,
}: {
	emptyFolder: NonNullable<MessageListHeaderProps["emptyFolder"]>;
	compact: boolean;
}) {
	const t = useT();
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
				{!compact && <span className="max-md:hidden">{emptyFolder.emptying ? t("Emptying…") : label}</span>}
			</Button>
		</Tooltip>
	);
}

/**
 * Zero's panel icon at the left of the title: collapses the expanded sidebar to its icon rail (desktop only). It
 * tells the sidebar header to drop its own button while it is here; the collapsed rail keeps its Expand button.
 */
function SidebarToggleButton({ listVisible }: { listVisible: boolean }) {
	const t = useT();
	const { minimal, mobile, toggle, setToggleInListHeader } = useSidebar();
	// A hidden list panel stays mounted, so it must not claim a toggle nobody can see.
	const shown = !minimal && !mobile && listVisible;
	useLayoutEffect(() => {
		setToggleInListHeader(shown);
		return () => setToggleInListHeader(false);
	}, [shown, setToggleInListHeader]);
	if (!shown) return null;
	return (
		<Tooltip label={t("Collapse menu")}>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				aria-label={t("Collapse menu")}
				onClick={toggle}
				className="h-8 w-8 shrink-0 p-0 text-neutral-500 hover:text-neutral-900 max-md:hidden"
			>
				<PanelLeft className="h-4 w-4 rtl:-scale-x-100" />
			</Button>
		</Tooltip>
	);
}

/**
 * The top of a folder list, after Zero's: the panel icon (while the sidebar is expanded), the title, "Select" and the list settings, then the
 * search field and the category chips. Checkboxes show while selecting; the bulk toolbar replaces the title
 * once something is selected. Below 20rem of list width "Select" shows only its icon, so the title keeps the room.
 */
export function MessageListHeader({
	config,
	compact,
	selectionInPane,
	nested,
	selection,
	selecting,
	filter,
	emptyFolder,
	screenerVisible,
	listVisible,
}: MessageListHeaderProps) {
	const t = useT();
	// Only a selection pane beside the list replaces the toolbar; compact styling alone (a phone) must not.
	const bulk = selection.count > 0 && !selectionInPane;
	const headerIcons = config.headerIcons ?? [];
	return (
		<div className="@container shrink-0">
			<div className="flex h-14 items-center gap-2 border-b border-neutral-200 px-3">
				<FolderHeading title={folderTitle(config)} nested={nested} />
				<SidebarToggleButton listVisible={listVisible} />
				{(selecting.value || selection.count > 0) && (
					<Tooltip label={t("Select all visible messages")}>
						<Checkbox
							checked={selection.allVisible}
							disabled={selection.disabled}
							onChange={(event) => selection.toggleAll(event.target.checked)}
							aria-label={t("Select all visible messages")}
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
						mailboxIds={selection.mailboxIds}
						hasDraftSelection={selection.hasDrafts}
						hasPendingSendSelection={selection.hasPendingSend}
					/>
				) : (
					<p
						aria-hidden="true"
						title={folderTitle(config)}
						className="min-w-0 truncate text-base font-medium text-neutral-900"
					>
						{folderTitle(config)}
					</p>
				)}
				{!bulk && (
					<div className="ms-auto flex shrink-0 items-center gap-1">
						{emptyFolder && <EmptyFolderButton emptyFolder={emptyFolder} compact={compact} />}
						{!compact && headerIcons.map((Icon, index) => <Icon key={index} className="h-4 w-4 text-neutral-500" />)}
						<Tooltip label={t("Select messages")}>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label={t("Select")}
								aria-pressed={selecting.value}
								onClick={() => selecting.onChange(!selecting.value)}
								className={clsx(
									"h-8 gap-1.5 px-2 text-sm font-normal",
									selecting.value ? "bg-neutral-100 text-neutral-900" : "text-neutral-500 hover:text-neutral-900",
								)}
							>
								<Check className="h-4 w-4" />
								<span className="@max-[20rem]:hidden">{t("Select")}</span>
							</Button>
						</Tooltip>
						<Separator orientation="vertical" className="mx-1 h-4" />
						<Tooltip label={t("List settings")}>
							<Link
								href="/settings/inbox"
								aria-label={t("List settings")}
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
		</div>
	);
}

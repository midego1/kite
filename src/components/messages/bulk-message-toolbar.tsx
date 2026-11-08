"use client";

import clsx from "clsx";
import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	ChevronRight,
	Folder,
	FolderInput,
	Inbox,
	Mail,
	MailOpen,
	MoreVertical,
	ShieldAlert,
	ShieldCheck,
	ShieldX,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useBulkSelectionAccess } from "./use-bulk-selection-access";
import { useBulkToolbarOverflow } from "./use-bulk-toolbar-overflow";
import { supportsPermanentDelete } from "@/lib/messages/permanent-delete-utils";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { BulkMessageToolbarProps } from "./types";
import { useT } from "@/lib/i18n/use-t";

const menuItemClass =
	"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100 pointer-coarse:py-3";
const menuLabelClass = "mt-1 px-3 pb-1 pt-2 text-sm font-medium text-neutral-500";
const menuContentClass =
	"z-[130] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-54 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg";

/** An action button of the toolbar: icon and label together, since whether it is shown inline at all (rather
 * than folded into "More actions") already accounts for the room its label needs. */
function ToolbarButton({
	label,
	icon: Icon,
	onClick,
	disabled,
	destructive,
}: {
	label: string;
	icon: LucideIcon;
	onClick: () => void;
	disabled?: boolean;
	destructive?: boolean;
}) {
	return (
		<Tooltip label={label}>
			<Button
				variant="ghost"
				size="sm"
				onClick={onClick}
				disabled={disabled}
				aria-label={label}
				className={clsx("gap-1.5", destructive && "text-red-600 hover:text-red-700")}
			>
				<Icon className="h-4 w-4" />
				<span className="text-xs font-medium">{label}</span>
			</Button>
		</Tooltip>
	);
}

/** The "Move to" dropdown's own trigger button, shared between the real inline trigger and its hidden
 * measurement clone so the two are always exactly the same width. Forwards its ref and every prop
 * (`DropdownMenu.Trigger asChild` clones onClick, aria-haspopup, aria-expanded and a ref onto it): without
 * that the trigger renders but never actually opens anything. */
const MoveToTriggerButton = forwardRef<HTMLButtonElement, ButtonProps>(function MoveToTriggerButton(props, ref) {
	const t = useT();
	return (
		<Button
			variant="ghost"
			size="sm"
			className="gap-1.5 bg-white text-xs font-medium text-neutral-700"
			ref={ref}
			{...props}
		>
			<FolderInput className="h-4 w-4" />
			{t("Move to")}
			<ChevronDown className="h-3.5 w-3.5 text-neutral-500" />
		</Button>
	);
});

/** Shown in the move menu instead of folders when the selection spans mailboxes. */
function CrossMailboxFolderHint({ show }: { show: boolean }) {
	const t = useT();
	if (!show) return null;
	return (
		<>
			<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
			<p className="px-3 py-2 text-xs text-neutral-500">{t("Select mail from one mailbox to move it to a folder.")}</p>
		</>
	);
}

type MoveTarget = { value: string; label: string; Icon: LucideIcon };
type MoveMenuFolder = { id: string; name: string; color: string };

/**
 * The folder destinations of "Move to", shared between its own dropdown (shown inline when there is room)
 * and the "Move to" entry of "More actions" (a submenu, reached when there is not): the choices themselves
 * never depend on how they are reached.
 */
function MoveMenuItems({
	moveOptions,
	phishingItem,
	spansMailboxes,
	folders,
	onAction,
}: {
	moveOptions: MoveTarget[];
	phishingItem: ReactNode;
	spansMailboxes: boolean;
	folders: MoveMenuFolder[];
	onAction: (action: BulkMessageAction, folderId?: string) => void;
}) {
	const t = useT();
	return (
		<>
			{moveOptions.map(({ value, label, Icon }) => (
				<DropdownMenu.Item key={value} className={menuItemClass} onSelect={() => onAction(value as BulkMessageAction)}>
					<Icon className="h-4 w-4" />
					{label}
				</DropdownMenu.Item>
			))}
			{phishingItem}
			<CrossMailboxFolderHint show={spansMailboxes} />
			{folders.length > 0 && (
				<>
					<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
					<DropdownMenu.Label className={menuLabelClass}>{t("Folders")}</DropdownMenu.Label>
					{folders.map((item) => (
						<DropdownMenu.Item key={item.id} className={menuItemClass} onSelect={() => onAction("folder", item.id)}>
							<Folder className="h-4 w-4 shrink-0" style={{ color: item.color }} />
							<span className="truncate">{item.name}</span>
						</DropdownMenu.Item>
					))}
				</>
			)}
		</>
	);
}

/**
 * The selection toolbar of the Drafts list. Drafts are private to their author and leave Drafts only by being
 * sent or deleted, so it offers Delete (which removes them outright) and nothing that moves them.
 */
function DraftSelectionToolbar({
	selectedCount,
	hideSelectedCount,
	onAction,
	onClearSelection,
	pending,
}: Pick<BulkMessageToolbarProps, "selectedCount" | "hideSelectedCount" | "onAction" | "onClearSelection" | "pending">) {
	const t = useT();
	return (
		<div
			data-testid="bulk-toolbar"
			className="flex min-w-0 items-center gap-2 text-neutral-600 w-full pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11"
		>
			{!hideSelectedCount && (
				<span className="me-2 text-sm font-medium text-neutral-800">
					{t("{count} selected", { count: selectedCount })}
				</span>
			)}
			<span className="flex-1 md:hidden" />
			<ToolbarButton label={t("Delete")} icon={Trash2} onClick={() => onAction("trash")} disabled={pending} />
			<span className="flex-1 max-md:hidden" />
			<Tooltip label={t("Clear selection")}>
				<Button
					variant="ghost"
					size="sm"
					onClick={onClearSelection}
					disabled={pending}
					aria-label={t("Clear selection")}
				>
					<X className="h-4 w-4" />
				</Button>
			</Tooltip>
		</div>
	);
}

export function BulkMessageToolbar(props: BulkMessageToolbarProps) {
	return props.folder === "drafts" ? <DraftSelectionToolbar {...props} /> : <MailSelectionToolbar {...props} />;
}

/** The user may always delete their own drafts, unless the selection also holds a send waiting to go out. */
function canDeleteOwnDrafts(
	selection: Pick<BulkMessageToolbarProps, "hasDraftSelection" | "hasPendingSendSelection" | "pending">,
) {
	return !!selection.hasDraftSelection && !selection.hasPendingSendSelection && !selection.pending;
}

type ActionItem = {
	id: string;
	label: string;
	Icon: LucideIcon;
	action: BulkMessageAction;
	disabled?: boolean;
	destructive?: boolean;
};

const MOVE_TO_ID = "moveTo";

function MailSelectionToolbar({
	selectedCount,
	hasUnreadSelection,
	hideSelectedCount = false,
	onAction,
	onClearSelection,
	pending,
	folder,
	mailboxIds,
	hasDraftSelection,
	hasPendingSendSelection,
}: BulkMessageToolbarProps) {
	const t = useT();
	// In archived, spam and trash the usual button would be a no-op, so it becomes the way back to the inbox.
	const archive =
		folder === "archived"
			? { action: "inbox", label: t("Unarchive"), Icon: ArchiveRestore }
			: { action: "archive", label: t("Archive"), Icon: Archive };
	const spam =
		folder === "spam"
			? { action: "inbox", label: t("Not spam"), Icon: ShieldCheck }
			: { action: "spam", label: t("Report spam"), Icon: ShieldAlert };
	const trash =
		folder === "trash"
			? { action: "inbox", label: t("Restore"), Icon: Undo2 }
			: { action: "trash", label: t("Delete"), Icon: Trash2 };
	// Trash and Spam also offer the irreversible delete; the page confirms before running it.
	const canDeleteForever = supportsPermanentDelete(folder);
	const moveOptions = [
		{ value: "inbox", label: t("Inbox"), Icon: Inbox, hidden: folder === "inbox" },
		{ value: "archive", label: t("Archived"), Icon: Archive, hidden: folder === "archived" },
		{ value: "spam", label: t("Spam"), Icon: ShieldAlert, hidden: folder === "spam" },
		{ value: "trash", label: t("Trash"), Icon: Trash2, hidden: folder === "trash" },
	].filter((option) => !option.hidden);
	// Only received mail can be reported; the server skips anything else.
	const canReportPhishing = folder !== "sent" && folder !== "drafts";
	const phishingItem = canReportPhishing && (
		<DropdownMenu.Item className={`${menuItemClass} text-red-600`} onSelect={() => onAction("phishing")}>
			<ShieldX className="h-4 w-4" />
			{t("Report phishing")}
		</DropdownMenu.Item>
	);
	const { folders, spansMailboxes, manageDisabled: accessDisabled } = useBulkSelectionAccess(mailboxIds, pending);
	// A message waiting to be sent goes out wherever it is filed, so nothing that moves it is offered.
	const manageDisabled = accessDisabled || hasPendingSendSelection;
	const trashDisabled = manageDisabled && !canDeleteOwnDrafts({ hasDraftSelection, hasPendingSendSelection, pending });

	// Priority order, highest first: the single most useful action (get rid of the mail) leads, the rest
	// follow roughly by how often they are reached for; "Move to" is last since it is also the widest.
	const items: ActionItem[] = [
		{
			id: "trash",
			label: trash.label,
			Icon: trash.Icon,
			action: trash.action as BulkMessageAction,
			disabled: trashDisabled,
		},
		{
			id: "archive",
			label: archive.label,
			Icon: archive.Icon,
			action: archive.action as BulkMessageAction,
			disabled: manageDisabled,
		},
		{
			id: "markRead",
			label: hasUnreadSelection ? t("Mark as read") : t("Mark as unread"),
			Icon: hasUnreadSelection ? MailOpen : Mail,
			action: (hasUnreadSelection ? "read" : "unread") as BulkMessageAction,
			disabled: pending,
		},
		...(canDeleteForever
			? [
					{
						id: "deleteForever",
						label: t("Delete forever"),
						Icon: Trash2,
						action: "delete" as BulkMessageAction,
						disabled: manageDisabled,
						destructive: true,
					},
				]
			: []),
		{
			id: "spam",
			label: spam.label,
			Icon: spam.Icon,
			action: spam.action as BulkMessageAction,
			disabled: manageDisabled,
		},
	];
	const priorityIds = [...items.map((item) => item.id), MOVE_TO_ID];
	// Recomputed whenever any of these can change an item's natural width, not just on resize.
	const measureKey = [
		selectedCount,
		folder,
		hasUnreadSelection,
		canDeleteForever,
		manageDisabled,
		trashDisabled,
		pending,
	].join("|");
	const { containerRef, headRef, tailRef, measureRef, visibleIds } = useBulkToolbarOverflow(priorityIds, measureKey);
	const overflowIds = priorityIds.filter((id) => !visibleIds.has(id));
	const hasOverflow = overflowIds.length > 0;
	const overflowItems = items.filter((item) => overflowIds.includes(item.id));
	const moveToOverflowed = overflowIds.includes(MOVE_TO_ID);

	return (
		<div
			ref={containerRef}
			data-testid="bulk-toolbar"
			className="relative flex min-w-0 items-center gap-2 overflow-hidden text-neutral-600 w-full pointer-coarse:[&_button]:min-h-11 pointer-coarse:[&_button]:min-w-11"
		>
			<div ref={headRef} className="flex shrink-0 items-center">
				{!hideSelectedCount && (
					<span className="me-2 max-w-36 truncate text-sm font-medium text-neutral-800">
						{t("{count} selected", { count: selectedCount })}
					</span>
				)}
			</div>
			{items
				.filter((item) => visibleIds.has(item.id))
				.map((item) => (
					<ToolbarButton
						key={item.id}
						label={item.label}
						icon={item.Icon}
						onClick={() => onAction(item.action)}
						disabled={item.disabled}
						destructive={item.destructive}
					/>
				))}
			{visibleIds.has(MOVE_TO_ID) && (
				<DropdownMenu.Root>
					<Tooltip label={t("Move selected messages")}>
						<DropdownMenu.Trigger asChild>
							<MoveToTriggerButton disabled={manageDisabled} />
						</DropdownMenu.Trigger>
					</Tooltip>
					<DropdownMenu.Portal>
						<DropdownMenu.Content align="end" sideOffset={4} className={menuContentClass}>
							<MoveMenuItems
								moveOptions={moveOptions}
								phishingItem={phishingItem}
								spansMailboxes={spansMailboxes}
								folders={folders}
								onAction={onAction}
							/>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			)}
			<span className="flex-1" />
			<div ref={tailRef} className="flex shrink-0 items-center gap-2">
				{/* Small enough that it always has room: dismissing the toolbar is too common a thing to do to
				    hide behind "More actions" just because the row is narrow. The overflow menu still repeats
				    it for the touch target it gives a coarse pointer. */}
				<Tooltip label={t("Clear selection")}>
					<Button
						variant="ghost"
						size="sm"
						onClick={onClearSelection}
						disabled={pending}
						aria-label={t("Clear selection")}
					>
						<X className="h-4 w-4" />
					</Button>
				</Tooltip>
			</div>
			{hasOverflow && (
				<DropdownMenu.Root>
					<DropdownMenu.Trigger asChild>
						<Button variant="ghost" size="sm" disabled={pending} aria-label={t("More actions")}>
							<MoreVertical className="h-4 w-4" />
						</Button>
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content
							align="end"
							sideOffset={4}
							className="z-[130] min-w-44 rounded-xl border border-neutral-200 bg-white p-1 shadow-xl"
						>
							{overflowItems.map((item) => (
								<DropdownMenu.Item
									key={item.id}
									className={clsx(menuItemClass, item.destructive && "text-red-600")}
									disabled={item.disabled}
									onSelect={() => onAction(item.action)}
								>
									<item.Icon className="h-4 w-4" />
									{item.label}
								</DropdownMenu.Item>
							))}
							{moveToOverflowed && (
								<DropdownMenu.Sub>
									<DropdownMenu.SubTrigger className={clsx(menuItemClass, "justify-between")} disabled={manageDisabled}>
										<span className="flex items-center gap-2">
											<FolderInput className="h-4 w-4" />
											{t("Move to")}
										</span>
										<ChevronRight aria-hidden className="h-4 w-4 text-neutral-400 rtl:-scale-x-100" />
									</DropdownMenu.SubTrigger>
									<DropdownMenu.Portal>
										<DropdownMenu.SubContent sideOffset={4} className={menuContentClass}>
											<MoveMenuItems
												moveOptions={moveOptions}
												phishingItem={phishingItem}
												spansMailboxes={spansMailboxes}
												folders={folders}
												onAction={onAction}
											/>
										</DropdownMenu.SubContent>
									</DropdownMenu.Portal>
								</DropdownMenu.Sub>
							)}
							{/* "Report phishing" always lives inside the Move-to menu (inline or, here, its submenu), as it
							    does for the inline dropdown above: never duplicated as a standalone entry too. */}
							<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
							<DropdownMenu.Item className={menuItemClass} onSelect={onClearSelection}>
								<X className="h-4 w-4" />
								{t("Clear selection")}
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			)}
			{/* Hidden measurement clone: every action at its real, unclipped width (an absolutely positioned,
			    max-content row no layout ever sees), so the hook can tell what actually fits before anything
			    renders into the visible row above. "__more__" stands in for the overflow trigger so its width
			    is always reserved, whether or not it ends up shown. */}
			<div
				aria-hidden="true"
				ref={measureRef}
				className="pointer-events-none absolute start-0 top-0 flex w-max items-center gap-2 opacity-0"
				style={{ visibility: "hidden" }}
			>
				{items.map((item) => (
					<span key={item.id} data-overflow-id={item.id}>
						<ToolbarButton label={item.label} icon={item.Icon} onClick={() => {}} />
					</span>
				))}
				<span data-overflow-id={MOVE_TO_ID}>
					<MoveToTriggerButton />
				</span>
				<span data-overflow-id="__more__">
					<Button variant="ghost" size="sm" aria-hidden="true">
						<MoreVertical className="h-4 w-4" />
					</Button>
				</span>
			</div>
		</div>
	);
}

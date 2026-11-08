"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Archive, ChevronDown, Folder, Mail, MailOpen, MoreVertical, ShieldAlert, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBulkSelectionAccess } from "./use-bulk-selection-access";
import { isMessageSnoozed, unsnoozeMessage } from "./message-list-row-actions-utils";
import { SnoozeMenuItem } from "./snooze-picker";
import { reportListActionError } from "./list-action-toast";
import type { RowActionsMenuProps } from "./types";
import { useT } from "@/lib/i18n/use-t";

const ITEM_CLASS =
	"flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400";

/** The "Move to" entry's own destinations beside the sheet's own Archive and Trash: Report spam, then folders. */
function MoveToSection({
	mailboxId,
	onAction,
	onDone,
}: {
	mailboxId?: string;
	onAction: RowActionsMenuProps["onAction"];
	onDone: () => void;
}) {
	const t = useT();
	const { folders, manageDisabled } = useBulkSelectionAccess(mailboxId ? [mailboxId] : undefined, false);
	return (
		<>
			<button
				type="button"
				className={ITEM_CLASS}
				disabled={manageDisabled}
				onClick={() => {
					onDone();
					void onAction("spam");
				}}
			>
				<ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
				{t("Report spam")}
			</button>
			{folders.map((folder) => (
				<button
					key={folder.id}
					type="button"
					className={ITEM_CLASS}
					disabled={manageDisabled}
					onClick={() => {
						onDone();
						void onAction("folder", folder.id);
					}}
				>
					<Folder className="h-4 w-4 shrink-0" aria-hidden="true" style={{ color: folder.color }} />
					<span className="truncate">{folder.name}</span>
				</button>
			))}
		</>
	);
}

/** A "Move to" entry for the hand-rolled sheet menu, after `SnoozeMenuItem`: expands into its destinations below it. */
function MoveToMenuItem({
	mailboxId,
	expanded,
	onExpandedChange,
	onAction,
	onDone,
}: {
	mailboxId?: string;
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	onAction: RowActionsMenuProps["onAction"];
	onDone: () => void;
}) {
	const t = useT();
	return (
		<div data-move-expanded={expanded}>
			<button type="button" className={ITEM_CLASS} aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)}>
				<Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
				{t("Move to")}
				<ChevronDown
					className={cn("ms-auto h-4 w-4 shrink-0 text-neutral-400 transition-transform", expanded && "rotate-180")}
				/>
			</button>
			{expanded && (
				<div className="mb-1 ms-3 border-s border-neutral-100 ps-1">
					<MoveToSection mailboxId={mailboxId} onAction={onAction} onDone={onDone} />
				</div>
			)}
		</div>
	);
}

/**
 * The phone/touch answer to the mouse hover pill (`MessageListRowActions`): a single always-visible ⋯ trigger,
 * at least 44px, opening a bottom sheet with every row action as a full-height list item — reachable without
 * hovering, and without halving the list's density the way an always-on action bar under every row would
 * (see docs/foldable-layout.md#touch-reachability). Used for both the stacked and the wide row.
 */
export function RowActionsMenu({ message, party, onAction, star, compact = false }: RowActionsMenuProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [snoozeExpanded, setSnoozeExpanded] = useState(false);
	const [moveExpanded, setMoveExpanded] = useState(false);
	const snoozed = isMessageSnoozed(message.snoozedUntil);
	const readAction = message.read ? "unread" : "read";

	function close() {
		setOpen(false);
		setSnoozeExpanded(false);
		setMoveExpanded(false);
	}

	function run(action: Parameters<typeof onAction>[0], folderId?: string) {
		close();
		void onAction(action, folderId);
	}

	return (
		<Dialog.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
			<Dialog.Trigger asChild>
				<button
					type="button"
					onClick={(event) => event.stopPropagation()}
					aria-label={t("More actions for {party}", { party })}
					aria-haspopup="dialog"
					className={cn(
						"hidden items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900",
						"pointer-coarse:flex pointer-coarse:h-11 pointer-coarse:w-11",
						// The stacked row is only tall enough for one row of 44px controls, not a star at the top
						// and this at the bottom: both sit at the same bottom corner instead, side by side — end-0
						// is the star's own slot (RowCornerStar), so this takes the next one over when a star
						// exists, else the corner itself.
						compact
							? cn("absolute bottom-0 z-10", star ? "end-11" : "end-0")
							: "absolute end-2 top-1/2 z-10 -translate-y-1/2",
					)}
				>
					<MoreVertical className="h-4 w-4" aria-hidden="true" />
				</button>
			</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay fixed inset-0 z-[100] bg-black/40" />
				<Dialog.Content
					onClick={(event) => event.stopPropagation()}
					className="fixed inset-x-0 bottom-0 z-[110] max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl focus:outline-none"
				>
					<Dialog.Title className="sr-only">{t("More actions for {party}", { party })}</Dialog.Title>
					<div aria-hidden="true" className="flex justify-center pt-3">
						<span className="h-1.5 w-10 rounded-full bg-neutral-300" />
					</div>
					<div className="space-y-0.5 p-2">
						{star && (
							<button
								type="button"
								className={ITEM_CLASS}
								onClick={(event) => {
									close();
									star.onToggle(event);
								}}
							>
								<star.icon
									className={cn("h-4 w-4 shrink-0", star.starred && "fill-amber-400 text-amber-400")}
									aria-hidden="true"
								/>
								{star.starred ? t("Unstar") : t("Star")}
							</button>
						)}
						<button type="button" className={ITEM_CLASS} onClick={() => run(readAction)}>
							{readAction === "read" ? (
								<MailOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
							) : (
								<Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
							)}
							{readAction === "read" ? t("Mark as read") : t("Mark as unread")}
						</button>
						{snoozed ? (
							<button
								type="button"
								className={ITEM_CLASS}
								onClick={() => {
									close();
									void unsnoozeMessage(message.id).catch(reportListActionError);
								}}
							>
								<ChevronDown className="h-4 w-4 shrink-0 rotate-180" aria-hidden="true" />
								{t("Unsnooze")}
							</button>
						) : (
							<SnoozeMenuItem
								messageId={message.id}
								expanded={snoozeExpanded}
								onExpandedChange={setSnoozeExpanded}
								onSnoozed={close}
							/>
						)}
						<MoveToMenuItem
							mailboxId={message.mailboxId ?? undefined}
							expanded={moveExpanded}
							onExpandedChange={setMoveExpanded}
							onAction={onAction}
							onDone={close}
						/>
						<button type="button" className={ITEM_CLASS} onClick={() => run("archive")}>
							<Archive className="h-4 w-4 shrink-0" aria-hidden="true" />
							{t("Archive")}
						</button>
						<button type="button" className={cn(ITEM_CLASS, "text-red-600")} onClick={() => run("trash")}>
							<Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
							{t("Trash")}
						</button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

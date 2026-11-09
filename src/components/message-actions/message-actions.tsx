"use client";

import clsx from "clsx";
import { createElement, useState, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import * as Popover from "@radix-ui/react-popover";
import {
	Archive,
	Ban,
	BellOff,
	FileCode2,
	Sparkles,
	Forward,
	Mail,
	MailOpen,
	MoreVertical,
	Reply,
	ReplyAll,
	ShieldAlert,
	Trash2,
} from "lucide-react";
import { MessageTranslateItem } from "@/components/messages/message-translate-item";
import { MessageSourceDialog } from "@/components/messages/message-source-dialog";
import { useMessageListHref } from "@/components/messages/message-detail-navigation";
import { useRowMessageIds } from "@/components/messages/open-row-context";
import { useListSelectionCount } from "@/components/messages/list-selection-context";
import { SnoozeMenuItem } from "@/components/messages/snooze-picker";
import { printShortcutAction } from "@/components/messages/print/print-actions";
import { PrintMenuItems } from "@/components/messages/print/print-menu-items";
import { useMessageMenuSlots } from "./message-menu-slots";
import { ReportPhishingItem } from "./report-phishing-item";
import { confirmReportPhishing } from "@/components/messages/phishing-report";
import { confirmReportSpam } from "@/components/messages/spam-report";
import { messageShortcuts, reachableMessageShortcuts } from "./message-shortcuts";
import { useMessageReply } from "./use-message-reply";
import { useReadOnlyMail } from "./use-read-only-mail";
import { MoveToolbarMenu, SnoozeToolbarButton, ToolbarFolderButtons } from "./message-toolbar-menus";
import { OVERFLOW_FIXED_ATTR, OVERFLOW_ID_ATTR, useReaderToolbarOverflow } from "./use-reader-toolbar-overflow";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useHotkeys, useShortcuts } from "@/components/shortcuts";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MessageActionsProps } from "./types";
import {
	getPermanentDeleteConfirmText,
	PartialDeleteError,
	supportsPermanentDelete,
} from "@/lib/messages/permanent-delete-utils";
import {
	confirmTrashWithoutUnsubscribe,
	blockMessageContact,
	createTrashSenderRule,
	getMessageBackHref,
	getMoveMessageActions,
	movesMessageOutOfList,
	openUnsubscribeUrl,
	runSingleMessageAction,
} from "./utils";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { useT } from "@/lib/i18n/use-t";

export function MessageActions({
	messageId,
	mailboxId,
	senderAddress,
	direction,
	status,
	read,
	unsubscribeUrl,
	subject,
	bodyText,
	ownAddress,
	ownAddresses = [],
	message,
	messageMeta,
	bodyHtml,
	onSummarizeMessage,
	translate,
	print,
}: MessageActionsProps) {
	const t = useT();
	const router = useRouter();
	const isMobile = useIsMobile();
	const { shortcutsEnabled } = useShortcuts();
	const [pendingAction, setPendingAction] = useState<BulkMessageAction | "unsubscribe" | "block" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [moreOpen, setMoreOpen] = useState(false);
	const [sourceOpen, setSourceOpen] = useState(false);
	const [snoozeExpanded, setSnoozeExpanded] = useState(false);
	const moduleSlots = useMessageMenuSlots({ messageId, mailboxId }, moreOpen, () => setMoreOpen(false));
	const layoutListHref = useMessageListHref();
	const listHref = layoutListHref ?? getMessageBackHref(direction, status);
	// Inside a folder layout the layout closes the reader once the message leaves the list
	// (useLeaveOpenMessage); elsewhere the reader goes back to the list itself.
	const leaveReader = useCallback(() => {
		if (!layoutListHref) router.push(listHref);
	}, [layoutListHref, listHref, router]);
	// A move takes what the open message's row stands for: in conversation view, its conversation in this list.
	const rowMessageIds = useRowMessageIds();

	const runUnguarded = useCallback(
		async (action: BulkMessageAction, folderId?: string) => {
			setMoreOpen(false);
			const rowIds = rowMessageIds(messageId);
			// Reporting trains the filter and cannot be fully undone, so every route to it asks first.
			if (action === "spam" && !(await confirmReportSpam(rowIds.length))) return;
			setPendingAction(action);
			setError(null);
			try {
				await runSingleMessageAction(messageId, action, folderId, rowIds);
				if (movesMessageOutOfList(action)) leaveReader();
				else router.refresh();
			} catch {
				setError(t("Could not update message"));
			} finally {
				setPendingAction(null);
			}
		},
		[messageId, leaveReader, router, rowMessageIds],
	);

	// In Trash and Spam the delete button removes the message for good instead of
	// being a no-op, after the user confirms.
	const canDeleteForever = supportsPermanentDelete(status);
	const deleteForever = useCallback(async () => {
		if (
			!(await requestConfirmation({
				title: t("Delete forever?"),
				description: getPermanentDeleteConfirmText(1),
				confirmLabel: t("Delete forever"),
			}))
		)
			return;
		setMoreOpen(false);
		setPendingAction("delete");
		setError(null);
		try {
			await runSingleMessageAction(messageId, "delete");
			leaveReader();
		} catch (deleteError) {
			setError(deleteError instanceof PartialDeleteError ? deleteError.message : t("Could not delete message"));
			setPendingAction(null);
		}
	}, [messageId, leaveReader, t]);
	const onTrashClick = () => (canDeleteForever ? void deleteForever() : void runAction("trash"));
	const trashLabel = canDeleteForever ? t("Delete forever") : t("Move to trash");

	const replyActions = useMessageReply({
		mailboxId,
		senderAddress,
		direction,
		subject,
		bodyText,
		bodyHtml,
		ownAddress,
		ownAddresses,
		message,
		messageMeta,
	});
	const { canReplyAll, canForward } = replyActions;
	const handleReply = replyActions.reply;
	const handleForward = replyActions.forward;
	const disabled = pendingAction !== null || replyActions.pending !== null;
	// Read-only shared mail can be read and marked read, never moved or deleted; the server agrees.
	const { manageDisabled, archiveDisabled, guard } = useReadOnlyMail(mailboxId, { disabled, status });
	const runAction = guard(runUnguarded);

	async function onUnsubscribe() {
		setMoreOpen(false);
		setError(null);
		if (unsubscribeUrl) {
			openUnsubscribeUrl(unsubscribeUrl);
			return;
		}

		if (!(await confirmTrashWithoutUnsubscribe())) return;
		setPendingAction("unsubscribe");
		if (!mailboxId) {
			setError(t("Could not create trash rule"));
			setPendingAction(null);
			return;
		}

		try {
			await createTrashSenderRule({ mailboxId, senderAddress });
			await runAction("trash");
		} catch {
			setError(t("Could not create trash rule"));
			setPendingAction(null);
		}
	}

	const shortcuts = messageShortcuts({
		status,
		direction,
		runAction,
		handleReply,
		forward: handleForward,
		canReplyAll,
		back: () => router.back(),
		print: printShortcutAction(print),
	});
	const listSelectionCount = useListSelectionCount();
	useHotkeys(reachableMessageShortcuts(shortcuts, listSelectionCount), { enabled: shortcutsEnabled });

	async function onBlockContact() {
		setMoreOpen(false);
		setError(null);
		if (!mailboxId) {
			setError(t("Could not block contact"));
			return;
		}

		setPendingAction("block");
		try {
			await blockMessageContact({ mailboxId, senderAddress });
			await runSingleMessageAction(messageId, "trash", undefined, rowMessageIds(messageId));
			leaveReader();
		} catch (blockError) {
			setError(blockError instanceof Error ? blockError.message : t("Could not block contact"));
		} finally {
			setPendingAction(null);
		}
	}

	const reportPhishing = async () => {
		setMoreOpen(false);
		if (await confirmReportPhishing(rowMessageIds(messageId).length)) await runAction("phishing");
	};
	const shownError = error ?? replyActions.error;
	const markAction: BulkMessageAction = read ? "unread" : "read";
	const moveActions = getMoveMessageActions(status, direction);

	const snoozable = direction === "inbound" && status === "received";
	const replyAllLabel = t("Reply all");
	// Priority order: what is dropped first is last. Whatever does not fit moves into "More actions".
	const inlineIds = isMobile
		? ["reply", "spam"]
		: [...(canReplyAll ? ["replyAll"] : []), "archive", ...(snoozable ? ["snooze"] : []), "move", "spam", "mark"];
	const { rootRef, visibleIds } = useReaderToolbarOverflow(
		inlineIds,
		[isMobile, inlineIds.join(), replyAllLabel, read, shownError ?? ""].join("|"),
	);
	// An action that has overflowed stays rendered (but invisible and out of flow) so its width can be measured.
	const slot = (id: string, node: ReactNode) => (
		<span
			{...{ [OVERFLOW_ID_ATTR]: id }}
			className={clsx("inline-flex shrink-0", !visibleIds.has(id) && "pointer-events-none invisible absolute")}
		>
			{node}
		</span>
	);
	const fixedSlot = (node: ReactNode) => (
		<span {...{ [OVERFLOW_FIXED_ATTR]: "" }} className="inline-flex shrink-0">
			{node}
		</span>
	);
	const overflowed = (id: string) => inlineIds.includes(id) && !visibleIds.has(id);
	const moreItemClass =
		"flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100 pointer-coarse:py-3 disabled:text-neutral-400";

	return (
		<div className="reader-toolbar relative flex min-w-0 items-center gap-1 text-neutral-600 max-md:flex-1 md:gap-1.5">
			{/* One row at every width: the actions that do not fit move into "More actions" (use-reader-toolbar-
			overflow.ts) instead of wrapping onto a second line, which is what growing the header did when this
			row's flex-basis let it shrink below its content. No `overflow` here either: that makes this div a
			clipping boundary Radix's Popper measures itself against, which puts the Move-to/Snooze menus in
			the wrong place. */}
			{shownError && (
				<span
					role="alert"
					data-overflow-lead
					title={shownError}
					className="max-w-40 shrink-0 truncate text-xs text-red-600"
				>
					{shownError}
				</span>
			)}

			{isMobile && (
				<>
					{slot(
						"reply",
						<Button
							type="button"
							variant="ghost"
							size="roundedSM"
							aria-label={t("Reply")}
							disabled={disabled}
							onClick={() => handleReply("reply")}
						>
							<Reply size={iconSize} className="rtl:-scale-x-100" />
						</Button>,
					)}
					{fixedSlot(
						<Button
							variant="ghost"
							size="roundedSM"
							aria-label={trashLabel}
							disabled={manageDisabled}
							onClick={onTrashClick}
						>
							<Trash2 size={iconSize} />
						</Button>,
					)}
					{slot(
						"spam",
						<Button
							variant="ghost"
							size="roundedSM"
							aria-label={t("Report spam")}
							disabled={manageDisabled || status === "spam" || direction !== "inbound"}
							onClick={() => runAction("spam")}
						>
							<ShieldAlert size={iconSize} />
						</Button>,
					)}
				</>
			)}
			{!isMobile && (
				<>
					{/* Zero's labelled "Reply all"; Reply and Forward sit under the message itself. */}
					{canReplyAll &&
						slot(
							"replyAll",
							<Button
								type="button"
								variant="ghost"
								size="roundedSM"
								data-labelled
								disabled={disabled}
								onClick={() => handleReply("replyAll")}
							>
								<ReplyAll size={iconSize} className="rtl:-scale-x-100" />
								{replyAllLabel}
							</Button>,
						)}
					{slot(
						"archive",
						<Tooltip label={shortcutsEnabled ? t("Archive (e)") : t("Archive")}>
							<Button
								variant="ghost"
								size="roundedSM"
								aria-label={shortcutsEnabled ? t("Archive (e)") : t("Archive")}
								disabled={manageDisabled || status === "archived"}
								onClick={() => runAction("archive")}
							>
								<Archive size={iconSize} />
							</Button>
						</Tooltip>,
					)}
					{snoozable &&
						slot(
							"snooze",
							<SnoozeToolbarButton messageId={messageId} snoozable disabled={manageDisabled} iconSize={iconSize} />,
						)}
					{slot(
						"move",
						<MoveToolbarMenu
							actions={moveActions}
							mailboxId={mailboxId}
							disabled={manageDisabled}
							iconSize={iconSize}
							onAction={(action, folderId) => void runAction(action, folderId)}
						/>,
					)}
					{slot(
						"spam",
						<Tooltip label={shortcutsEnabled ? t("Report spam (!)") : t("Report spam")}>
							<Button
								variant="ghost"
								size="roundedSM"
								aria-label={shortcutsEnabled ? t("Report spam (!)") : t("Report spam")}
								disabled={manageDisabled || status === "spam" || direction !== "inbound"}
								onClick={() => runAction("spam")}
							>
								<ShieldAlert size={iconSize} />
							</Button>
						</Tooltip>,
					)}
					{slot(
						"mark",
						<Tooltip label={read ? t("Mark as unread") : t("Mark as read")}>
							<Button
								variant="ghost"
								size="roundedSM"
								aria-label={read ? t("Mark as unread") : t("Mark as read")}
								disabled={disabled}
								onClick={() => runAction(markAction)}
							>
								{read ? <Mail size={iconSize} /> : <MailOpen size={iconSize} />}
							</Button>
						</Tooltip>,
					)}
				</>
			)}
			<Popover.Root
				open={moreOpen}
				onOpenChange={(open) => {
					setSnoozeExpanded(false);
					setMoreOpen(open);
				}}
			>
				{fixedSlot(
					<Tooltip label={moreOpen ? null : t("More actions")}>
						<Popover.Trigger asChild>
							<Button type="button" variant="ghost" size="roundedSM" aria-label={t("More actions")} disabled={disabled}>
								<MoreVertical size={iconSize} />
							</Button>
						</Popover.Trigger>
					</Tooltip>,
				)}
				<Popover.Portal>
					<Popover.Content
						align="end"
						sideOffset={4}
						collisionPadding={8}
						aria-label={t("More actions")}
						className="z-50 max-h-(--radix-popover-content-available-height) w-54 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg has-[[data-snooze-expanded=true]]:w-72"
					>
						{/* On a phone these live here, and on desktop whichever of them did not fit in the toolbar row. */}
						{overflowed("reply") && (
							<button
								type="button"
								className={moreItemClass}
								disabled={disabled}
								onClick={() => {
									setMoreOpen(false);
									void handleReply("reply");
								}}
							>
								<Reply className="h-4 w-4 rtl:-scale-x-100" />
								{t("Reply")}
							</button>
						)}
						{(isMobile || overflowed("archive")) && (
							<button
								type="button"
								className={moreItemClass}
								disabled={archiveDisabled}
								onClick={() => void runAction("archive")}
							>
								<Archive className="h-4 w-4" />
								{t("Archive")}
							</button>
						)}
						{canReplyAll && (isMobile || overflowed("replyAll")) && (
							<button
								type="button"
								className={moreItemClass}
								onClick={() => {
									setMoreOpen(false);
									void handleReply("replyAll");
								}}
							>
								<ReplyAll className="h-4 w-4 rtl:-scale-x-100" />
								{replyAllLabel}
							</button>
						)}
						{isMobile && canForward && (
							<button
								type="button"
								className={moreItemClass}
								onClick={() => {
									setMoreOpen(false);
									void handleForward();
								}}
							>
								<Forward className="h-4 w-4 rtl:-scale-x-100" />
								{t("Forward")}
							</button>
						)}
						{(isMobile || overflowed("mark")) && (
							<button type="button" className={moreItemClass} onClick={() => void runAction(markAction)}>
								{read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
								{read ? t("Mark as unread") : t("Mark as read")}
							</button>
						)}
						{overflowed("spam") && (
							<button
								type="button"
								className={moreItemClass}
								disabled={manageDisabled || status === "spam" || direction !== "inbound"}
								onClick={() => void runAction("spam")}
							>
								<ShieldAlert className="h-4 w-4" />
								{t("Report spam")}
							</button>
						)}
						{(isMobile || inlineIds.some(overflowed)) && <hr className="my-1 border-neutral-100" />}
						{direction === "inbound" && status === "received" && (
							<SnoozeMenuItem
								messageId={messageId}
								expanded={snoozeExpanded}
								onExpandedChange={setSnoozeExpanded}
								onSnoozed={() => setMoreOpen(false)}
							/>
						)}
						{direction === "inbound" && (
							<>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100 pointer-coarse:py-3 disabled:cursor-not-allowed disabled:text-neutral-400"
									disabled={!unsubscribeUrl && status === "trash"}
									onClick={() => void onUnsubscribe()}
								>
									<BellOff className="h-4 w-4 shrink-0" />
									{t("Unsubscribe")}
								</button>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100 pointer-coarse:py-3"
									onClick={() => void onBlockContact()}
								>
									<Ban className="h-4 w-4" />
									{t("Block contact")}
								</button>
								<ReportPhishingItem onSelect={() => void reportPhishing()} />
								<hr className="my-1 border-neutral-100" />
							</>
						)}
						{onSummarizeMessage && (
							<button
								type="button"
								className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100 pointer-coarse:py-3"
								onClick={() => {
									setMoreOpen(false);
									onSummarizeMessage();
								}}
							>
								<Sparkles className="h-4 w-4" />
								{t("Summarize this message")}
							</button>
						)}
						{translate && <MessageTranslateItem menu={translate} onClose={() => setMoreOpen(false)} />}
						<button
							type="button"
							className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100 pointer-coarse:py-3"
							onClick={() => {
								setMoreOpen(false);
								setSourceOpen(true);
							}}
						>
							<FileCode2 className="h-4 w-4" />
							{t("Show original")}
						</button>
						<PrintMenuItems print={print} onSelect={() => setMoreOpen(false)} />
						<hr className="my-1 border-neutral-100" />
						{moduleSlots.items}
						<p className="mt-1 px-3 pb-1 pt-2 text-sm font-medium text-neutral-500">{t("Move to")}</p>
						{moveActions.map((item) => (
							<button
								key={item.action}
								type="button"
								className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-neutral-700 hover:bg-neutral-100 pointer-coarse:py-3"
								onClick={() => void runAction(item.action)}
							>
								{createElement(item.icon, { size: 16 })}
								{item.label}
							</button>
						))}
						{overflowed("move") && (
							<ToolbarFolderButtons
								mailboxId={mailboxId}
								onMove={(folderId) => void runAction("folder", folderId)}
								className={moreItemClass}
							/>
						)}
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
			{!isMobile &&
				fixedSlot(
					<Tooltip label={canDeleteForever ? t("Delete forever") : shortcutsEnabled ? t("Delete (#)") : t("Delete")}>
						<Button
							variant="ghost"
							size="roundedSM"
							data-tone="danger"
							aria-label={
								canDeleteForever ? trashLabel : shortcutsEnabled ? t("Move to trash (#)") : t("Move to trash")
							}
							disabled={manageDisabled}
							onClick={onTrashClick}
							className={canDeleteForever ? "text-red-600 hover:text-red-700" : undefined}
						>
							<Trash2 size={iconSize} />
						</Button>
					</Tooltip>,
				)}

			<MessageSourceDialog messageId={messageId} open={sourceOpen} onOpenChange={setSourceOpen} />
			{moduleSlots.overlays}
		</div>
	);
}

const iconSize = 16;

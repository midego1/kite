"use client";

import { createElement, useState, useCallback } from "react";
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
import { MessageSourceDialog } from "@/components/messages/message-source-dialog";
import { useMessageListHref } from "@/components/messages/message-detail-navigation";
import { SnoozeMenuItem } from "@/components/messages/snooze-picker";
import { printShortcutAction } from "@/components/messages/print/print-actions";
import { PrintMenuItems } from "@/components/messages/print/print-menu-items";
import { useMessageMenuSlots } from "./message-menu-slots";
import { ReportPhishingItem } from "./report-phishing-item";
import { confirmReportPhishing } from "@/components/messages/phishing-report";
import { confirmReportSpam } from "@/components/messages/spam-report";
import { messageShortcuts } from "./message-shortcuts";
import { useMessageReply } from "./use-message-reply";
import { useReadOnlyMail } from "./use-read-only-mail";
import { MoveToolbarMenu, SnoozeToolbarButton } from "./message-toolbar-menus";
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
	print,
}: MessageActionsProps) {
	const router = useRouter();
	const isMobile = useIsMobile();
	const { shortcutsEnabled } = useShortcuts();
	const [pendingAction, setPendingAction] = useState<BulkMessageAction | "unsubscribe" | "block" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [moreOpen, setMoreOpen] = useState(false);
	const [sourceOpen, setSourceOpen] = useState(false);
	const [snoozeExpanded, setSnoozeExpanded] = useState(false);
	const moduleSlots = useMessageMenuSlots({ messageId, mailboxId }, moreOpen, () => setMoreOpen(false));
	const listHref = useMessageListHref() ?? getMessageBackHref(direction, status);

	const runUnguarded = useCallback(
		async (action: BulkMessageAction, folderId?: string) => {
			setMoreOpen(false);
			// Reporting trains the filter and cannot be fully undone, so every route to it asks first.
			if (action === "spam" && !(await confirmReportSpam(1))) return;
			setPendingAction(action);
			setError(null);
			try {
				await runSingleMessageAction(messageId, action, folderId);
				if (movesMessageOutOfList(action)) router.push(listHref);
				router.refresh();
			} catch {
				setError("Could not update message");
			} finally {
				setPendingAction(null);
			}
		},
		[messageId, listHref, router],
	);

	// In Trash and Spam the delete button removes the message for good instead of
	// being a no-op, after the user confirms.
	const canDeleteForever = supportsPermanentDelete(status);
	const deleteForever = useCallback(async () => {
		if (
			!(await requestConfirmation({
				title: "Delete forever?",
				description: getPermanentDeleteConfirmText(1),
				confirmLabel: "Delete forever",
			}))
		)
			return;
		setMoreOpen(false);
		setPendingAction("delete");
		setError(null);
		try {
			await runSingleMessageAction(messageId, "delete");
			router.push(listHref);
			router.refresh();
		} catch (deleteError) {
			setError(deleteError instanceof PartialDeleteError ? deleteError.message : "Could not delete message");
			setPendingAction(null);
		}
	}, [messageId, listHref, router]);
	const onTrashClick = () => (canDeleteForever ? void deleteForever() : void runAction("trash"));
	const trashLabel = canDeleteForever ? "Delete forever" : "Move to trash";

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
			setError("Could not create trash rule");
			setPendingAction(null);
			return;
		}

		try {
			await createTrashSenderRule({ mailboxId, senderAddress });
			await runAction("trash");
		} catch {
			setError("Could not create trash rule");
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
	useHotkeys(shortcuts, { enabled: shortcutsEnabled });

	async function onBlockContact() {
		setMoreOpen(false);
		setError(null);
		if (!mailboxId) {
			setError("Could not block contact");
			return;
		}

		setPendingAction("block");
		try {
			await blockMessageContact({ mailboxId, senderAddress });
			await runSingleMessageAction(messageId, "trash");
			router.push(listHref);
			router.refresh();
		} catch (blockError) {
			setError(blockError instanceof Error ? blockError.message : "Could not block contact");
		} finally {
			setPendingAction(null);
		}
	}

	const reportPhishing = async () => {
		setMoreOpen(false);
		if (await confirmReportPhishing(1)) await runAction("phishing");
	};
	const shownError = error ?? replyActions.error;
	const markAction: BulkMessageAction = read ? "unread" : "read";
	const moveActions = getMoveMessageActions(status, direction);

	return (
		<div className="reader-toolbar flex min-w-0 items-center gap-1 text-neutral-600 md:gap-1.5">
			{shownError && (
				<span role="alert" className="text-xs text-red-600">
					{shownError}
				</span>
			)}

			{isMobile && (
				<>
					<Button
						type="button"
						variant="ghost"
						size="roundedSM"
						aria-label="Reply"
						disabled={disabled}
						onClick={() => handleReply("reply")}
					>
						<Reply size={iconSize} />
					</Button>
					<Button
						variant="ghost"
						size="roundedSM"
						aria-label={trashLabel}
						disabled={manageDisabled}
						onClick={onTrashClick}
					>
						<Trash2 size={iconSize} />
					</Button>
					<Button
						variant="ghost"
						size="roundedSM"
						aria-label="Report spam"
						disabled={manageDisabled || status === "spam" || direction !== "inbound"}
						onClick={() => runAction("spam")}
					>
						<ShieldAlert size={iconSize} />
					</Button>
				</>
			)}
			{!isMobile && (
				<>
					{/* Zero's labelled "Reply all"; Reply and Forward sit under the message itself. */}
					{canReplyAll && (
						<Button
							type="button"
							variant="ghost"
							size="roundedSM"
							data-labelled
							disabled={disabled}
							onClick={() => handleReply("replyAll")}
						>
							<ReplyAll size={iconSize} />
							Reply all
						</Button>
					)}
					<Tooltip label={shortcutsEnabled ? "Archive (e)" : "Archive"}>
						<Button
							variant="ghost"
							size="roundedSM"
							aria-label={shortcutsEnabled ? "Archive (e)" : "Archive"}
							disabled={manageDisabled || status === "archived"}
							onClick={() => runAction("archive")}
						>
							<Archive size={iconSize} />
						</Button>
					</Tooltip>
					<SnoozeToolbarButton
						messageId={messageId}
						snoozable={direction === "inbound" && status === "received"}
						disabled={manageDisabled}
						iconSize={iconSize}
					/>
					<MoveToolbarMenu
						actions={moveActions}
						mailboxId={mailboxId}
						disabled={manageDisabled}
						iconSize={iconSize}
						onAction={(action, folderId) => void runAction(action, folderId)}
					/>
					<Tooltip label={shortcutsEnabled ? "Report spam (!)" : "Report spam"}>
						<Button
							variant="ghost"
							size="roundedSM"
							aria-label={shortcutsEnabled ? "Report spam (!)" : "Report spam"}
							disabled={manageDisabled || status === "spam" || direction !== "inbound"}
							onClick={() => runAction("spam")}
						>
							<ShieldAlert size={iconSize} />
						</Button>
					</Tooltip>
					<Tooltip label={read ? "Mark as unread" : "Mark as read"}>
						<Button
							variant="ghost"
							size="roundedSM"
							aria-label={read ? "Mark as unread" : "Mark as read"}
							disabled={disabled}
							onClick={() => runAction(markAction)}
						>
							{read ? <Mail size={iconSize} /> : <MailOpen size={iconSize} />}
						</Button>
					</Tooltip>
				</>
			)}
			<Popover.Root
				open={moreOpen}
				onOpenChange={(open) => {
					setSnoozeExpanded(false);
					setMoreOpen(open);
				}}
			>
				<Tooltip label={moreOpen ? null : "More actions"}>
					<Popover.Trigger asChild>
						<Button type="button" variant="ghost" size="roundedSM" aria-label="More actions" disabled={disabled}>
							<MoreVertical size={iconSize} />
						</Button>
					</Popover.Trigger>
				</Tooltip>
				<Popover.Portal>
					<Popover.Content
						align="end"
						sideOffset={4}
						collisionPadding={8}
						aria-label="More actions"
						className="z-50 max-h-(--radix-popover-content-available-height) w-54 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg has-[[data-snooze-expanded=true]]:w-72"
					>
						{isMobile && (
							<>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400"
									disabled={archiveDisabled}
									onClick={() => void runAction("archive")}
								>
									<Archive className="h-4 w-4" />
									Archive
								</button>
								{canReplyAll && (
									<button
										type="button"
										className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400"
										onClick={() => {
											setMoreOpen(false);
											void handleReply("replyAll");
										}}
									>
										<ReplyAll className="h-4 w-4" />
										Reply all
									</button>
								)}
								{canForward && (
									<button
										type="button"
										className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400"
										onClick={() => {
											setMoreOpen(false);
											void handleForward();
										}}
									>
										<Forward className="h-4 w-4" />
										Forward
									</button>
								)}
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400"
									onClick={() => void runAction(markAction)}
								>
									{read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
									{read ? "Mark as unread" : "Mark as read"}
								</button>
								<hr className="my-1 border-neutral-100" />
							</>
						)}
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
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
									disabled={!unsubscribeUrl && status === "trash"}
									onClick={() => void onUnsubscribe()}
								>
									<BellOff className="h-4 w-4 shrink-0" />
									Unsubscribe
								</button>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
									onClick={() => void onBlockContact()}
								>
									<Ban className="h-4 w-4" />
									Block contact
								</button>
								<ReportPhishingItem onSelect={() => void reportPhishing()} />
								<hr className="my-1 border-neutral-100" />
							</>
						)}
						{onSummarizeMessage && (
							<button
								type="button"
								className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
								onClick={() => {
									setMoreOpen(false);
									onSummarizeMessage();
								}}
							>
								<Sparkles className="h-4 w-4" />
								Summarize this message
							</button>
						)}
						<button
							type="button"
							className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
							onClick={() => {
								setMoreOpen(false);
								setSourceOpen(true);
							}}
						>
							<FileCode2 className="h-4 w-4" />
							Show original
						</button>
						<PrintMenuItems print={print} onSelect={() => setMoreOpen(false)} />
						<hr className="my-1 border-neutral-100" />
						{moduleSlots.items}
						<p className="mt-1 px-3 pb-1 pt-2 text-sm font-medium text-neutral-500">Move to</p>
						{moveActions.map((item) => (
							<button
								key={item.action}
								type="button"
								className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
								onClick={() => void runAction(item.action)}
							>
								{createElement(item.icon, { size: 16 })}
								{item.label}
							</button>
						))}
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
			{!isMobile && (
				<Tooltip label={canDeleteForever ? "Delete forever" : shortcutsEnabled ? "Delete (#)" : "Delete"}>
					<Button
						variant="ghost"
						size="roundedSM"
						data-tone="danger"
						aria-label={canDeleteForever ? trashLabel : shortcutsEnabled ? "Move to trash (#)" : "Move to trash"}
						disabled={manageDisabled}
						onClick={onTrashClick}
						className={canDeleteForever ? "text-red-600 hover:text-red-700" : undefined}
					>
						<Trash2 size={iconSize} />
					</Button>
				</Tooltip>
			)}

			<MessageSourceDialog messageId={messageId} open={sourceOpen} onOpenChange={setSourceOpen} />
			{moduleSlots.overlays}

			<span className="flex-1" />
		</div>
	);
}

const iconSize = 16;

"use client";

import { isSendPending } from "@/lib/messages/send-state-utils";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { usePageLoading } from "@/components/page-loading";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { useMessages } from "@/hooks/use-messages";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { Message } from "@/hooks/types";
import { useClearSelection } from "./use-clear-selection";
import { MessageListHeader } from "./message-list-header";
import { MessageListRow } from "./message-list-row";
import {
	applySelection,
	openIdFromPath,
	planRowSelection,
	replaceSelection,
	resolveSelectionAnchor,
	type RowClickModifiers,
} from "./message-range-selection-utils";
import { dispatchMessageCountsDelta } from "./message-list-row-actions-utils";
import { useConversationView } from "./use-conversation-view";
import { useMessageListDensity } from "./use-reading-layout";
import { useMessageListKeyboard } from "./use-message-list-keyboard";
import type { MessageFolderPageProps, SelectedMessage } from "./types";
import {
	getPageRange,
	ALL_MAILBOXES_LABEL,
	getMailboxAddress,
	runBulkMessageAction,
	runDraftListAction,
	emptyMessageFolder,
	planEmptyFolderInView,
	deleteMessagesForever,
	supportsUnreadFilter,
	LIST_ACTION_CANCELLED,
} from "./utils";
import {
	describePermanentDeleteResult,
	getEmptyFolderConfirmText,
	getPermanentDeleteConfirmText,
	supportsPermanentDelete,
} from "@/lib/messages/permanent-delete-utils";
import { affectsInboxUnreadCount, getInboxUnreadDelta, withReadState } from "@/lib/messages/thread-unread-utils";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";
import { showProgressToast } from "@/components/ui/progress-toast";
import { confirmReportPhishing } from "./phishing-report";
import { confirmReportSpam } from "./spam-report";
import { reportListActionError, reportReadOnlySkipped } from "./list-action-toast";
import { MessageMailboxLabel } from "./message-mailbox-label";
import { useMessageAccess } from "./use-message-access";
import { useEmailPageTitle } from "./use-email-page-title";
import { groupListSections } from "./message-list-sections-utils";

const pageSize = 25;

export function MessageFolderPage({ config, compact = false, selectedMessageId, selection }: MessageFolderPageProps) {
	const {
		selectedMailbox,
		allMailboxes,
		viewMailboxes,
		mailboxScope,
		isLoading: mailboxesLoading,
	} = useSelectedMailbox();
	const access = useMessageAccess();
	const { query } = useMailSearch();
	const isMobile = useIsMobile();
	const [offset, setOffset] = useState(0);
	// Cursor that starts the page at each offset, filled in as the user pages forward.
	const [pageCursors, setPageCursors] = useState<Record<number, string>>({});
	const [internalSelectedMessages, setInternalSelectedMessages] = useState<SelectedMessage[]>([]);
	const [pendingBulkAction, setPendingBulkAction] = useState(false);
	const [emptyingFolder, setEmptyingFolder] = useState(false);
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [selecting, setSelecting] = useState(false);
	const [conversationView] = useConversationView();
	const [density] = useMessageListDensity();
	const grouped = conversationView && config.folder !== "drafts";
	const { messages, isLoading, total, limit, nextCursor, updateMessages } = useMessages(
		config.folder,
		mailboxScope,
		{
			query,
			limit: pageSize,
			offset,
			cursor: offset > 0 ? pageCursors[offset] : null,
			read: unreadOnly ? "unread" : "all",
			group: grouped ? "thread" : undefined,
		},
		!mailboxesLoading,
		config.folderId,
	);
	const { counts } = useMessageCounts(mailboxScope, !mailboxesLoading);
	// In All mailboxes the Screener applies while any listed mailbox holds new senders back.
	const screenerVisible =
		viewMailboxes.some((mailbox) => mailbox.screener?.enabled === true && mailbox.screener.mode === "screener") ||
		(counts.folders.screener?.total ?? 0) > 0;
	// The Inbox list beside the reader groups starred mail under "Pinned" first, as Zero does.
	const sections = groupListSections(messages, config.folder === "inbox" && !config.folderId && (compact || isMobile));
	const orderedMessages = sections.flatMap((section) => section.messages);
	usePageLoading(mailboxesLoading || isLoading);
	const hasActiveFilters = !!query.trim();
	const folderCount = config.folderId ? counts.customFolders[config.folderId] : counts.folders[config.folder];
	const titleTotal = folderCount?.total ?? total;
	const titleUnread = folderCount?.unread ?? 0;
	const mailboxAddress = allMailboxes ? ALL_MAILBOXES_LABEL : getMailboxAddress(selectedMailbox);
	// Sent mail is shown as from the mailbox it went out from, which differs per row in All mailboxes.
	const accountNameOf = (message: Message) => {
		const mailbox = access.mailboxOf(message.mailboxId) ?? selectedMailbox;
		return mailbox?.displayName ?? mailbox?.localPart;
	};
	const pageRange = getPageRange(offset, messages.length, total);
	const selectedMessages = selection?.selectedMessages ?? internalSelectedMessages;
	const setSelectedMessages = selection?.setSelectedMessages ?? setInternalSelectedMessages;
	const selectedIds = useMemo(() => selectedMessages.map((message) => message.id), [selectedMessages]);
	const hasUnreadSelection = selectedMessages.some((message) => !message.read);
	const allVisibleSelected = messages.length > 0 && messages.every((message) => selectedIds.includes(message.id));
	// In conversation view a row stands for every message of its thread in this
	// folder, so actions and drags carry all of them.
	const rowMessageIds = (message: Message) => message.threadMessageIds ?? [message.id];
	const expandSelectedIds = (ids: string[]) =>
		ids.flatMap((id) => rowMessageIds(messages.find((message) => message.id === id) ?? ({ id } as Message)));

	const listKey = [query, mailboxScope, config.folder, config.folderId, unreadOnly, grouped].join("\u0000");
	if (useKeyChanged(listKey)) {
		setOffset(0);
		setPageCursors({});
	}

	// The setter can come from a parent's selection state and is not stable, so it is
	// left out of the dependencies; listing it would clear the selection on every render.
	const selectionAnchor = useRef<string | null>(null);
	// The open message (or draft) is the anchor of the next range, whether a click, a key or a link opened it.
	const pathname = usePathname();
	const openMessageId = selectedMessageId ?? openIdFromPath(pathname, config.hrefPrefix);
	useEffect(() => {
		if (openMessageId) selectionAnchor.current = openMessageId;
	}, [openMessageId]);
	useEffect(() => {
		selectionAnchor.current = null;
		setSelectedMessages([]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [listKey, offset]);

	const { clearSelection: clearAndLeave, leaveOpenMessage } = useClearSelection(
		selection,
		setSelectedMessages,
		messages,
		isLoading,
	);
	// An empty selection has no anchor: the next range starts from the open message or the focused row.
	function clearSelection() {
		selectionAnchor.current = null;
		clearAndLeave();
	}
	/** Escape: empties the selection and leaves the open message open (the pane falls back to it). */
	function clearSelectionKeepOpen() {
		selectionAnchor.current = null;
		setSelectedMessages([]);
	}

	useEmailPageTitle(
		{ location: config.title, total: titleTotal, unread: titleUnread, emailAddress: mailboxAddress },
		mailboxesLoading,
	);

	/** A row checkbox. Shift-click on one selects a range exactly as Shift-click on the row does. */
	function updateSelectedMessage(messageId: string, selected: boolean, extendRange = false) {
		if (extendRange) {
			selectRow(messageId, { shift: true, toggle: false });
			return;
		}
		selectionAnchor.current = messageId;
		setSelectedMessages((current) => applySelection(current, messages, [messageId], selected));
	}

	/**
	 * Shift-, Cmd- and Ctrl-click on a row (and Shift+Arrow). Rows beyond the loaded page are not in the list, so
	 * a range selects only the loaded ones. A click without modifiers just becomes the anchor of the next range.
	 */
	function selectRow(messageId: string, modifiers: RowClickModifiers | null, anchorId = selectionAnchor.current) {
		if (!modifiers) {
			// A plain click opens the row (or is on the open one already) and ends the selection.
			selectionAnchor.current = messageId;
			if (selectedIds.length > 0) setSelectedMessages([]);
			return;
		}
		const plan = planRowSelection({
			orderedIds: orderedMessages.map((message) => message.id),
			selectedIds,
			anchorId,
			openId: openMessageId,
			targetId: messageId,
			modifiers,
		});
		selectionAnchor.current = plan.anchorId;
		setSelectedMessages((current) => replaceSelection(current, messages, plan.selectedIds));
	}

	function toggleAllVisible(selected: boolean) {
		const visibleIds = messages.map((message) => message.id);
		setSelectedMessages((current) => applySelection(current, messages, visibleIds, selected));
	}

	const permanentDeleteFolder = !config.folderId && supportsPermanentDelete(config.folder) ? config.folder : null;
	async function emptyFolder() {
		if (!permanentDeleteFolder) return;
		// In All mailboxes this empties every listed mailbox the user may manage, never a read-only one.
		const plan = await planEmptyFolderInView(viewMailboxes, permanentDeleteFolder);
		if (plan.targets.length === 0) return;
		if (
			!(await requestConfirmation({
				title: `Empty ${permanentDeleteFolder === "trash" ? "Trash" : "Spam"}?`,
				description: getEmptyFolderConfirmText(
					permanentDeleteFolder,
					plan.total,
					allMailboxes ? plan.names : undefined,
				),
				confirmLabel: "Delete forever",
			}))
		)
			return;
		setEmptyingFolder(true);
		leaveOpenMessage();
		const folderLabel = permanentDeleteFolder === "trash" ? "Trash" : "Spam";
		const progress = showProgressToast(`Emptying ${folderLabel}`, plan.total);
		try {
			let deleted = 0;
			for (const mailbox of plan.targets) {
				const before = deleted;
				deleted += await emptyMessageFolder(mailbox.id, permanentDeleteFolder, (done, total) =>
					progress.update(before + done, before + total),
				);
			}
			setOffset(0);
			clearSelection();
			progress.succeed(deleted === 1 ? "1 message deleted forever" : `${deleted} messages deleted forever`);
		} catch (error) {
			console.error(error);
			progress.fail(`Could not empty ${folderLabel}. Please try again.`);
		} finally {
			setEmptyingFolder(false);
		}
	}

	// Drafts are private to their author: they are deleted outright, never moved (see runDraftListAction).
	function runListAction(ids: string[], action: BulkMessageAction, folderId?: string) {
		return config.folder === "drafts"
			? runDraftListAction(ids, action)
			: runBulkMessageAction(ids, action, true, folderId);
	}

	async function runSelectedAction(action: BulkMessageAction, folderId?: string) {
		if (selectedIds.length === 0) return;
		// The server skips read-only mail too; leaving it out here keeps the list and the toasts honest.
		const { allowed: actionIds, skipped } = access.split(selectedMessages, action);
		reportReadOnlySkipped(skipped, actionIds.length === 0);
		if (actionIds.length === 0) return;
		if (action === "delete") {
			const ids = expandSelectedIds(actionIds);
			if (
				!(await requestConfirmation({
					title: "Delete forever?",
					description: getPermanentDeleteConfirmText(ids.length),
					confirmLabel: "Delete forever",
				}))
			)
				return;
			setPendingBulkAction(true);
			clearSelection();
			const progress = showProgressToast("Deleting forever", ids.length);
			let completed = 0;
			try {
				const { deleted, skipped } = await deleteMessagesForever(ids, (done, _total, batch) => {
					completed = done;
					progress.update(done);
					const gone = new Set(batch);
					updateMessages((current) => current.filter((message) => !gone.has(message.id)));
				});
				const outcome = describePermanentDeleteResult(deleted, skipped);
				progress[outcome.ok ? "succeed" : "fail"](outcome.message);
			} catch (error) {
				console.error(error);
				progress.fail(
					completed > 0
						? `Deleted ${completed} of ${ids.length}. The rest could not be deleted; please try again.`
						: "Could not delete the messages. Please try again.",
				);
			} finally {
				setPendingBulkAction(false);
			}
			return;
		}

		if (action === "phishing" && !(await confirmReportPhishing(expandSelectedIds(actionIds).length))) return;
		if (action === "spam" && !(await confirmReportSpam(expandSelectedIds(actionIds).length))) return;
		setPendingBulkAction(true);
		const previousMessages = messages;
		const readValue = action === "read" ? true : action === "unread" ? false : null;
		const selectedRows = messages.filter((message) => actionIds.includes(message.id));
		const inboxUnreadDelta = getInboxUnreadDelta(selectedRows, readValue, affectsInboxUnreadCount(config));
		if (readValue !== null) {
			updateMessages((current) =>
				current.map((message) => (actionIds.includes(message.id) ? withReadState(message, readValue) : message)),
			);
			setSelectedMessages((current) => current.map((message) => ({ ...message, read: readValue })));
			if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta });
		}
		try {
			// A declined confirmation did nothing, so the selection stays.
			if ((await runListAction(expandSelectedIds(actionIds), action, folderId)) === LIST_ACTION_CANCELLED) return;
			clearSelection();
		} catch (error) {
			if (readValue !== null) {
				updateMessages(previousMessages);
				if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta: -inboxUnreadDelta });
			}
			reportListActionError(error);
		} finally {
			setPendingBulkAction(false);
		}
	}

	const listRef = useRef<HTMLDivElement>(null);
	useMessageListKeyboard({
		listRef,
		folder: config.folder,
		messageOpen: !!selectedMessageId,
		runOnRows: (action, focusedId) => {
			if (selectedIds.length > 0) void runSelectedAction(action);
			else if (focusedId) {
				const focused = messages.find((message) => message.id === focusedId);
				const { allowed, skipped } = access.split(focused ? [focused] : [], action);
				reportReadOnlySkipped(skipped, allowed.length === 0);
				if (allowed.length > 0) void runListAction(expandSelectedIds(allowed), action).catch(reportListActionError);
			}
		},
		toggleRowSelection: (messageId) => updateSelectedMessage(messageId, !selectedIds.includes(messageId)),
		// With nothing selected the range starts from the focused row, not from an earlier click.
		extendSelection: (focusedId, targetId) =>
			selectRow(
				targetId,
				{ shift: true, toggle: false },
				selectedIds.length === 0
					? focusedId
					: (resolveSelectionAnchor(
							orderedMessages.map((message) => message.id),
							selectionAnchor.current,
							openMessageId,
						) ?? focusedId),
			),
		selectionCount: selectedIds.length,
		clearSelection: clearSelectionKeepOpen,
	});

	const registerAction = selection?.registerAction;
	useLayoutEffect(() => {
		if (!registerAction) return;
		registerAction(runSelectedAction);
		return () => registerAction(null);
	});

	return (
		<div className="flex h-full min-h-0 flex-col" data-selection-scope="">
			<p role="status" aria-live="polite" className="sr-only">
				{selectedIds.length > 0
					? `${selectedIds.length} ${selectedIds.length === 1 ? "email" : "emails"} selected`
					: ""}
			</p>
			<MessageListHeader
				config={config}
				compact={compact || isMobile}
				selectionInPane={compact}
				showTitle={compact || isMobile}
				selecting={{
					value: selecting,
					onChange: (value) => {
						setSelecting(value);
						if (!value) setSelectedMessages([]);
					},
				}}
				screenerVisible={screenerVisible}
				nested={!!selectedMessageId}
				selection={{
					count: selectedIds.length,
					allVisible: allVisibleSelected,
					hasUnread: hasUnreadSelection,
					disabled: messages.length === 0,
					pending: pendingBulkAction,
					mailboxIds: selectedMessages.map((message) => message.mailboxId),
					hasDrafts: selectedMessages.some((message) => message.status === "draft"),
					hasPendingSend: selectedMessages.some((message) => isSendPending(message.status)),
					toggleAll: toggleAllVisible,
					run: runSelectedAction,
					clear: clearSelection,
				}}
				filter={
					supportsUnreadFilter(config.folder)
						? { value: unreadOnly ? "unread" : "all", onChange: (value) => setUnreadOnly(value === "unread") }
						: null
				}
				pager={{
					range: pageRange,
					canPrevious: offset > 0 && !isLoading,
					canNext: offset + messages.length < total && !isLoading,
					previous: () => setOffset(Math.max(offset - limit, 0)),
					next: () => {
						const nextOffset = offset + limit;
						if (nextCursor) setPageCursors((current) => ({ ...current, [nextOffset]: nextCursor }));
						setOffset(nextOffset);
					},
				}}
				emptyFolder={
					permanentDeleteFolder
						? {
								folder: permanentDeleteFolder,
								disabled: emptyingFolder || isLoading || total === 0,
								emptying: emptyingFolder,
								run: () => void emptyFolder(),
							}
						: null
				}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable" data-density={density}>
				<div
					ref={listRef}
					role="list"
					aria-label={config.title}
					className={compact || isMobile ? "flex flex-col gap-0.5 py-1.5" : "divide-y divide-neutral-100"}
				>
					{sections.map((section) => [
						section.label && (
							// Decorative: the rows carry everything, and a list may only hold list items.
							<p
								key={`section-${section.key}`}
								aria-hidden="true"
								className="px-5 pb-1 pt-3 text-sm text-neutral-500 first:pt-1"
							>
								{section.label}
								{section.count !== null && <span className="ml-2">[{section.count}]</span>}
							</p>
						),
						...section.messages.map((message) => (
							<MessageListRow
								key={message.id}
								selecting={selecting}
								message={message}
								config={config}
								selected={selectedIds.includes(message.id)}
								active={message.id === selectedMessageId}
								compact={compact || isMobile}
								density={density}
								hoverActions={!isMobile}
								currentAccountName={accountNameOf(message)}
								mailboxLabel={
									access.showMailboxLabels ? (
										<MessageMailboxLabel mailbox={access.mailboxOf(message.mailboxId)} />
									) : null
								}
								canManage={access.canManage(message.mailboxId)}
								onSelectedChange={updateSelectedMessage}
								onRowClick={selectRow}
								onMessageAction={async (messageId, action) => {
									await runBulkMessageAction(
										expandSelectedIds([messageId]),
										action,
										action !== "read" && action !== "unread",
									);
								}}
								dragMessageIds={expandSelectedIds(selectedIds.includes(message.id) ? selectedIds : [message.id])}
							/>
						)),
					])}
				</div>
				{!isLoading && messages.length === 0 && (
					<div className="px-6 py-4">
						{!hasActiveFilters && (
							<p aria-hidden="true" className="font-script text-3xl text-blue-600">
								All clear.
							</p>
						)}
						<p className="text-sm text-neutral-500">
							{hasActiveFilters ? "No messages match these filters" : config.emptyText}
						</p>
					</div>
				)}
			</div>
		</div>
	);
}

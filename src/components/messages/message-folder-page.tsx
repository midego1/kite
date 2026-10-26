"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { applySelection, getRangeSelectionIds } from "./message-range-selection-utils";
import { dispatchMessageCountsDelta } from "./message-list-row-actions-utils";
import { useConversationView } from "./use-conversation-view";
import { useMessageListDensity } from "./use-reading-layout";
import { useMessageListKeyboard } from "./use-message-list-keyboard";
import type { MessageFolderPageProps } from "./types";
import {
	getPageRange,
	getMailboxAddress,
	runBulkMessageAction,
	emptyMessageFolder,
	deleteMessagesForever,
	supportsUnreadFilter,
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
import { reportListActionError } from "./list-action-toast";
import { useEmailPageTitle } from "./use-email-page-title";

const pageSize = 25;

export function MessageFolderPage({ config, compact = false, selectedMessageId, selection }: MessageFolderPageProps) {
	const { selectedMailbox, isLoading: mailboxesLoading } = useSelectedMailbox();
	const { query } = useMailSearch();
	const isMobile = useIsMobile();
	const [offset, setOffset] = useState(0);
	// Cursor that starts the page at each offset, filled in as the user pages forward.
	const [pageCursors, setPageCursors] = useState<Record<number, string>>({});
	const [internalSelectedMessages, setInternalSelectedMessages] = useState<Array<{ id: string; read: boolean }>>([]);
	const [pendingBulkAction, setPendingBulkAction] = useState(false);
	const [emptyingFolder, setEmptyingFolder] = useState(false);
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [conversationView] = useConversationView();
	const [density] = useMessageListDensity();
	const grouped = conversationView && config.folder !== "drafts";
	const { messages, isLoading, total, limit, nextCursor, updateMessages } = useMessages(
		config.folder,
		selectedMailbox?.id,
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
	const { counts } = useMessageCounts(selectedMailbox?.id, !mailboxesLoading);
	usePageLoading(mailboxesLoading || isLoading);
	const hasActiveFilters = !!query.trim();
	const folderCount = config.folderId ? counts.customFolders[config.folderId] : counts.folders[config.folder];
	const titleTotal = folderCount?.total ?? total;
	const titleUnread = folderCount?.unread ?? 0;
	const mailboxAddress = getMailboxAddress(selectedMailbox);
	const currentAccountName = selectedMailbox?.displayName ?? selectedMailbox?.localPart;
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

	const listKey = [query, selectedMailbox?.id, config.folder, config.folderId, unreadOnly, grouped].join("\u0000");
	if (useKeyChanged(listKey)) {
		setOffset(0);
		setPageCursors({});
	}

	// The setter can come from a parent's selection state and is not stable, so it is
	// left out of the dependencies; listing it would clear the selection on every render.
	const selectionAnchor = useRef<string | null>(null);
	useEffect(() => {
		selectionAnchor.current = null;
		setSelectedMessages([]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [listKey, offset]);

	const { clearSelection, leaveOpenMessage } = useClearSelection(selection, setSelectedMessages, messages, isLoading);

	useEmailPageTitle(
		{ location: config.title, total: titleTotal, unread: titleUnread, emailAddress: mailboxAddress },
		mailboxesLoading,
	);

	function updateSelectedMessage(messageId: string, selected: boolean, extendRange = false) {
		const orderedIds = messages.map((message) => message.id);
		const ids = extendRange ? getRangeSelectionIds(orderedIds, selectionAnchor.current, messageId) : [messageId];
		selectionAnchor.current = messageId;
		setSelectedMessages((current) => applySelection(current, messages, ids, selected));
	}

	function toggleAllVisible(selected: boolean) {
		const visibleIds = messages.map((message) => message.id);
		setSelectedMessages((current) => applySelection(current, messages, visibleIds, selected));
	}

	const permanentDeleteFolder = !config.folderId && supportsPermanentDelete(config.folder) ? config.folder : null;
	async function emptyFolder() {
		if (!permanentDeleteFolder || !selectedMailbox?.id) return;
		if (
			!(await requestConfirmation({
				title: `Empty ${permanentDeleteFolder === "trash" ? "Trash" : "Spam"}?`,
				description: getEmptyFolderConfirmText(permanentDeleteFolder, titleTotal),
				confirmLabel: "Delete forever",
			}))
		)
			return;
		setEmptyingFolder(true);
		leaveOpenMessage();
		const folderLabel = permanentDeleteFolder === "trash" ? "Trash" : "Spam";
		const progress = showProgressToast(`Emptying ${folderLabel}`, titleTotal);
		try {
			const deleted = await emptyMessageFolder(selectedMailbox.id, permanentDeleteFolder, (done, total) =>
				progress.update(done, total),
			);
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

	async function runSelectedAction(action: BulkMessageAction, folderId?: string) {
		if (selectedIds.length === 0) return;
		if (action === "delete") {
			const ids = expandSelectedIds(selectedIds);
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

		if (action === "phishing" && !(await confirmReportPhishing(expandSelectedIds(selectedIds).length))) return;
		setPendingBulkAction(true);
		const previousMessages = messages;
		const readValue = action === "read" ? true : action === "unread" ? false : null;
		const selectedRows = messages.filter((message) => selectedIds.includes(message.id));
		const inboxUnreadDelta = getInboxUnreadDelta(selectedRows, readValue, affectsInboxUnreadCount(config));
		if (readValue !== null) {
			updateMessages((current) =>
				current.map((message) => (selectedIds.includes(message.id) ? withReadState(message, readValue) : message)),
			);
			setSelectedMessages((current) => current.map((message) => ({ ...message, read: readValue })));
			if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta });
		}
		try {
			await runBulkMessageAction(expandSelectedIds(selectedIds), action, true, folderId);
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
			else if (focusedId)
				void runBulkMessageAction(expandSelectedIds([focusedId]), action, true).catch(reportListActionError);
		},
		toggleRowSelection: (messageId) => updateSelectedMessage(messageId, !selectedIds.includes(messageId)),
	});

	const registerAction = selection?.registerAction;
	useLayoutEffect(() => {
		if (!registerAction) return;
		registerAction(runSelectedAction);
		return () => registerAction(null);
	});

	return (
		<div className="flex h-full min-h-0 flex-col">
			<MessageListHeader
				config={config}
				compact={compact || isMobile}
				showTitle={compact || isMobile}
				nested={!!selectedMessageId}
				selection={{
					count: selectedIds.length,
					allVisible: allVisibleSelected,
					hasUnread: hasUnreadSelection,
					disabled: messages.length === 0,
					pending: pendingBulkAction,
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
					{messages.map((message) => (
						<MessageListRow
							key={message.id}
							message={message}
							config={config}
							selected={selectedIds.includes(message.id)}
							active={message.id === selectedMessageId}
							compact={compact || isMobile}
							density={density}
							hoverActions={!isMobile}
							currentAccountName={currentAccountName}
							onSelectedChange={updateSelectedMessage}
							onMessageAction={async (messageId, action) => {
								await runBulkMessageAction(
									expandSelectedIds([messageId]),
									action,
									action !== "read" && action !== "unread",
								);
							}}
							dragMessageIds={expandSelectedIds(selectedIds.includes(message.id) ? selectedIds : [message.id])}
						/>
					))}
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

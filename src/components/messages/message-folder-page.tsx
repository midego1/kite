"use client";

import clsx from "clsx";
import { isSendPending } from "@/lib/messages/send-state-utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { useSemanticSearchChip } from "@/components/mail-search/use-semantic-search-chip";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { usePageLoading } from "@/components/page-loading";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { useMessages } from "@/hooks/use-messages";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { Message } from "@/hooks/types";
import { UpdateNoticeRow } from "@/components/update-notice-row";
import { useRegisterUpdateList } from "@/components/update-notice-store";
import { PartialBulkActionError } from "./bulk-action-batch-utils";
import { useClearSelection } from "./use-clear-selection";
import { useOpenRowBridge } from "./use-open-row-bridge";
import { MessageListHeader } from "./message-list-header";
import { buildListPager, isPagerShown } from "./message-list-pager-utils";
import { ListSectionLabel, PagerSlot } from "./message-list-pager";
import { MessageListRow } from "./message-list-row";
import {
	applySelection,
	expandSelectedThreadIds,
	openIdFromPath,
	planRowSelection,
	replaceSelection,
	resolveSelectedRows,
	resolveSelectionAnchor,
	toSelectedMessage,
	type RowClickModifiers,
} from "./message-range-selection-utils";
import { dispatchMessageCountsDelta } from "./message-list-row-actions-utils";
import { useConversationView } from "./use-conversation-view";
import { useMessageListDensity, useMessageListLabels } from "./use-reading-layout";
import { useMessageListKeyboard } from "./use-message-list-keyboard";
import { resolveAllMatchingMessages, SELECT_ALL_MAX_MESSAGES } from "./select-all-utils";
import { SelectAllBanner } from "./select-all-banner";
import type { MessageFolderPageProps, SelectedMessage } from "./types";
import {
	getPageRange,
	ALL_MAILBOXES_LABEL,
	folderTitle,
	getMailboxAddress,
	runBulkMessageAction,
	runDraftListAction,
	emptyMessageFolder,
	planEmptyFolderInView,
	deleteMessagesForever,
	supportsUnreadFilter,
	semanticUnavailableNote,
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
import { reportListActionError, reportReadOnlySkipped, reportSelectAllTruncated } from "./list-action-toast";
import { MessageMailboxLabel } from "./message-mailbox-label";
import { useMessageAccess } from "./use-message-access";
import { useEmailPageTitle } from "./use-email-page-title";
import { groupListSections } from "./message-list-sections-utils";
import { useT } from "@/lib/i18n/use-t";

const pageSize = 25;

/**
 * The folder the header can empty (Trash and Spam, not your own folders). While an account's view is open the list is
 * only part of the folder, and emptying removes all of it, so the button is not offered there.
 */
function folderToEmpty(config: MessageFolderPageProps["config"], viewOpen: boolean) {
	if (viewOpen || config.folderId) return null;
	return supportsPermanentDelete(config.folder) ? config.folder : null;
}

export function MessageFolderPage({
	config,
	compact = false,
	selectedMessageId,
	selection,
	listVisible = true,
}: MessageFolderPageProps) {
	const t = useT();
	const {
		selectedMailbox,
		allMailboxes,
		viewMailboxes,
		mailboxScope,
		isLoading: mailboxesLoading,
	} = useSelectedMailbox();
	const access = useMessageAccess();
	const { query, view } = useMailSearch();
	const [semanticOn, setSemanticOn] = useSemanticSearchChip();
	const isMobile = useIsMobile();
	const [offset, setOffset] = useState(0);
	// Cursor that starts the page at each offset, filled in as the user pages forward.
	const [pageCursors, setPageCursors] = useState<Record<number, string>>({});
	const [internalSelectedMessages, setInternalSelectedMessages] = useState<SelectedMessage[]>([]);
	const [pendingBulkAction, setPendingBulkAction] = useState(false);
	const [emptyingFolder, setEmptyingFolder] = useState(false);
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [selecting, setSelecting] = useState(false);
	const [resolvingSelectAll, setResolvingSelectAll] = useState(false);
	const [conversationView] = useConversationView();
	const [density] = useMessageListDensity();
	const [labels] = useMessageListLabels();
	const grouped = conversationView && config.folder !== "drafts";
	const { messages, isLoading, total, limit, nextCursor, updateMessages, semantic, keywordTotal } = useMessages(
		config.folder,
		mailboxScope,
		{
			query,
			limit: pageSize,
			offset,
			cursor: offset > 0 ? pageCursors[offset] : null,
			read: unreadOnly ? "unread" : "all",
			group: grouped ? "thread" : undefined,
			semantic: semanticOn,
		},
		!mailboxesLoading,
		config.folderId,
	);
	const semanticUnavailable = semanticUnavailableNote(query, semantic);
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
	const mailboxAddress = allMailboxes ? t(ALL_MAILBOXES_LABEL) : getMailboxAddress(selectedMailbox);
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
	const expandSelectedIds = (ids: string[]) => expandSelectedThreadIds(ids, messages, selectedMessages);
	// Once every row on the page is checked, and the folder holds more, offer to extend the selection to
	// everything matching: capped at SELECT_ALL_MAX_MESSAGES, so the banner (and the bulk action after it) never
	// has to resolve or act on an unbounded folder in one request.
	const selectAllCap = Math.min(total, SELECT_ALL_MAX_MESSAGES);
	const showSelectAllBanner = allVisibleSelected && selectedIds.length < selectAllCap;

	const listKey = [query, mailboxScope, config.folder, config.folderId, unreadOnly, grouped, semanticOn].join("\u0000");
	if (useKeyChanged(listKey)) {
		setOffset(0);
		setPageCursors({});
	}

	// The setter can come from a parent's selection state and is not stable, so it is
	// left out of the dependencies; listing it would clear the selection on every render.
	const selectionAnchor = useRef<string | null>(null);
	// Bumped by a view change (below) or an explicit clear, so a "Select all" result that resolves after either
	// is discarded instead of silently repopulating a selection the user already left or cleared.
	const selectAllGeneration = useRef(0);
	// The open message (or draft) is the anchor of the next range, whether a click, a key or a link opened it.
	const pathname = usePathname();
	const openMessageId = selectedMessageId ?? openIdFromPath(pathname, config.hrefPrefix);
	useEffect(() => {
		if (openMessageId) selectionAnchor.current = openMessageId;
	}, [openMessageId]);
	useEffect(() => {
		// A remount on the same list and page (a language switch to Arabic rebuilds the panel group) keeps the
		// selection its parent holds; only a different list or page starts from nothing.
		const identity = `${listKey}\u0001${offset}`;
		if (selection?.claimList && !selection.claimList(identity)) return;
		selectionAnchor.current = null;
		setSelectedMessages([]);
		selectAllGeneration.current += 1;
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
		selectAllGeneration.current += 1;
		clearAndLeave();
	}
	/** Escape: empties the selection and leaves the open message open (the pane falls back to it). */
	function clearSelectionKeepOpen() {
		selectionAnchor.current = null;
		selectAllGeneration.current += 1;
		setSelectedMessages([]);
	}

	/** "Select all N in folder": resolves every matching row from the server and replaces the selection with it. */
	async function selectAllMatching() {
		if (resolvingSelectAll) return;
		const startGeneration = selectAllGeneration.current;
		setResolvingSelectAll(true);
		try {
			const { messages: matched, truncated } = await resolveAllMatchingMessages(
				config.folder,
				mailboxScope,
				{ query, read: unreadOnly ? "unread" : "all", group: grouped ? "thread" : undefined },
				config.folderId,
			);
			// The search, filter, folder, mailbox or page changed, or the selection was cleared, while this was
			// still resolving: applying it now would silently select mail the user can no longer see, or bring
			// back a selection they already dismissed.
			if (selectAllGeneration.current !== startGeneration) return;
			selectionAnchor.current = null;
			// Every row this selected is marked offPage, not just the ones past the loaded page: new mail or a
			// move can push a row that was on the page out of it after the fact, and a folder-wide selection must
			// not shrink back down to whatever the page happens to hold later; see `pruneSelection`.
			setSelectedMessages(matched.map((message) => ({ ...toSelectedMessage(message), offPage: true })));
			if (truncated) reportSelectAllTruncated(SELECT_ALL_MAX_MESSAGES);
		} catch (error) {
			reportListActionError(error);
		} finally {
			setResolvingSelectAll(false);
		}
	}

	useEmailPageTitle(
		{ location: folderTitle(config), total: titleTotal, unread: titleUnread, emailAddress: mailboxAddress },
		mailboxesLoading,
	);

	/** A row checkbox. Shift-click on one selects a range exactly as Shift-click on the row does. */
	function updateSelectedMessage(messageId: string, selected: boolean, extendRange = false) {
		if (extendRange) {
			selectRow(messageId, { shift: true, toggle: false });
			return;
		}
		selectionAnchor.current = messageId;
		// Any explicit change to the selection invalidates a "Select all" still resolving in the background, the
		// same as a view change or a clear: letting its answer land after this would silently undo it.
		selectAllGeneration.current += 1;
		setSelectedMessages((current) => applySelection(current, messages, [messageId], selected));
	}

	/**
	 * Shift-, Cmd- and Ctrl-click on a row (and Shift+Arrow). Rows beyond the loaded page are not in the list, so
	 * a range selects only the loaded ones. A click without modifiers just opens the row (or is on the open one
	 * already) and becomes the anchor of the next range, leaving an existing checkbox selection as it was: opening
	 * one message to read does not lose track of the others already checked.
	 */
	function selectRow(messageId: string, modifiers: RowClickModifiers | null, anchorId = selectionAnchor.current) {
		if (!modifiers) {
			selectionAnchor.current = messageId;
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
		selectAllGeneration.current += 1;
		setSelectedMessages((current) => replaceSelection(current, messages, plan.selectedIds));
	}

	function toggleAllVisible(selected: boolean) {
		selectAllGeneration.current += 1;
		// Unchecking the header while the selection holds off-page entries (a resolved "Select all in folder")
		// clears all of it: applying only to the visible rows would leave the header unchecked while the
		// toolbar still said e.g. "975 selected," with no way back to the all-unchecked state from there.
		if (!selected && selectedMessages.some((message) => message.offPage)) {
			selectionAnchor.current = null;
			setSelectedMessages([]);
			return;
		}
		const visibleIds = messages.map((message) => message.id);
		setSelectedMessages((current) => applySelection(current, messages, visibleIds, selected));
	}

	const permanentDeleteFolder = folderToEmpty(config, view !== null);
	async function emptyFolder() {
		if (!permanentDeleteFolder) return;
		// In All mailboxes this empties every listed mailbox the user may manage, never a read-only one.
		const plan = await planEmptyFolderInView(viewMailboxes, permanentDeleteFolder);
		if (plan.targets.length === 0) return;
		if (
			!(await requestConfirmation({
				title: permanentDeleteFolder === "trash" ? t("Empty Trash?") : t("Empty Spam?"),
				description: getEmptyFolderConfirmText(
					permanentDeleteFolder,
					plan.total,
					allMailboxes ? plan.names : undefined,
				),
				confirmLabel: t("Delete forever"),
			}))
		)
			return;
		setEmptyingFolder(true);
		leaveOpenMessage();
		const folderLabel = permanentDeleteFolder === "trash" ? t("Trash") : t("Spam");
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

	/** Delete forever, confirmed up front: a separate path from the rest since nothing here is undoable or
	 * optimistic, only a progress toast moving as batches complete. */
	async function runDeleteForever(actionIds: string[]) {
		const ids = expandSelectedIds(actionIds);
		if (
			!(await requestConfirmation({
				title: t("Delete forever?"),
				description: getPermanentDeleteConfirmText(ids.length),
				confirmLabel: t("Delete forever"),
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
					? t("Deleted {completed} of {length}. The rest could not be deleted; please try again.", {
							completed,
							length: ids.length,
						})
					: t("Could not delete the messages. Please try again."),
			);
		} finally {
			setPendingBulkAction(false);
		}
	}

	async function runSelectedAction(action: BulkMessageAction, folderId?: string) {
		if (selectedIds.length === 0) return;
		// The server skips read-only mail too; leaving it out here keeps the list and the toasts honest.
		const { allowed: actionIds, skipped } = access.split(selectedMessages, action);
		reportReadOnlySkipped(skipped, actionIds.length === 0);
		if (actionIds.length === 0) return;
		if (action === "delete") {
			await runDeleteForever(actionIds);
			return;
		}

		if (action === "phishing" && !(await confirmReportPhishing(expandSelectedIds(actionIds).length))) return;
		if (action === "spam" && !(await confirmReportSpam(expandSelectedIds(actionIds).length))) return;
		setPendingBulkAction(true);
		const previousMessages = messages;
		const readValue = action === "read" ? true : action === "unread" ? false : null;
		// Falls back to the selection's own snapshot for a row "Select all in folder" reached past the loaded
		// page, so a folder-wide mark read/unread still moves the sidebar Inbox count by the right amount.
		const selectedRows = resolveSelectedRows(actionIds, messages, selectedMessages);
		const inboxUnreadDelta = getInboxUnreadDelta(selectedRows, readValue, affectsInboxUnreadCount(config));
		if (readValue !== null) {
			updateMessages((current) =>
				current.map((message) => (actionIds.includes(message.id) ? withReadState(message, readValue) : message)),
			);
			setSelectedMessages((current) => current.map((message) => ({ ...message, read: readValue })));
			if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta });
		}
		/**
		 * Only the rows a later batch did not reach are rolled back and kept selected: a row whose action
		 * already went through must not be flipped back only to be corrected again, and a retry (running the
		 * action again on what is still selected) must never re-send an id that is done.
		 */
		function rollBackUnfinishedRows(error: PartialBulkActionError) {
			const completed = new Set(error.completedIds);
			const isRowDone = (rowId: string) => expandSelectedIds([rowId]).every((id) => completed.has(id));
			const notDoneIds = new Set(actionIds.filter((id) => !isRowDone(id)));
			if (readValue !== null && notDoneIds.size > 0) {
				const previousById = new Map(previousMessages.map((message) => [message.id, message]));
				updateMessages((current) =>
					current.map((message) => (notDoneIds.has(message.id) ? (previousById.get(message.id) ?? message) : message)),
				);
				const revertedDelta = getInboxUnreadDelta(
					selectedRows.filter((row) => notDoneIds.has(row.id)),
					readValue,
					affectsInboxUnreadCount(config),
				);
				if (revertedDelta) dispatchMessageCountsDelta({ inboxUnreadDelta: -revertedDelta });
			}
			setSelectedMessages((current) => current.filter((message) => notDoneIds.has(message.id)));
		}

		try {
			// A declined confirmation did nothing, so the selection stays.
			if ((await runListAction(expandSelectedIds(actionIds), action, folderId)) === LIST_ACTION_CANCELLED) return;
			clearSelection();
		} catch (error) {
			if (error instanceof PartialBulkActionError) {
				rollBackUnfinishedRows(error);
			} else if (readValue !== null) {
				updateMessages(previousMessages);
				if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta: -inboxUnreadDelta });
			}
			reportListActionError(error);
		} finally {
			setPendingBulkAction(false);
		}
	}

	const listRef = useRef<HTMLDivElement>(null);
	// While this list is on screen the "Kite was updated" notice is its first row instead of a toast.
	useRegisterUpdateList(listVisible);
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
		selectAllVisible: () => toggleAllVisible(true),
		listVisible,
	});

	useOpenRowBridge({
		selection,
		rows: orderedMessages,
		rowMessageIds,
		openMessageId,
		listRef,
		folder: config.folder,
		folderId: config.folderId,
	});

	const pager = buildListPager({
		range: pageRange,
		offset,
		limit,
		shown: messages.length,
		total,
		isLoading,
		nextCursor,
		setOffset,
		setPageCursors,
	});
	const paged = isPagerShown(pager, selectedIds.length > 0 && !compact);

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col" data-selection-scope="">
			{/* The toolbar's own "{count} selected" is a text swap, not announced on its own; this live region
			announces the count on every change, including what "Select all in folder" grows it to. Worded apart
			from the toolbar's text so the two never collide under a plain text query. */}
			<p role="status" aria-live="polite" className="sr-only">
				{selectedIds.length > 0
					? `${selectedIds.length} ${selectedIds.length === 1 ? "email" : "emails"} selected`
					: ""}
			</p>
			<MessageListHeader
				config={config}
				compact={compact || isMobile}
				showTitle={compact || isMobile}
				listVisible={listVisible}
				selecting={{
					value: selecting,
					onChange: (value) => {
						setSelecting(value);
						if (!value) setSelectedMessages([]);
					},
				}}
				screenerVisible={screenerVisible}
				semanticUnavailable={semanticUnavailable}
				showAllKeywordMatches={keywordTotal ? { count: keywordTotal, run: () => setSemanticOn(false) } : null}
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

			<div
				className={clsx(
					"min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable",
					// Keyboard focus scrolls a row clear of the sticky pager.
					paged && "scroll-pt-8",
					// Clears the floating "New mail" button (mobile-compose-fab.tsx), which would otherwise sit
					// over the last row's own actions on a phone or folded screen.
					"max-md:pb-20",
				)}
				data-density={density}
			>
				<div
					ref={listRef}
					role="list"
					// Takes the focus when the open message left and no row is next to it.
					tabIndex={-1}
					aria-label={folderTitle(config)}
					className={clsx(
						"outline-none",
						compact || isMobile ? "flex flex-col gap-0.5 py-1.5" : "divide-y divide-neutral-100",
					)}
				>
					<UpdateNoticeRow compact={(compact || isMobile) && config.folder !== "drafts"} density={density} />
					{showSelectAllBanner && (
						<SelectAllBanner
							total={total}
							max={SELECT_ALL_MAX_MESSAGES}
							folderLabel={folderTitle(config)}
							pending={resolvingSelectAll}
							onSelectAll={() => void selectAllMatching()}
						/>
					)}
					{paged && <PagerSlot pager={pager} labelled={!!sections[0]?.label} />}
					{sections.map((section, index) => [
						<ListSectionLabel key={`section-${section.key}`} section={section} withPager={index === 0 && paged} />,
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
								labels={labels}
								viaSlot={messages.some((item) => item.via)}
								mailboxLabel={
									access.showMailboxLabels && labels !== "off" ? (
										<MessageMailboxLabel
											mailbox={access.mailboxOf(message.mailboxId)}
											variant={labels === "full" ? "full" : "compact"}
										/>
									) : null
								}
								canManage={access.canManage(message.mailboxId)}
								onSelectedChange={updateSelectedMessage}
								onLongPressSelect={(messageId) => {
									setSelecting(true);
									updateSelectedMessage(messageId, true);
								}}
								onRowClick={selectRow}
								onMessageAction={async (messageId, action, folderId) => {
									if (action === "spam" && !(await confirmReportSpam(1))) return;
									await runBulkMessageAction(
										expandSelectedIds([messageId]),
										action,
										action !== "read" && action !== "unread",
										folderId,
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
								{t("All clear.")}
							</p>
						)}
						<p className="text-sm text-neutral-500">
							{hasActiveFilters ? t("No messages match these filters") : t(config.emptyText)}
						</p>
					</div>
				)}
			</div>
		</div>
	);
}

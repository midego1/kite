"use client";

import clsx from "clsx";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSidebar } from "@/components/sidebar-state";
import { useAssistantOpen } from "@/components/agent/assistant-open-state";
import { readColumnWidth, readInitialColumnWidth, saveColumnWidth } from "@/components/column-width-preferences";
import { queueLayoutSave } from "@/components/layout-preferences-client";
import { LAYOUT_PREFERENCES_APPLIED_EVENT } from "@/components/layout-preferences-utils";
import { LIST_HEIGHT_LIMITS, LIST_WIDTH_LIMITS } from "@/lib/preferences/layout-utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from "@/components/ui/resizable";
import { layoutPixels, pixelsPerPercent } from "@/components/ui/resizable-utils";
import { useSyncedPanel } from "@/components/ui/use-synced-panel";
import { useKeyChanged } from "@/hooks/use-synced-state";
import { UpdateNoticeReader } from "@/components/update-notice-reader";
import { UpdateReaderHostContext, closeUpdateReader, useUpdateReaderOpen } from "@/components/update-notice-store";
import { BulkMessageSelectionPane } from "./bulk-message-selection-pane";
import { OpenRowContext, useRowLookupHolder } from "./open-row-context";
import { MessageFolderPage } from "./message-folder-page";
import { MessageFolderTitle } from "./message-folder-title";
import { useLeaveOpenMessage } from "./use-leave-open-message";
import { MessageDetailNavigationProvider } from "./message-detail-navigation";
import { MessageListVisibilityContext } from "./message-list-visibility";
import {
	MESSAGE_LIST_VISIBILITY_EVENT,
	readInitialMessageListVisible,
	readMessageListWithAssistant,
	saveMessageListVisible,
	saveMessageListWithAssistant,
} from "./message-list-visibility-utils";
import { ReadingPaneEmptyState } from "./reading-pane-empty-state";
import { getEffectiveReadingPaneMode } from "./reading-layout-utils";
import { useReadingPaneMode, useWideReadingViewport } from "./use-reading-layout";
import { getSelectionToolbarFolder } from "./utils";
import type { BulkSelectionAction, MessageListVisibility, MessageSplitLayoutProps, SelectedMessage } from "./types";

// The list and the reader are separate rounded panels on the page background, a few pixels apart.
const PANEL_CLASS = "rounded-xl border border-neutral-200 shadow-xs";
const LIST_WIDTH = { fallback: 360, ...LIST_WIDTH_LIMITS, reserved: 280 };
const LIST_HEIGHT = { fallback: 320, ...LIST_HEIGHT_LIMITS, reserved: 200 };
// Panel ids are DOM ids too, so they carry a prefix.
const LIST_PANEL_ID = "kite-message-list-panel";

function readSavedListSize(
	userId: string,
	column: "message-list" | "message-list-height",
	limits: { fallback: number; min: number; max: number },
) {
	return readColumnWidth(userId, column, limits.fallback, limits.min, limits.max);
}

/**
 * Opening a message ends a checkbox selection; otherwise the selection pane would keep covering
 * every message the user clicks.
 */
function useClearSelectionOnOpen(
	openMessageId: string | undefined,
	selectedMessages: SelectedMessage[],
	setSelectedMessages: (messages: SelectedMessage[]) => void,
) {
	if (useKeyChanged(openMessageId) && openMessageId && selectedMessages.length > 0) setSelectedMessages([]);
}

/**
 * "What's new" from the "Kite was updated" row takes the reader, as opening a message would: it leaves the open
 * message and ends a checkbox selection. Opening a message closes it again, and so does leaving this list, so it
 * never waits in another folder's reader.
 */
function useUpdateReader(
	selectedMessageId: string | undefined,
	visibleMessageId: string | undefined,
	leave: { leaveOpenMessage: () => void; clearSelection: () => void },
) {
	const open = useUpdateReaderOpen();
	const latest = useRef(leave);
	useEffect(() => {
		latest.current = leave;
	});
	useEffect(() => {
		if (!open) return;
		latest.current.clearSelection();
		latest.current.leaveOpenMessage();
	}, [open]);
	useEffect(() => {
		if (selectedMessageId) closeUpdateReader();
	}, [selectedMessageId]);
	useEffect(() => closeUpdateReader, []);
	return open && !visibleMessageId;
}

/**
 * Arranges the message list and reading pane using the user's layout and sizing preferences: resizable
 * panels side by side or stacked, or one column. Manages checkbox selection and clears it when a new
 * message is opened.
 */
export function MessageSplitLayout({ children, config }: MessageSplitLayoutProps) {
	const pathname = usePathname();
	const [selectedMessages, setSelectedMessages] = useState<SelectedMessage[]>([]);
	const [listWidth, setListWidth] = useState(LIST_WIDTH.fallback);
	const [listHeight, setListHeight] = useState(LIST_HEIGHT.fallback);
	const [manualListVisible, setManualListVisible] = useState(true);
	const [preferredMode] = useReadingPaneMode();
	const wideViewport = useWideReadingViewport();
	const mode = getEffectiveReadingPaneMode(preferredMode, wideViewport);
	const split = mode !== "none";
	const below = mode === "below";
	const bulkActionRef = useRef<BulkSelectionAction | null>(null);
	const listPanelRef = usePanelRef();
	const { userId } = useSidebar();
	const assistantOpen = useAssistantOpen();
	const detailPrefix = `${config.hrefPrefix}/`;
	const selectedMessageId = pathname.startsWith(detailPrefix)
		? pathname.slice(detailPrefix.length).split("/")[0]
		: undefined;
	const { visibleMessageId, leaveOpenMessage } = useLeaveOpenMessage(selectedMessageId, config);
	// The list's lookup of the ids each row stands for, read by the reader when it moves the open message.
	const rowLookup = useRowLookupHolder();
	useClearSelectionOnOpen(selectedMessageId, selectedMessages, setSelectedMessages);
	const updateReaderOpen = useUpdateReader(selectedMessageId, visibleMessageId, {
		leaveOpenMessage,
		clearSelection: () => {
			if (selectedMessages.length > 0) setSelectedMessages([]);
		},
	});
	const clearSelection = () => {
		setSelectedMessages([]);
		leaveOpenMessage();
	};
	// With the assistant open the list hides to make room unless the user chose to keep it there.
	const [assistantListShown, setAssistantListShown] = useState(false);
	// The hide-list toggle lives in the open message's header, so with nothing open the list always shows.
	const listVisible = split && (!selectedMessageId || (manualListVisible && (!assistantOpen || assistantListShown)));
	const listSize = below ? listHeight : listWidth;
	const listLimits = below ? LIST_HEIGHT : LIST_WIDTH;
	const changedByPanel = useSyncedPanel(listPanelRef, !listVisible, listSize);
	// Pixels per percent of the group, as the list last reported, to read pixel sizes from a layout.
	const groupScale = useRef(1);

	useLayoutEffect(() => {
		// Persisted preferences are only readable in the browser and must apply before paint.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setListWidth(readInitialColumnWidth("message-list", LIST_WIDTH.fallback, LIST_WIDTH.min, LIST_WIDTH.max));
		setListHeight(
			readInitialColumnWidth("message-list-height", LIST_HEIGHT.fallback, LIST_HEIGHT.min, LIST_HEIGHT.max),
		);
		const syncVisible = () => {
			setManualListVisible(readInitialMessageListVisible());
			setAssistantListShown(readMessageListWithAssistant());
		};
		syncVisible();
		window.addEventListener(MESSAGE_LIST_VISIBILITY_EVENT, syncVisible);
		return () => window.removeEventListener(MESSAGE_LIST_VISIBILITY_EVENT, syncVisible);
	}, []);

	useEffect(() => {
		if (!userId) return;
		const readSaved = () => {
			// The account's sizes arrive in localStorage once the session is known, or later from another device.
			setListWidth(readSavedListSize(userId, "message-list", LIST_WIDTH));
			setListHeight(readSavedListSize(userId, "message-list-height", LIST_HEIGHT));
		};
		window.addEventListener(LAYOUT_PREFERENCES_APPLIED_EVENT, readSaved);
		return () => window.removeEventListener(LAYOUT_PREFERENCES_APPLIED_EVENT, readSaved);
	}, [userId]);

	useEffect(() => {
		if (!userId) return;
		const savedWidth = readColumnWidth(
			userId,
			"message-list",
			readInitialColumnWidth("message-list", LIST_WIDTH.fallback, LIST_WIDTH.min, LIST_WIDTH.max),
			LIST_WIDTH.min,
			LIST_WIDTH.max,
		);
		const savedHeight = readColumnWidth(
			userId,
			"message-list-height",
			readInitialColumnWidth("message-list-height", LIST_HEIGHT.fallback, LIST_HEIGHT.min, LIST_HEIGHT.max),
			LIST_HEIGHT.min,
			LIST_HEIGHT.max,
		);
		// The per-account sizes live in localStorage and are known only once the session loads.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setListWidth(savedWidth);
		setListHeight(savedHeight);
		saveColumnWidth(userId, "message-list", savedWidth);
		saveColumnWidth(userId, "message-list-height", savedHeight);
	}, [userId]);

	if (!split && !selectedMessageId && !updateReaderOpen)
		return <UpdateReaderHostContext.Provider value>{children}</UpdateReaderHostContext.Provider>;

	function setListVisible(visible: boolean) {
		if (assistantOpen) {
			setAssistantListShown(visible);
			saveMessageListWithAssistant(visible);
		}
		if (!assistantOpen || visible) {
			setManualListVisible(visible);
			saveMessageListVisible(visible);
		}
	}

	function storeListSize(next: number) {
		if (next === 0) {
			// Dragging the list shut hides it like the header button; with nothing open it springs back.
			if (selectedMessageId && listVisible) {
				changedByPanel();
				setListVisible(false);
			} else if (!selectedMessageId) listPanelRef.current?.expand();
			return;
		}
		saveColumnWidth(userId, below ? "message-list-height" : "message-list", next);
		queueLayoutSave(below ? { listHeight: next } : { listWidth: next });
		if (!listVisible) {
			changedByPanel();
			setListVisible(true);
		}
		if (next === listSize) return;
		changedByPanel();
		if (below) setListHeight(next);
		else setListWidth(next);
	}

	const visibility: MessageListVisibility = {
		visible: listVisible,
		toggle: () => setListVisible(!listVisible),
		singleColumn: !split,
		stacked: below,
		backHref: config.hrefPrefix,
		backLabel: config.title,
	};

	const detail = (
		<MessageListVisibilityContext.Provider value={visibility}>
			<MessageDetailNavigationProvider config={config}>
				<OpenRowContext.Provider value={rowLookup.lookup}>
					<section
						className={clsx("flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white", split && PANEL_CLASS)}
					>
						{split && !below && selectedMessages.length > 0 ? (
							<BulkMessageSelectionPane
								folder={getSelectionToolbarFolder(config)}
								selectedMessages={selectedMessages}
								onAction={(action, folderId) => bulkActionRef.current?.(action, folderId) ?? Promise.resolve()}
								onClearSelection={clearSelection}
							/>
						) : updateReaderOpen ? (
							<UpdateNoticeReader />
						) : visibleMessageId ? (
							children
						) : (
							<ReadingPaneEmptyState config={config} />
						)}
					</section>
				</OpenRowContext.Provider>
			</MessageDetailNavigationProvider>
		</MessageListVisibilityContext.Provider>
	);

	if (!split)
		return (
			<div className="h-full min-h-0 overflow-hidden">
				<MessageFolderTitle config={config} />
				{detail}
			</div>
		);

	return (
		<UpdateReaderHostContext.Provider value>
			<ResizablePanelGroup
				key={mode}
				id={`kite-message-layout-${mode}`}
				orientation={below ? "vertical" : "horizontal"}
				data-reading-pane={mode}
				className="min-h-0 overflow-hidden"
				onLayoutChanged={(layout, meta) => {
					if (meta.isUserInteraction) storeListSize(layoutPixels(layout[LIST_PANEL_ID], groupScale.current));
				}}
			>
				<ResizablePanel
					id={LIST_PANEL_ID}
					panelRef={listPanelRef}
					collapsible
					collapsedSize={0}
					collapsedThreshold={listLimits.min}
					minSize={listLimits.min}
					maxSize={listLimits.max}
					defaultSize={listVisible ? listSize : 0}
					groupResizeBehavior="preserve-pixel-size"
					onResize={(size) => {
						groupScale.current = pixelsPerPercent(size) ?? groupScale.current;
					}}
				>
					<aside
						className={clsx("h-full min-h-0 min-w-0 overflow-hidden bg-white", PANEL_CLASS)}
						aria-hidden={!listVisible}
						inert={!listVisible}
					>
						<MessageFolderPage
							config={config}
							compact={!below}
							listVisible={listVisible}
							selectedMessageId={selectedMessageId}
							selection={{
								selectedMessages,
								setSelectedMessages,
								leaveOpenMessage,
								registerAction: (run) => {
									bulkActionRef.current = run;
								},
								registerRowLookup: rowLookup.register,
							}}
						/>
					</aside>
				</ResizablePanel>
				<ResizableHandle
					aria-label={below ? "Resize message list height" : "Resize message list"}
					// A hidden list has no handle: it is not a tab stop, and arrow keys cannot drag the list back open.
					disabled={!listVisible}
					aria-hidden={listVisible ? undefined : true}
					className={clsx(
						// The handle sits in the gap between the two panels.
						"bg-transparent aria-[orientation=horizontal]:my-1 aria-[orientation=vertical]:mx-1",
						!listVisible && "pointer-events-none opacity-0",
					)}
				/>
				<ResizablePanel id="kite-reader-panel" minSize={listLimits.reserved}>
					{detail}
				</ResizablePanel>
			</ResizablePanelGroup>
		</UpdateReaderHostContext.Provider>
	);
}

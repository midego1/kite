"use client";

import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSidebar } from "@/components/sidebar-state";
import { useAssistantOpen } from "@/components/agent/assistant-open-state";
import { readColumnWidth, readInitialColumnWidth, saveColumnWidth } from "@/components/column-width-preferences";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { BulkMessageSelectionPane } from "./bulk-message-selection-pane";
import { MessageFolderPage } from "./message-folder-page";
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
import { clampListSize, getEffectiveReadingPaneMode } from "./reading-layout-utils";
import { useReadingPaneMode, useWideReadingViewport } from "./use-reading-layout";
import type { BulkSelectionAction, MessageListVisibility, MessageSplitLayoutProps, SelectedMessage } from "./types";

const LIST_WIDTH = { fallback: 360, min: 250, max: 1200, reserved: 280 };
const LIST_HEIGHT = { fallback: 320, min: 120, max: 1200, reserved: 200 };

export function MessageSplitLayout({ children, config }: MessageSplitLayoutProps) {
	const pathname = usePathname();
	const [selectedMessages, setSelectedMessages] = useState<SelectedMessage[]>([]);
	const [listWidth, setListWidth] = useState(LIST_WIDTH.fallback);
	const [listHeight, setListHeight] = useState(LIST_HEIGHT.fallback);
	const [sizeReady, setSizeReady] = useState(false);
	const [resizing, setResizing] = useState(false);
	const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
	const [manualListVisible, setManualListVisible] = useState(true);
	const [preferredMode] = useReadingPaneMode();
	const wideViewport = useWideReadingViewport();
	const mode = getEffectiveReadingPaneMode(preferredMode, wideViewport);
	const split = mode !== "none";
	const below = mode === "below";
	const containerRef = useRef<HTMLDivElement>(null);
	const listFrameRef = useRef<HTMLDivElement>(null);
	const resizeFrame = useRef<number | null>(null);
	const bulkActionRef = useRef<BulkSelectionAction | null>(null);
	const startSize = useRef(0);
	const resizedSize = useRef(0);
	const { userId, setForcedMinimal } = useSidebar();
	const assistantOpen = useAssistantOpen();
	const detailPrefix = `${config.hrefPrefix}/`;
	const selectedMessageId = pathname.startsWith(detailPrefix)
		? pathname.slice(detailPrefix.length).split("/")[0]
		: undefined;
	const { visibleMessageId, leaveOpenMessage } = useLeaveOpenMessage(selectedMessageId, config.hrefPrefix);
	const clearSelection = () => {
		setSelectedMessages([]);
		leaveOpenMessage();
	};
	// With the assistant open the list hides to make room unless the user chose to keep it there.
	const [assistantListShown, setAssistantListShown] = useState(false);
	// The hide-list toggle lives in the open message's header, so with nothing open the list always shows.
	const listVisible = split && (!selectedMessageId || (manualListVisible && (!assistantOpen || assistantListShown)));
	const renderedListWidth = clampListSize(listWidth, LIST_WIDTH.min, containerSize.width || 1000, LIST_WIDTH.reserved);
	const renderedListHeight = clampListSize(
		listHeight,
		LIST_HEIGHT.min,
		containerSize.height || 800,
		LIST_HEIGHT.reserved,
	);

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
		const frame = requestAnimationFrame(() => setSizeReady(true));
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener(MESSAGE_LIST_VISIBILITY_EVENT, syncVisible);
		};
	}, []);

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

	useLayoutEffect(() => {
		if (!split) {
			setForcedMinimal(false);
			return;
		}
		const container = containerRef.current;
		if (!container) return;
		const measure = () => setContainerSize({ width: container.clientWidth, height: container.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		return () => observer.disconnect();
	}, [split, setForcedMinimal]);

	useEffect(() => () => setForcedMinimal(false), [setForcedMinimal]);
	useEffect(
		() => () => {
			if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current);
		},
		[],
	);

	if (!split && !selectedMessageId) return children;

	const visibility: MessageListVisibility = {
		visible: listVisible,
		toggle: () => {
			const visible = !listVisible;
			if (assistantOpen) {
				setAssistantListShown(visible);
				saveMessageListWithAssistant(visible);
			}
			if (!assistantOpen || visible) {
				setManualListVisible(visible);
				saveMessageListVisible(visible);
			}
		},
		singleColumn: !split,
		stacked: below,
		backHref: config.hrefPrefix,
		backLabel: config.title,
	};

	const detail = (
		<MessageListVisibilityContext.Provider value={visibility}>
			<MessageDetailNavigationProvider config={config}>
				<section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white">
					{split && !below && selectedMessages.length > 0 ? (
						<BulkMessageSelectionPane
							folder={config.folder}
							selectedMessages={selectedMessages}
							onAction={(action, folderId) => bulkActionRef.current?.(action, folderId) ?? Promise.resolve()}
							onClearSelection={clearSelection}
						/>
					) : visibleMessageId ? (
						children
					) : (
						<ReadingPaneEmptyState config={config} />
					)}
				</section>
			</MessageDetailNavigationProvider>
		</MessageListVisibilityContext.Provider>
	);

	if (!split) return <div className="h-full min-h-0 overflow-hidden">{detail}</div>;

	const hiddenTransform = below ? "-translate-y-full" : "-translate-x-full";
	// While dragging, sizes go straight to the DOM once per frame: re-rendering the list on every
	// pointer move, behind a 300 ms grid transition, made the divider trail the cursor.
	const transitionDuration = sizeReady && !resizing ? "300ms" : "0ms";

	function paintResize() {
		resizeFrame.current = null;
		const container = containerRef.current;
		const frame = listFrameRef.current;
		if (!container || !frame) return;
		const size = `${resizedSize.current}px`;
		if (below) {
			container.style.gridTemplateRows = `${size} minmax(0,1fr)`;
			frame.style.height = size;
		} else {
			container.style.gridTemplateColumns = `${size} minmax(0,1fr)`;
			frame.style.width = size;
		}
	}

	return (
		<div
			ref={containerRef}
			data-reading-pane={mode}
			className={`grid h-full min-h-0 overflow-hidden ease-in-out motion-reduce:transition-none ${below ? "transition-[grid-template-rows]" : "transition-[grid-template-columns]"}`}
			style={
				below
					? {
							gridTemplateRows: `${listVisible ? renderedListHeight : 0}px minmax(0,1fr)`,
							gridTemplateColumns: "minmax(0,1fr)",
							transitionDuration,
						}
					: { gridTemplateColumns: `${listVisible ? renderedListWidth : 0}px minmax(0,1fr)`, transitionDuration }
			}
		>
			{/* Clip only while hidden: a visible list would cut off the half of the resize handle that straddles the border. */}
			<aside
				className={`relative min-h-0 min-w-0 bg-white ${listVisible ? (below ? "border-b border-neutral-200" : "border-r border-neutral-200") : "pointer-events-none overflow-hidden"}`}
				aria-hidden={!listVisible}
				inert={!listVisible}
			>
				<div
					ref={listFrameRef}
					className={`overflow-hidden transition-transform duration-300 ease-in-out motion-reduce:transition-none ${listVisible ? "translate-x-0 translate-y-0" : hiddenTransform}`}
					style={below ? { height: renderedListHeight } : { width: renderedListWidth, height: "100%" }}
				>
					<MessageFolderPage
						config={config}
						compact={!below}
						selectedMessageId={selectedMessageId}
						selection={{
							selectedMessages,
							setSelectedMessages,
							leaveOpenMessage,
							registerAction: (run) => {
								bulkActionRef.current = run;
							},
						}}
					/>
				</div>
				<ResizeHandle
					label={below ? "Resize message list height" : "Resize message list"}
					orientation={below ? "horizontal" : "vertical"}
					onResizeStart={() => {
						startSize.current = below ? renderedListHeight : renderedListWidth;
						resizedSize.current = startSize.current;
						setResizing(true);
					}}
					onResize={(delta) => {
						const requested = startSize.current + delta;
						const container = containerRef.current;
						if (below) {
							resizedSize.current = clampListSize(
								requested,
								LIST_HEIGHT.min,
								container?.clientHeight ?? 800,
								LIST_HEIGHT.reserved,
							);
						} else {
							setForcedMinimal(requested < LIST_WIDTH.min);
							resizedSize.current = clampListSize(
								requested,
								LIST_WIDTH.min,
								container?.clientWidth ?? 1000,
								LIST_WIDTH.reserved,
							);
						}
						resizeFrame.current ??= requestAnimationFrame(paintResize);
					}}
					onResizeEnd={() => {
						if (resizeFrame.current !== null) {
							cancelAnimationFrame(resizeFrame.current);
							paintResize();
						}
						if (below) setListHeight(resizedSize.current);
						else setListWidth(resizedSize.current);
						setResizing(false);
						saveColumnWidth(userId, below ? "message-list-height" : "message-list", resizedSize.current);
					}}
				/>
			</aside>
			{detail}
		</div>
	);
}

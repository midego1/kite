"use client";

import { useRef, type ReactNode } from "react";
import { saveColumnWidth } from "./column-width-preferences";
import { useSidebar } from "./sidebar-state";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from "./ui/resizable";
import { layoutPixels, pixelsPerPercent } from "./ui/resizable-utils";
import { useSyncedPanel } from "./ui/use-synced-panel";

/** The icon rail's width, which is the collapsed sidebar panel's size. */
const RAIL_WIDTH = 72;
const SIDEBAR_WIDTH = { min: 200, max: 480 };
const PAGE_MIN_WIDTH = 480;

/**
 * The sidebar and the page beside it as resizable panels. The sidebar collapses to its icon rail when it is
 * dragged narrower than its minimum or toggled from its header; width and rail state are the same
 * preferences the sidebar always used (`kite-column-width:sidebar`, `kite-sidebar-minimal`).
 */
export function SidebarPanels({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
	const { minimal, width, userId, setMinimal, setWidth } = useSidebar();
	const panelRef = usePanelRef();
	const changedByPanel = useSyncedPanel(panelRef, minimal, width);
	// Pixels per percent of the group, as the sidebar last reported, to read pixel sizes from a layout.
	const groupScale = useRef(1);
	const saveWidth = (next: number) => {
		if (next <= RAIL_WIDTH + 1) return;
		saveColumnWidth(userId, "sidebar", next);
		if (next === width) return;
		changedByPanel();
		setWidth(next);
	};

	return (
		<ResizablePanelGroup
			id="kite-sidebar-layout"
			orientation="horizontal"
			onLayoutChanged={(layout, meta) => {
				if (meta.isUserInteraction) saveWidth(layoutPixels(layout.sidebar, groupScale.current));
			}}
		>
			<ResizablePanel
				id="sidebar"
				panelRef={panelRef}
				collapsible
				collapsedSize={RAIL_WIDTH}
				minSize={SIDEBAR_WIDTH.min}
				maxSize={SIDEBAR_WIDTH.max}
				defaultSize={minimal ? RAIL_WIDTH : width}
				groupResizeBehavior="preserve-pixel-size"
				onResize={(size) => {
					groupScale.current = pixelsPerPercent(size) ?? groupScale.current;
					// The navigation switches to its rail as soon as a drag snaps the panel shut, not only on release.
					const collapsed = size.inPixels <= RAIL_WIDTH + 1;
					if (collapsed === minimal) return;
					changedByPanel();
					setMinimal(collapsed);
				}}
			>
				{sidebar}
			</ResizablePanel>
			<ResizableHandle aria-label="Resize left menu" className="bg-transparent" />
			<ResizablePanel id="page" minSize={PAGE_MIN_WIDTH}>
				{children}
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}

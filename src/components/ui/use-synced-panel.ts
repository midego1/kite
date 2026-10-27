"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { panelSyncAction } from "./resizable-utils";

/**
 * Keeps a resizable panel at a stored preference that can change outside the panel (loaded after mount,
 * a toggle button). Call the returned function before storing a change that came from the panel itself,
 * such as a drag, so the panel is not moved back to where the change started.
 */
export function useSyncedPanel(
	panelRef: RefObject<PanelImperativeHandle | null>,
	wantCollapsed: boolean,
	wantSize: number,
): () => void {
	const fromPanel = useRef(false);

	useLayoutEffect(() => {
		if (fromPanel.current) {
			fromPanel.current = false;
			return;
		}
		const panel = panelRef.current;
		if (!panel) return;
		const action = panelSyncAction({
			wantCollapsed,
			wantSize,
			collapsed: panel.isCollapsed(),
			size: panel.getSize().inPixels,
		});
		if (action === "collapse") panel.collapse();
		else if (action === "expand") panel.expand();
		if (action === "expand" || action === "resize") panel.resize(wantSize);
	}, [panelRef, wantCollapsed, wantSize]);

	return useCallback(() => {
		fromPanel.current = true;
	}, []);
}

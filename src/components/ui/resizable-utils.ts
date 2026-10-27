export type PanelSyncAction = "collapse" | "expand" | "resize" | "none";

/**
 * What a panel has to do to show a stored preference: `wantCollapsed`, else `wantSize` pixels. Sizes within a
 * pixel count as equal, since the library rounds them.
 */
export function panelSyncAction({
	wantCollapsed,
	wantSize,
	collapsed,
	size,
}: {
	wantCollapsed: boolean;
	wantSize: number;
	collapsed: boolean;
	size: number;
}): PanelSyncAction {
	if (wantCollapsed) return collapsed ? "none" : "collapse";
	if (collapsed) return "expand";
	return Math.abs(size - wantSize) > 1 ? "resize" : "none";
}

/**
 * A panel's size in pixels from a group layout (percentages), using the pixels per percent of the group
 * that the panel last reported. onLayoutChanged reports the new layout before the panel's onResize does.
 */
export function layoutPixels(percent: number | undefined, pixelsPerPercent: number): number {
	return percent === undefined ? 0 : Math.round(percent * pixelsPerPercent);
}

/** Pixels per percent of the group from a panel size; null while the panel is collapsed to nothing. */
export function pixelsPerPercent(size: { inPixels: number; asPercentage: number }): number | null {
	return size.asPercentage > 0 ? size.inPixels / size.asPercentage : null;
}

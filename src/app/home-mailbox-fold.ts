import type { CSSProperties } from "react";
import type { FoldHinge, FoldViewport } from "@/components/fold-posture-utils";

/*
 * An unfolded foldable that reports its screens (Viewport Segments, or the legacy screen-spanning query) shows the
 * list on the first screen (the second when mirrored) and the reader on the other, with the hinge between them empty, as the app's mail
 * view does (messages/use-fold-split.ts). The geometry comes from the browser's env() values where it has them and
 * from the measured segments otherwise. Folded covers and desktops have no hinge and the grid is the ordinary one.
 */

/** The hinge to lay out around, when the posture is unfolded and the screens sit side by side. */
export function homeHinge(fold: FoldViewport): FoldHinge | null {
	return fold.posture === "unfolded" && fold.splitWidth && fold.hinge?.orientation === "vertical" ? fold.hinge : null;
}

/** Columns of the screen the reading direction starts on, the hinge and the other screen. */
export function hingeGrid(hinge: FoldHinge, rtl: boolean): CSSProperties {
	// The grid starts after the root's safe-area inset, not at the viewport's edge, so the first column ends at that
	// screen's inner edge minus the inset; the max() keeps a length valid. Mirrored, the grid starts at the right.
	const first = rtl
		? `max(0px, calc(100vw - env(viewport-segment-left 1 0, ${hinge.second.left}px) - env(safe-area-inset-right, 0px)))`
		: `max(0px, calc(env(viewport-segment-right 0 0, ${hinge.first.left + hinge.first.width}px) - env(safe-area-inset-left, 0px)))`;
	const gap = `max(${hinge.gap}px, calc(env(viewport-segment-left 1 0, 0px) - env(viewport-segment-right 0 0, 0px)))`;
	return { gridTemplateColumns: `${first} ${gap} minmax(0, 1fr)` };
}

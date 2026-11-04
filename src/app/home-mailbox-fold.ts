import type { CSSProperties } from "react";
import type { FoldHinge, FoldViewport } from "@/components/fold-posture-utils";

/*
 * An unfolded foldable that reports its screens (Viewport Segments, or the legacy screen-spanning query) shows the
 * list on the first screen and the reader on the second, with the hinge between them empty, as the app's mail
 * view does (messages/use-fold-split.ts). The geometry comes from the browser's env() values where it has them and
 * from the measured segments otherwise. Folded covers and desktops have no hinge and the grid is the ordinary one.
 */

/** The hinge to lay out around, when the posture is unfolded and the screens sit side by side. */
export function homeHinge(fold: FoldViewport): FoldHinge | null {
	return fold.posture === "unfolded" && fold.splitWidth && fold.hinge?.orientation === "vertical" ? fold.hinge : null;
}

/** Columns of the first screen, the hinge and the second screen. */
export function hingeGrid(hinge: FoldHinge): CSSProperties {
	// The grid starts after the root's left safe-area inset, not at the viewport's left edge, so the first
	// column ends at the first screen's right edge minus that inset; the max() keeps a length valid.
	const first = `max(0px, calc(env(viewport-segment-right 0 0, ${hinge.first.left + hinge.first.width}px) - env(safe-area-inset-left, 0px)))`;
	const gap = `max(${hinge.gap}px, calc(env(viewport-segment-left 1 0, 0px) - env(viewport-segment-right 0 0, 0px)))`;
	return { gridTemplateColumns: `${first} ${gap} minmax(0, 1fr)` };
}

import { useLayoutEffect, useState, type CSSProperties } from "react";
import { resolveFoldReadingPane, type FoldHinge } from "@/components/fold-posture-utils";
import { useInterfaceDirection } from "@/components/interface-direction-provider";
import { useFoldViewport } from "@/components/use-fold-posture";
import { LIST_HEIGHT_LIMITS, LIST_WIDTH_LIMITS } from "@/lib/preferences/layout-utils";
import { useReadingPaneMode } from "./use-reading-layout";

// What the list may be and what the reader keeps, in pixels: width beside the reader, height above it.
export const LIST_WIDTH = { fallback: 360, ...LIST_WIDTH_LIMITS, reserved: 280 };
export const LIST_HEIGHT = { fallback: 320, ...LIST_HEIGHT_LIMITS, reserved: 200 };
/** The horizontal edges of the panel group in viewport coordinates. */
export type GroupEdges = { left: number; right: number };
/** The hairline handle between the panels and its 4px margin on each side. */
const HANDLE_WIDTH = 9;
/** Two panes need this much room; below it the list and reader would overlap or clip. */
const SPLIT_MIN_WIDTH = LIST_WIDTH.min + LIST_WIDTH.reserved + HANDLE_WIDTH;

/**
 * How the list and the reader share the screen on a foldable device: the reading-pane mode after the fold
 * posture and the room there is, and for a vertical hinge the width the list may take without crossing it.
 *
 * `measureRef` goes on a zero-height element in the page panel, which is as wide as the panes would be and is
 * there whether or not they are shown.
 */
export function useFoldSplit() {
	const [preferredMode] = useReadingPaneMode();
	const fold = useFoldViewport();
	const [measured, setMeasured] = useState<HTMLElement | null>(null);
	const [fits, setFits] = useState(true);
	const [groupEdges, setGroupEdges] = useState<GroupEdges | null>(null);
	const rtl = useInterfaceDirection() === "rtl";
	const wanted = resolveFoldReadingPane(preferredMode, fold.posture, fold.wide, fold.override);
	// Only an unfolded screen falls back: a desktop keeps its split however much a docked assistant narrows it.
	// Stacked panes need height, not width, so only a side-by-side split has to fit.
	const mode = wanted === "right" && fold.posture === "unfolded" && !fits ? "none" : wanted;
	const split = mode !== "none";
	// A vertical hinge gets its own space, and the list starts in the first screen instead of under the fold.
	// Stacked panes span both screens and are left alone.
	const hinge =
		mode === "right" && fold.posture === "unfolded" && fold.hinge?.orientation === "vertical" ? fold.hinge : null;
	const followsEdges = hinge !== null;

	useLayoutEffect(() => {
		if (!measured) return;
		const measure = () => {
			const box = measured.getBoundingClientRect();
			// A width of 0 is a panel that is not laid out (a full-size assistant), not a screen that is too small.
			if (box.width > 0) setFits(box.width >= SPLIT_MIN_WIDTH);
			if (followsEdges) setGroupEdges({ left: box.left, right: box.right });
		};
		measure();
		// The width changes whenever an edge can move too: a sidebar drag, a window resize, the assistant.
		const observer = new ResizeObserver(measure);
		observer.observe(measured);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [measured, followsEdges]);

	const hingeListWidth = hinge && groupEdges ? foldHingeListWidth(hinge, groupEdges, rtl) : null;

	return {
		mode,
		groupKey: hinge ? `${mode}-hinge` : mode,
		split,
		below: mode === "below",
		hinge,
		groupEdges,
		rtl,
		setMeasured,
		hingeListWidth,
	};
}

/**
 * The list keeps to the screen the reading direction starts on: the first (left) one, or the second when mirrored,
 * with the reader on the other. Segments are viewport coordinates and a panel's size is measured inside the group,
 * whose edge the sidebar pushes inward, so the list gets only what is left of its screen and cannot cross the hinge.
 */
function foldHingeListWidth(hinge: FoldHinge, group: GroupEdges, rtl: boolean): number {
	return Math.max(0, rtl ? group.right - hinge.second.left : hinge.first.width - group.left);
}

/** The list's size limits, capped to the space before a hinge when there is one. */
export function foldListBounds(limits: { min: number; max: number }, hingeListWidth: number | null) {
	const max = hingeListWidth === null ? limits.max : Math.min(limits.max, hingeListWidth);
	return { min: Math.min(limits.min, max), max };
}

/**
 * Where the group's panels sit around a vertical hinge: padding puts each panel on its own screen, and the gaps on
 * both sides of the handle add up to the hinge. `env(viewport-segment-*)` wins where the browser reports Viewport
 * Segments; the measured geometry is the fallback. With the list hidden the reader still keeps to its own screen
 * instead of spreading over the hinge. A mirrored group is physically reversed (`ui/resizable.tsx`), so the padding
 * stays physical: the list's empty place is on the right, and the reader keeps to the first screen.
 */
export function foldHingeStyle(
	hinge: FoldHinge | null,
	group: GroupEdges | null,
	listVisible: boolean,
	rtl = false,
): CSSProperties | undefined {
	if (!hinge) return undefined;
	const hingeGap = `max(${hinge.gap}px, calc(env(viewport-segment-left 1 0, 0px) - env(viewport-segment-right 0 0, 0px)))`;
	const firstRight = `env(viewport-segment-right 0 0, ${hinge.first.left + hinge.first.width}px)`;
	const secondLeft = `env(viewport-segment-left 1 0, ${hinge.second.left}px)`;
	const screenLeft = `env(viewport-segment-left 0 0, ${hinge.first.left}px)`;
	const screenRight = `calc(100vw - env(viewport-segment-right 1 0, ${hinge.second.left + hinge.second.width}px))`;
	const pastHandle = `2 * var(--kite-fold-gap) - ${HANDLE_WIDTH}px`;
	const listHiddenLeft = `max(0px, calc(${secondLeft} - ${group?.left ?? 0}px - ${pastHandle}))`;
	const listHiddenRight = `max(0px, calc(${group?.right ?? hinge.second.left + hinge.second.width}px - ${firstRight} - ${pastHandle}))`;
	return {
		"--kite-fold-gap": `max(0px, calc((${hingeGap} - ${HANDLE_WIDTH}px) / 2))`,
		"--kite-fold-left": listVisible || rtl ? screenLeft : listHiddenLeft,
		"--kite-fold-right": listVisible || !rtl ? screenRight : listHiddenRight,
	} as CSSProperties;
}

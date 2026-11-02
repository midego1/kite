import { useLayoutEffect, useState, type CSSProperties } from "react";
import { resolveFoldReadingPane, type FoldHinge } from "@/components/fold-posture-utils";
import { useFoldViewport } from "@/components/use-fold-posture";
import { LIST_HEIGHT_LIMITS, LIST_WIDTH_LIMITS } from "@/lib/preferences/layout-utils";
import { useReadingPaneMode } from "./use-reading-layout";

// What the list may be and what the reader keeps, in pixels: width beside the reader, height above it.
export const LIST_WIDTH = { fallback: 360, ...LIST_WIDTH_LIMITS, reserved: 280 };
export const LIST_HEIGHT = { fallback: 320, ...LIST_HEIGHT_LIMITS, reserved: 200 };
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
	const [groupLeft, setGroupLeft] = useState<number | null>(null);
	const wanted = resolveFoldReadingPane(preferredMode, fold.posture, fold.wide, fold.override);
	// Only an unfolded screen falls back: a desktop keeps its split however much a docked assistant narrows it.
	// Stacked panes need height, not width, so only a side-by-side split has to fit.
	const mode = wanted === "right" && fold.posture === "unfolded" && !fits ? "none" : wanted;
	const split = mode !== "none";
	// A vertical hinge gets its own space, and the list starts in the first screen instead of under the fold.
	// Stacked panes span both screens and are left alone.
	const hinge =
		mode === "right" && fold.posture === "unfolded" && fold.hinge?.orientation === "vertical" ? fold.hinge : null;
	const followsLeft = hinge !== null;

	useLayoutEffect(() => {
		if (!measured) return;
		const measure = () => {
			const box = measured.getBoundingClientRect();
			// A width of 0 is a panel that is not laid out (a full-size assistant), not a screen that is too small.
			if (box.width > 0) setFits(box.width >= SPLIT_MIN_WIDTH);
			if (followsLeft) setGroupLeft(box.left);
		};
		measure();
		// The width changes whenever the left edge can move too: a sidebar drag, a window resize, the assistant.
		const observer = new ResizeObserver(measure);
		observer.observe(measured);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [measured, followsLeft]);

	// hinge.first is in viewport coordinates, but a panel's size is measured inside the group, whose left edge
	// the sidebar pushes right; the list gets only what is left of the first screen, so it cannot cross the hinge.
	const hingeListWidth = hinge && groupLeft !== null ? Math.max(0, hinge.first.width - groupLeft) : null;

	return {
		mode,
		groupKey: hinge ? `${mode}-hinge` : mode,
		split,
		below: mode === "below",
		hinge,
		groupLeft,
		setMeasured,
		hingeListWidth,
	};
}

/** The list's size limits, capped to the space before a hinge when there is one. */
export function foldListBounds(limits: { min: number; max: number }, hingeListWidth: number | null) {
	const max = hingeListWidth === null ? limits.max : Math.min(limits.max, hingeListWidth);
	return { min: Math.min(limits.min, max), max };
}

/**
 * Where the group's panels sit around a vertical hinge: padding puts the list on the first screen and the reader
 * on the second, and the gaps on both sides of the handle add up to the hinge. `env(viewport-segment-*)` wins
 * where the browser reports Viewport Segments; the measured geometry is the fallback. With the list hidden the
 * reader still starts on the second screen instead of spreading over the hinge.
 */
export function foldHingeStyle(
	hinge: FoldHinge | null,
	groupLeft: number | null,
	listVisible: boolean,
): CSSProperties | undefined {
	if (!hinge) return undefined;
	const hingeGap = `max(${hinge.gap}px, calc(env(viewport-segment-left 1 0, 0px) - env(viewport-segment-right 0 0, 0px)))`;
	const secondLeft = `env(viewport-segment-left 1 0, ${hinge.second.left}px)`;
	const left = listVisible
		? `env(viewport-segment-left 0 0, ${hinge.first.left}px)`
		: `max(0px, calc(${secondLeft} - ${groupLeft ?? 0}px - 2 * var(--kite-fold-gap) - ${HANDLE_WIDTH}px))`;
	return {
		"--kite-fold-gap": `max(0px, calc((${hingeGap} - ${HANDLE_WIDTH}px) / 2))`,
		"--kite-fold-left": left,
		"--kite-fold-right": `calc(100vw - env(viewport-segment-right 1 0, ${hinge.second.left + hinge.second.width}px))`,
	} as CSSProperties;
}

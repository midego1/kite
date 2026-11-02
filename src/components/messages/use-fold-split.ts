import { useLayoutEffect, useRef, useState } from "react";
import { DESKTOP_MIN_WIDTH, resolveFoldReadingPane } from "@/components/fold-posture-utils";
import { useFoldViewport } from "@/components/use-fold-posture";
import { useReadingPaneMode } from "./use-reading-layout";

/**
 * How the list and the reader share the screen on a foldable device: the reading-pane mode after the fold
 * posture, and for a vertical hinge the width the list may take without crossing it.
 */
export function useFoldSplit() {
	const [preferredMode] = useReadingPaneMode();
	const fold = useFoldViewport();
	const mode = resolveFoldReadingPane(preferredMode, fold.posture, fold.width >= DESKTOP_MIN_WIDTH);
	const split = mode !== "none";
	// A vertical hinge gets its own space, and the list starts in the first screen instead of under the fold.
	const hinge = split && fold.posture === "unfolded" && fold.hinge?.orientation === "vertical" ? fold.hinge : null;
	const groupRef = useRef<HTMLDivElement | null>(null);
	const [groupLeft, setGroupLeft] = useState<number | null>(null);

	useLayoutEffect(() => {
		if (!hinge) return;
		const measure = () => setGroupLeft(groupRef.current?.getBoundingClientRect().left ?? 0);
		measure();
		// The group's width changes whenever its left edge can move: a sidebar drag, a window resize, the assistant.
		const observer = new ResizeObserver(measure);
		if (groupRef.current) observer.observe(groupRef.current);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [hinge]);

	// hinge.first is in viewport coordinates, but a panel's size is measured inside the group, whose left edge
	// the sidebar pushes right; the list gets only what is left of the first screen, so it cannot cross the hinge.
	const hingeListWidth = hinge && groupLeft !== null ? Math.max(0, hinge.first.width - groupLeft) : null;

	return { mode, split, below: mode === "below", hinge, groupRef, hingeListWidth };
}

/** The list's size limits, capped to the space before a hinge when there is one. */
export function foldListBounds(limits: { min: number; max: number }, hingeListWidth: number | null) {
	const max = hingeListWidth === null ? limits.max : Math.min(limits.max, hingeListWidth);
	return { min: Math.min(limits.min, max), max };
}

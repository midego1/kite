"use client";

import { useEffect, useSyncExternalStore } from "react";
import { APPEARANCE_CHANGED_EVENT, FOLD_LAYOUT_PREFERENCE, readAppearancePreference } from "./appearance-preferences";
import {
	COARSE_POINTER_QUERY,
	DESKTOP_MIN_WIDTH,
	FOLDED_VIEWPORT_QUERY,
	LEGACY_SCREEN_SPANNING_QUERY,
	VIEWPORT_SEGMENTS_QUERY,
	applyFoldPostureAttribute,
	foldHingeFromSegments,
	readFoldSegments,
	resolveBaseFoldPosture,
	resolveFoldPosture,
	type FoldPosture,
	type FoldViewport,
} from "./fold-posture-utils";

const QUERIES = [FOLDED_VIEWPORT_QUERY, COARSE_POINTER_QUERY, VIEWPORT_SEGMENTS_QUERY, LEGACY_SCREEN_SPANNING_QUERY];

const SERVER_VIEWPORT: FoldViewport = {
	posture: "desktop",
	basePosture: "desktop",
	override: "auto",
	width: DESKTOP_MIN_WIDTH,
	coarsePointer: false,
	segments: [],
	hinge: null,
};

let cachedViewport: FoldViewport | null = null;
let cachedKey = "";

function viewportSegments(): unknown {
	try {
		return (window as Window & { viewport?: { segments?: unknown } }).viewport?.segments;
	} catch {
		return undefined;
	}
}

function readFoldViewport(): FoldViewport {
	if (typeof window === "undefined") return SERVER_VIEWPORT;
	const width = window.innerWidth || document.documentElement.clientWidth || DESKTOP_MIN_WIDTH;
	const coarsePointer = window.matchMedia(COARSE_POINTER_QUERY).matches;
	const segmented = window.matchMedia(VIEWPORT_SEGMENTS_QUERY).matches;
	const legacySpanned = window.matchMedia(LEGACY_SCREEN_SPANNING_QUERY).matches;
	const segments = readFoldSegments(viewportSegments());
	const basePosture = resolveBaseFoldPosture({
		width,
		coarsePointer,
		segmented: segmented || segments.length > 1,
		legacySpanned,
	});
	const override = readAppearancePreference(FOLD_LAYOUT_PREFERENCE);
	const posture = resolveFoldPosture(basePosture, override);
	const hinge = posture === "unfolded" ? foldHingeFromSegments(segments) : null;
	const key = [
		posture,
		basePosture,
		override,
		width,
		coarsePointer,
		segmented,
		legacySpanned,
		segments.map((segment) => `${segment.left},${segment.top},${segment.width},${segment.height}`).join(";"),
		hinge ? `${hinge.orientation},${hinge.gap}` : "",
	].join("|");
	if (cachedViewport && key === cachedKey) return cachedViewport;
	cachedKey = key;
	cachedViewport = { posture, basePosture, override, width, coarsePointer, segments, hinge };
	return cachedViewport;
}

function subscribe(onChange: () => void) {
	const media = QUERIES.map((query) => window.matchMedia(query));
	for (const query of media) query.addEventListener("change", onChange);
	window.addEventListener("resize", onChange);
	window.addEventListener("orientationchange", onChange);
	window.addEventListener("storage", onChange);
	window.addEventListener(APPEARANCE_CHANGED_EVENT, onChange);
	type SegmentTarget = {
		addEventListener?: (type: string, listener: () => void) => void;
		removeEventListener?: (type: string, listener: () => void) => void;
	};
	let viewport: SegmentTarget | undefined;
	try {
		viewport = (window as Window & { viewport?: SegmentTarget }).viewport;
		viewport?.addEventListener?.("change", onChange);
	} catch {
		viewport = undefined;
	}
	return () => {
		for (const query of media) query.removeEventListener("change", onChange);
		window.removeEventListener("resize", onChange);
		window.removeEventListener("orientationchange", onChange);
		window.removeEventListener("storage", onChange);
		window.removeEventListener(APPEARANCE_CHANGED_EVENT, onChange);
		try {
			viewport?.removeEventListener?.("change", onChange);
		} catch {}
	};
}

/** Live fold posture: folded (phone shell), unfolded (tablet, two panes) or desktop. */
export function useFoldViewport(): FoldViewport {
	const viewport = useSyncExternalStore(subscribe, readFoldViewport, () => SERVER_VIEWPORT);
	useEffect(() => {
		applyFoldPostureAttribute(viewport.posture);
	}, [viewport.posture]);
	return viewport;
}

export function useFoldPosture(): FoldPosture {
	return useFoldViewport().posture;
}

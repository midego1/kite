"use client";

import { useEffect, useSyncExternalStore } from "react";
import { APPEARANCE_CHANGED_EVENT, FOLD_LAYOUT_PREFERENCE, readAppearancePreference } from "./appearance-preferences";
import {
	COARSE_POINTER_QUERY,
	FOLDED_VIEWPORT_QUERY,
	LEGACY_SCREEN_SPANNING_QUERY,
	SHORT_VIEWPORT_QUERY,
	TABLET_VIEWPORT_QUERY,
	VIEWPORT_SEGMENTS_QUERY,
	WIDE_VIEWPORT_QUERY,
	applyFoldPostureAttribute,
	foldHingeFromSegments,
	readFoldSegments,
	resolveBaseFoldPosture,
	resolveFoldPosture,
	type FoldPosture,
	type FoldViewport,
} from "./fold-posture-utils";

// Every viewport threshold the posture depends on is a media query, so a resize only reaches React when one flips.
const QUERIES = [
	FOLDED_VIEWPORT_QUERY,
	WIDE_VIEWPORT_QUERY,
	TABLET_VIEWPORT_QUERY,
	SHORT_VIEWPORT_QUERY,
	COARSE_POINTER_QUERY,
	VIEWPORT_SEGMENTS_QUERY,
	LEGACY_SCREEN_SPANNING_QUERY,
];

const SERVER_WIDTH = 1024;
const SERVER_HEIGHT = 501;

const SERVER_VIEWPORT: FoldViewport = {
	posture: "desktop",
	basePosture: "desktop",
	override: "auto",
	wide: true,
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
	const width = window.innerWidth || document.documentElement.clientWidth;
	const height = window.innerHeight || document.documentElement.clientHeight;
	const match = (query: string) => window.matchMedia(query).matches;
	const coarsePointer = match(COARSE_POINTER_QUERY);
	const segmented = match(VIEWPORT_SEGMENTS_QUERY);
	const legacySpanned = match(LEGACY_SCREEN_SPANNING_QUERY);
	const segments = readFoldSegments(viewportSegments());
	const basePosture = resolveBaseFoldPosture({
		width: width || SERVER_WIDTH,
		height: height || SERVER_HEIGHT,
		coarsePointer,
		segmented: segmented || segments.length > 1,
		legacySpanned,
	});
	const override = readAppearancePreference(FOLD_LAYOUT_PREFERENCE);
	const posture = resolveFoldPosture(basePosture, override);
	const hinge = posture === "unfolded" ? foldHingeFromSegments(segments) : null;
	const wide = match(WIDE_VIEWPORT_QUERY);
	const key = [
		posture,
		basePosture,
		override,
		wide,
		coarsePointer,
		segmented,
		legacySpanned,
		segments.map((segment) => `${segment.left},${segment.top},${segment.width},${segment.height}`).join(";"),
		hinge ? `${hinge.orientation},${hinge.gap}` : "",
	].join("|");
	if (cachedViewport && key === cachedKey) return cachedViewport;
	cachedKey = key;
	cachedViewport = { posture, basePosture, override, wide, coarsePointer, segments, hinge };
	return cachedViewport;
}

/** The last viewport read; it only changes in an event handler, so a render never touches the browser. */
function currentFoldViewport(): FoldViewport {
	return cachedViewport ?? readFoldViewport();
}

function subscribe(notify: () => void) {
	const onChange = () => {
		readFoldViewport();
		notify();
	};
	// A hook that mounts after the browser changed has no event to learn it from.
	readFoldViewport();
	const media = QUERIES.map((query) => window.matchMedia(query));
	for (const query of media) query.addEventListener("change", onChange);
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
	return useSyncExternalStore(subscribe, currentFoldViewport, () => SERVER_VIEWPORT);
}

/** Keeps `<html data-fold-posture>` on the effective posture; the head script sets it before the first paint. */
export function useFoldPostureAttribute(): void {
	const posture = useSyncExternalStore(
		subscribe,
		() => currentFoldViewport().posture,
		(): FoldPosture => SERVER_VIEWPORT.posture,
	);
	useEffect(() => {
		// The hydration render still shows the server's "desktop"; the attribute follows the browser's own reading.
		applyFoldPostureAttribute(currentFoldViewport().posture);
	}, [posture]);
}

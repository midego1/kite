export type FoldPosture = "folded" | "unfolded" | "desktop";
export type FoldLayoutPreference = "auto" | "single" | "two";

export const FOLD_LAYOUT_STORAGE_KEY = "kite-fold-layout";
export const FOLD_POSTURE_ATTRIBUTE = "fold-posture";

/** A cover screen is narrow enough for one pane; at about 700 px a small tablet or an unfolded foldable starts. */
export const FOLDED_MAX_WIDTH = 700;
export const FOLDED_VIEWPORT_QUERY = `(max-width: ${FOLDED_MAX_WIDTH}px)`;
/** Tailwind's `md` breakpoint, where the app has always switched from its phone shell to the sidebar. */
export const PHONE_SHELL_MAX_WIDTH = 767;
export const PHONE_SHELL_VIEWPORT_QUERY = `(max-width: ${PHONE_SHELL_MAX_WIDTH}px)`;
/** Tailwind's `lg` breakpoint, where the desktop reading pane has always started. */
export const DESKTOP_MIN_WIDTH = 1024;
/** A touch device as wide as this is usually a tablet or an unfolded foldable, not a desktop. */
export const UNFOLDED_MAX_WIDTH = 1100;

export const COARSE_POINTER_QUERY = "(pointer: coarse)";
export const VIEWPORT_SEGMENTS_QUERY = "(horizontal-viewport-segments: 2)";
export const LEGACY_SCREEN_SPANNING_QUERY = "(screen-spanning: single-fold-vertical)";

export interface FoldSegment {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface FoldHinge {
	orientation: "vertical" | "horizontal";
	/** The space between the two screens that content should not cross. */
	gap: number;
	/** The first screen, in viewport coordinates. */
	first: FoldSegment;
	/** The second screen, in viewport coordinates. */
	second: FoldSegment;
}

export interface FoldViewport {
	/** The posture after the per-browser override, used for the panes and `data-fold-posture`. */
	posture: FoldPosture;
	/** What the device and the viewport say, before the override. */
	basePosture: FoldPosture;
	override: FoldLayoutPreference;
	width: number;
	coarsePointer: boolean;
	segments: FoldSegment[];
	hinge: FoldHinge | null;
}

export function isFoldLayoutPreference(value: unknown): value is FoldLayoutPreference {
	return value === "auto" || value === "single" || value === "two";
}

/** The posture from the viewport alone; a narrow screen is folded however the preference is set. */
export function resolveBaseFoldPosture(input: {
	width: number;
	coarsePointer: boolean;
	segmented: boolean;
	legacySpanned: boolean;
}): FoldPosture {
	if (input.width <= FOLDED_MAX_WIDTH) return "folded";
	if (input.segmented || input.legacySpanned) return "unfolded";
	if (input.coarsePointer && input.width < UNFOLDED_MAX_WIDTH) return "unfolded";
	if (input.width < DESKTOP_MIN_WIDTH) return "unfolded";
	return "desktop";
}

export function resolveFoldPosture(base: FoldPosture, override: FoldLayoutPreference): FoldPosture {
	if (override === "single") return "folded";
	if (override === "two") return "unfolded";
	return base;
}

/**
 * The list/reader split for a posture. Desktop keeps the user's reading-pane choice exactly as before; a
 * folded screen always shows one pane, and an unfolded one shows the list and reader side by side.
 */
export function resolveFoldReadingPane(
	preference: "none" | "right" | "below",
	posture: FoldPosture,
	desktopWide: boolean,
): "none" | "right" | "below" {
	if (posture === "folded") return "none";
	if (posture === "unfolded") return "right";
	return desktopWide ? preference : "none";
}

function validSegment(value: unknown): value is FoldSegment {
	if (!value || typeof value !== "object") return false;
	const segment = value as Record<string, unknown>;
	return ["left", "top", "width", "height"].every(
		(key) => typeof segment[key] === "number" && Number.isFinite(segment[key]),
	);
}

/** Normalises `window.viewport.segments` (or an empty list when the browser has no Viewport Segments API). */
export function readFoldSegments(value: unknown): FoldSegment[] {
	if (!Array.isArray(value)) return [];
	return value.filter(validSegment).map(({ left, top, width, height }) => ({ left, top, width, height }));
}

/** The hinge between two side-by-side or stacked viewport segments, if they report one. */
export function foldHingeFromSegments(segments: FoldSegment[]): FoldHinge | null {
	const ordered = [...segments]
		.filter((segment) => segment.width > 0 && segment.height > 0)
		.sort((a, b) => a.left - b.left || a.top - b.top);
	if (ordered.length < 2) return null;
	for (let index = 0; index < ordered.length - 1; index += 1) {
		const first = ordered[index];
		const second = ordered[index + 1];
		if (Math.abs(first.top - second.top) <= 1 && second.left >= first.left + first.width - 1) {
			return {
				orientation: "vertical",
				gap: Math.max(0, second.left - (first.left + first.width)),
				first,
				second,
			};
		}
		if (Math.abs(first.left - second.left) <= 1 && second.top >= first.top + first.height - 1) {
			return {
				orientation: "horizontal",
				gap: Math.max(0, second.top - (first.top + first.height)),
				first,
				second,
			};
		}
	}
	return null;
}

export function applyFoldPostureAttribute(posture: FoldPosture): void {
	if (typeof document === "undefined") return;
	document.documentElement.setAttribute(`data-${FOLD_POSTURE_ATTRIBUTE}`, posture);
}

/**
 * Sets the effective posture before paint, so the first frame already has the right shell. The hook keeps
 * it up to date afterwards (`use-fold-posture.ts`).
 */
export const foldPostureBootstrapScript = `(() => {
	try {
		const width = window.innerWidth || document.documentElement.clientWidth || ${DESKTOP_MIN_WIDTH};
		const match = (query) => {
			try {
				return window.matchMedia(query).matches;
			} catch {
				return false;
			}
		};
		let segments = [];
		try {
			segments = Array.isArray(window.viewport?.segments) ? window.viewport.segments : [];
		} catch {}
		const segmented = segments.length > 1 || match(${JSON.stringify(VIEWPORT_SEGMENTS_QUERY)});
		const legacySpanned = match(${JSON.stringify(LEGACY_SCREEN_SPANNING_QUERY)});
		const coarsePointer = match(${JSON.stringify(COARSE_POINTER_QUERY)});
		const base =
			width <= ${FOLDED_MAX_WIDTH}
				? "folded"
				: segmented || legacySpanned || (coarsePointer && width < ${UNFOLDED_MAX_WIDTH}) || width < ${DESKTOP_MIN_WIDTH}
					? "unfolded"
					: "desktop";
		const saved = localStorage.getItem(${JSON.stringify(FOLD_LAYOUT_STORAGE_KEY)});
		const posture = saved === "single" ? "folded" : saved === "two" ? "unfolded" : base;
		document.documentElement.setAttribute(${JSON.stringify("data-" + FOLD_POSTURE_ATTRIBUTE)}, posture);
	} catch {}
})();`;

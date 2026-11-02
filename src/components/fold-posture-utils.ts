export type FoldPosture = "folded" | "unfolded" | "desktop";
export type FoldLayoutPreference = "auto" | "single" | "two";

export const FOLD_LAYOUT_STORAGE_KEY = "kite-fold-layout";
const FOLD_POSTURE_ATTRIBUTE = "fold-posture";

/** A cover screen is narrow enough for one pane; at about 700 px a small tablet or an unfolded foldable starts. */
const FOLDED_MAX_WIDTH = 700;
export const FOLDED_VIEWPORT_QUERY = `(max-width: ${FOLDED_MAX_WIDTH}px)`;
/** Tailwind's `md` breakpoint, where the app has always switched from its phone shell to the sidebar. */
const PHONE_SHELL_MAX_WIDTH = 767;
export const PHONE_SHELL_VIEWPORT_QUERY = `(max-width: ${PHONE_SHELL_MAX_WIDTH}px)`;
/** Tailwind's `lg` breakpoint, where the desktop reading pane has always started. */
const DESKTOP_MIN_WIDTH = 1024;
/** A touch device as wide as this is usually a tablet or an unfolded foldable, not a desktop. */
const UNFOLDED_MAX_WIDTH = 1100;
/** A touch screen this short is a phone held sideways, which is too low for two panes. */
const SHORT_MAX_HEIGHT = 500;

/** The viewport thresholds the posture depends on; the hook only recomputes when one of these flips. */
export const WIDE_VIEWPORT_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;
export const TABLET_VIEWPORT_QUERY = `(max-width: ${UNFOLDED_MAX_WIDTH - 1}px)`;
export const SHORT_VIEWPORT_QUERY = `(max-height: ${SHORT_MAX_HEIGHT}px)`;
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
	/** At least the desktop width, where the reading-pane preference applies on a desktop. */
	wide: boolean;
	coarsePointer: boolean;
	segments: FoldSegment[];
	hinge: FoldHinge | null;
}

/** The posture from the device and the viewport; the per-browser override is applied on top of it. */
export function resolveBaseFoldPosture(input: {
	width: number;
	height: number;
	coarsePointer: boolean;
	segmented: boolean;
	legacySpanned: boolean;
}): FoldPosture {
	if (input.width <= FOLDED_MAX_WIDTH) return "folded";
	if (input.segmented || input.legacySpanned) return "unfolded";
	if (input.coarsePointer && input.height <= SHORT_MAX_HEIGHT) return "folded";
	if (input.coarsePointer && input.width < UNFOLDED_MAX_WIDTH) return "unfolded";
	return "desktop";
}

export function resolveFoldPosture(base: FoldPosture, override: FoldLayoutPreference): FoldPosture {
	if (override === "single") return "folded";
	if (override === "two") return "unfolded";
	return base;
}

/**
 * The list/reader split for a posture. A folded screen shows one pane. An unfolded one keeps the user's
 * reading-pane choice, except that "Always two panes" never ends up with a single pane. Desktop keeps the
 * choice exactly as before, and only from the desktop width up.
 */
export function resolveFoldReadingPane(
	preference: "none" | "right" | "below",
	posture: FoldPosture,
	wide: boolean,
	override: FoldLayoutPreference = "auto",
): "none" | "right" | "below" {
	if (posture === "folded") return "none";
	if (posture === "unfolded") return override === "two" && preference === "none" ? "right" : preference;
	return wide ? preference : "none";
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
		const height = window.innerHeight || document.documentElement.clientHeight || ${SHORT_MAX_HEIGHT + 1};
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
				: segmented || legacySpanned
					? "unfolded"
					: coarsePointer && height <= ${SHORT_MAX_HEIGHT}
						? "folded"
						: coarsePointer && width < ${UNFOLDED_MAX_WIDTH}
							? "unfolded"
							: "desktop";
		let saved = null;
		try {
			saved = localStorage.getItem(${JSON.stringify(FOLD_LAYOUT_STORAGE_KEY)});
		} catch {}
		const posture = saved === "single" ? "folded" : saved === "two" ? "unfolded" : base;
		document.documentElement.setAttribute(${JSON.stringify("data-" + FOLD_POSTURE_ATTRIBUTE)}, posture);
	} catch {}
})();`;

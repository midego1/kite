import type { AppliedNoticeExit, DismissTimer, DismissTimerClock, DismissTimerOptions } from "./applied-notice-types";

/** How long the "Database updated" notice stays readable before it leaves on its own. */
export const APPLIED_NOTICE_STAY_MS = 8_000;
/** After a hover or focus ends, the notice stays at least this long, so it never vanishes under a leaving pointer. */
const APPLIED_NOTICE_RESUME_MIN_MS = 2_000;
/**
 * The kite's flight out of the notice. The `applied-notice-*` animations in globals.css take their length from the
 * `--applied-notice-duration` the notice sets from the exit plan (`appliedNoticeExitStyle`), so this is the only copy.
 */
const APPLIED_NOTICE_FLIGHT_MS = 1_200;
/** The plain fade under reduced motion. */
const APPLIED_NOTICE_FADE_MS = 250;
/** The notice is removed by this timer even if `animationend` never comes (animations disabled, a hidden tab). */
const FALLBACK_SLACK_MS = 400;
const FLIGHT_KEYFRAMES = "applied-notice-kite";
const FADE_KEYFRAMES = "applied-notice-fade";

/**
 * A countdown that can be held by several reasons at once (the pointer, the keyboard focus, a hidden tab) and
 * resumes with the remaining time once every hold is gone. Timers are injected so the countdown is testable.
 */
export function createDismissTimer(
	{ stayMs, resumeMinMs = APPLIED_NOTICE_RESUME_MIN_MS, onElapsed }: DismissTimerOptions,
	clock: DismissTimerClock,
): DismissTimer {
	const holds = new Set<string>();
	let remaining = stayMs;
	let startedAt: number | null = null;
	let handle: unknown = null;
	let done = false;

	const stop = () => {
		if (handle !== null) clock.clearTimeout(handle);
		handle = null;
		if (startedAt !== null) remaining = Math.max(0, remaining - (clock.now() - startedAt));
		startedAt = null;
	};
	const start = () => {
		if (done || holds.size > 0 || startedAt !== null) return;
		startedAt = clock.now();
		handle = clock.setTimeout(() => {
			handle = null;
			startedAt = null;
			done = true;
			onElapsed();
		}, remaining);
	};

	start();
	return {
		hold(reason) {
			if (done) return;
			holds.add(reason);
			stop();
		},
		release(reason) {
			if (!holds.delete(reason) || done || holds.size > 0) return;
			remaining = Math.max(remaining, resumeMinMs);
			start();
		},
		cancel() {
			done = true;
			stop();
		},
		remainingMs() {
			return startedAt === null ? remaining : Math.max(0, remaining - (clock.now() - startedAt));
		},
		holding() {
			return holds.size > 0;
		},
	};
}

/** With reduced motion the notice fades without the kite; otherwise it folds away while the kite flies off. */
export function planAppliedNoticeExit(reducedMotion: boolean): AppliedNoticeExit {
	if (reducedMotion)
		return { kite: false, durationMs: APPLIED_NOTICE_FADE_MS, fallbackMs: APPLIED_NOTICE_FADE_MS + FALLBACK_SLACK_MS };
	return { kite: true, durationMs: APPLIED_NOTICE_FLIGHT_MS, fallbackMs: APPLIED_NOTICE_FLIGHT_MS + FALLBACK_SLACK_MS };
}

/** The CSS custom property that times the exit animations, set on the notice and on the kite. */
const APPLIED_NOTICE_DURATION_PROPERTY = "--applied-notice-duration";

/** The inline style that gives the exit animations their length. */
export function appliedNoticeExitStyle(exit: AppliedNoticeExit): Record<string, string> {
	return { [APPLIED_NOTICE_DURATION_PROPERTY]: `${exit.durationMs}ms` };
}

/**
 * Whether a blur ends the keyboard focus hold: only when the focus moved somewhere outside the notice. Switching to
 * another window (or app) blurs the focused button without a next target while the document itself loses the
 * focus; the browser gives the focus back to the button on return, so the notice keeps waiting meanwhile.
 */
export function blurEndsFocusHold({
	nextInside,
	documentFocused,
}: {
	nextInside: boolean;
	documentFocused: boolean;
}): boolean {
	return !nextInside && documentFocused;
}

/**
 * Where the keyboard focus goes when the notice leaves while holding it: the first focusable element after the
 * notice in document order, else the last one before it, else nowhere (null).
 */
export function pickFocusNeighbour<T>(
	candidates: readonly T[],
	place: (candidate: T) => "before" | "inside" | "after",
): T | null {
	let before: T | null = null;
	for (const candidate of candidates) {
		const where = place(candidate);
		if (where === "after") return candidate;
		if (where === "before") before = candidate;
	}
	return before;
}

/** Only the kite's own animation (or the fade without it) ends the exit; the box's fold and the tail bubble past. */
export function isAppliedNoticeExitEnd(animationName: string, exit: AppliedNoticeExit): boolean {
	return animationName === (exit.kite ? FLIGHT_KEYFRAMES : FADE_KEYFRAMES);
}

import type { AppliedNoticeExit, DismissTimer, DismissTimerClock, DismissTimerOptions } from "./applied-notice-types";

/** How long the "Database updated" notice stays readable before it leaves on its own. */
export const APPLIED_NOTICE_STAY_MS = 8_000;
/** After a hover or focus ends, the notice stays at least this long, so it never vanishes under a leaving pointer. */
export const APPLIED_NOTICE_RESUME_MIN_MS = 2_000;
/** The kite's flight out of the notice, matched by the `applied-notice-*` keyframes in globals.css. */
export const APPLIED_NOTICE_FLIGHT_MS = 1_200;
/** The plain fade under reduced motion. */
export const APPLIED_NOTICE_FADE_MS = 250;
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

/** Only the kite's own animation (or the fade without it) ends the exit; the box's fold and the tail bubble past. */
export function isAppliedNoticeExitEnd(animationName: string, exit: AppliedNoticeExit): boolean {
	return animationName === (exit.kite ? FLIGHT_KEYFRAMES : FADE_KEYFRAMES);
}

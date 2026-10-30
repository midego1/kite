import type { ReloadFlightInput, ReloadFlightPlan } from "./reload-flight-types";

/** The kite's flight out of view, matched by the `reload-flight-*` keyframes in globals.css. */
const RELOAD_FLIGHT_DURATION_MS = 850;
/** The reload is never held hostage by the animation: this timer fires it even if `animationend` never comes. */
const RELOAD_FLIGHT_FALLBACK_MS = 1_200;
export const RELOAD_FLIGHT_ANNOUNCEMENT = "Reloading…";
const RELOAD_FLIGHT_KEYFRAMES = "reload-flight-kite";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Reads the reduced-motion preference; a browser without `matchMedia` (or one that throws) counts as no preference. */
export function prefersReducedMotion(matchMedia: ((query: string) => { matches: boolean }) | undefined): boolean {
	if (typeof matchMedia !== "function") return false;
	try {
		return matchMedia(REDUCED_MOTION_QUERY).matches;
	} catch {
		return false;
	}
}

/** Reduced motion skips the flight and reloads at once; otherwise the reload follows the flight, with a fallback timer. */
export function planReloadFlight({ reducedMotion }: ReloadFlightInput): ReloadFlightPlan {
	if (reducedMotion) return { animate: false, durationMs: 0, fallbackMs: 0 };
	return { animate: true, durationMs: RELOAD_FLIGHT_DURATION_MS, fallbackMs: RELOAD_FLIGHT_FALLBACK_MS };
}

/** The animation's end and the fallback timer both ask for the reload; only the first call does anything. */
export function once(action: () => void): () => void {
	let done = false;
	return () => {
		if (done) return;
		done = true;
		action();
	};
}

/** Only the kite's own animation ends the flight; the tail's and the fade's `animationend` bubble past it. */
export function isFlightEnd(animationName: string): boolean {
	return animationName === RELOAD_FLIGHT_KEYFRAMES;
}

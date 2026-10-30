export interface ReloadFlightInput {
	/** The browser asked for reduced motion: the page reloads at once, without the flight. */
	reducedMotion: boolean;
}

export interface ReloadFlightPlan {
	animate: boolean;
	/** How long the flight lasts; the reload follows its last frame. */
	durationMs: number;
	/** The reload fires at this point even when the animation never reports its end. */
	fallbackMs: number;
}

export interface ReloadFlightProps {
	/** Set when the user asked for the new version; the flight starts and the page reloads after it. */
	active: boolean;
	/** Replaces `window.location.reload()`; it is called exactly once. */
	onReload?: () => void;
}

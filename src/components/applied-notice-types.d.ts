export interface DismissTimerClock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface DismissTimerOptions {
	stayMs: number;
	/** The least time left after a hold ends. */
	resumeMinMs?: number;
	onElapsed(): void;
}

export interface DismissTimer {
	/** Pauses the countdown for a reason; the same reason counts once. */
	hold(reason: string): void;
	/** Ends a hold; the countdown resumes once no reason is left. */
	release(reason: string): void;
	cancel(): void;
	remainingMs(): number;
	holding(): boolean;
}

export interface AppliedNoticeExit {
	/** Whether the kite flies off; false under reduced motion. */
	kite: boolean;
	durationMs: number;
	/** Removes the notice even if `animationend` never comes. */
	fallbackMs: number;
}

/** Where the notice was when it left, so the kite lifts off from its corner wherever the notice is clipped. */
export interface AppliedNoticeOrigin {
	top: number;
	right: number;
}

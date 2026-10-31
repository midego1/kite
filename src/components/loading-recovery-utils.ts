/** How much visible time after the startup screen first mounted it offers "Reload Kite". */
const LOADING_RECOVERY_AFTER_MS = 15_000;

/**
 * Visible time since the startup screen first mounted: `visibleMs` counted so far, plus the time since
 * `visibleSince` while the page is visible (null while hidden). A tab opened in the background does not count.
 */
export type VisibleClock = { visibleMs: number; visibleSince: number | null };

export function startVisibleClock(now: number, visible: boolean): VisibleClock {
	return { visibleMs: 0, visibleSince: visible ? now : null };
}

/** The clock at `now` (`performance.now()`), going on as `visible` from there. */
export function tickVisibleClock(clock: VisibleClock, now: number, visible: boolean): VisibleClock {
	const since = clock.visibleSince;
	const visibleMs =
		since === null || !Number.isFinite(now) ? clock.visibleMs : clock.visibleMs + Math.max(0, now - since);
	return { visibleMs, visibleSince: visible && Number.isFinite(now) ? now : null };
}

/** The wait before the offer, given the visible time since the startup screen first mounted. */
export function loadingRecoveryDelay(visibleMs: number): number {
	if (!Number.isFinite(visibleMs)) return LOADING_RECOVERY_AFTER_MS;
	return Math.max(0, LOADING_RECOVERY_AFTER_MS - visibleMs);
}

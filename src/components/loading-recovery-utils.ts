/** How long after the page started the startup screen offers "Reload Kite". */
const LOADING_RECOVERY_AFTER_MS = 15_000;

/** The wait before the offer, given the time since the page started (`performance.now()`). */
export function loadingRecoveryDelay(sincePageStartMs: number): number {
	if (!Number.isFinite(sincePageStartMs)) return LOADING_RECOVERY_AFTER_MS;
	return Math.max(0, LOADING_RECOVERY_AFTER_MS - sincePageStartMs);
}

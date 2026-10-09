/** setTimeout fires immediately for delays above this, so longer waits are re-armed. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RETRY_DELAY_MS = 10_000;

export function getQueueRetryDelayMs(): number {
	return RETRY_DELAY_MS;
}

/** `attempts` counts retries already made, so the first failure is attempt 0. */
export function shouldRetryQueueMessage(attempts: number, maxRetries: number): boolean {
	return attempts < maxRetries;
}

/** How long to sleep until the next stored message is due, or null when none is waiting. */
export function getQueueWakeDelayMs(nextAvailableAt: number | null, now: number): number | null {
	if (nextAvailableAt === null || !Number.isFinite(nextAvailableAt)) return null;
	return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextAvailableAt - now));
}

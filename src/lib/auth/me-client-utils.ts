/** The first `/api/auth/me` attempt gives up after this long; a cold isolate right after a deploy can be slow. */
export const AUTH_ME_TIMEOUT_MS = 6_000;
/** Each retry gives up sooner, so a check that keeps hanging reaches AuthGuard's error state quickly. */
const AUTH_ME_RETRY_TIMEOUT_MS = 4_000;
/** Waits before each retry of a failed session check; their count is the most retries. */
const AUTH_ME_RETRY_DELAYS_MS = [1_000, 2_000] as const;
/** A timed-out check is retried this often: 6 + 1 + 4 = 11 seconds before the error state. */
const AUTH_ME_TIMEOUT_RETRIES = 1;

/**
 * Whether a failed session check is worth repeating: timeouts, network failures and server errors are, a 4xx
 * answer is not (401 never gets here, fetchAuthMe turns it into "signed out").
 */
function isRetryableAuthMeError(error: unknown): boolean {
	const status = (error as { status?: unknown } | null)?.status;
	if (typeof status === "number") return status >= 500 || status === 408 || status === 429;
	return true;
}

function isTimeout(error: unknown): boolean {
	return (error as { name?: unknown } | null)?.name === "TimeoutError";
}

/** The timeout of the next attempt, given how many attempts of this fetch have failed. */
export function authMeTimeoutMs(failuresSoFar: number): number {
	return failuresSoFar > 0 ? AUTH_ME_RETRY_TIMEOUT_MS : AUTH_ME_TIMEOUT_MS;
}

/** React Query `retry`: `retriesSoFar` is 0 when the first attempt fails. */
export function shouldRetryAuthMe(retriesSoFar: number, error: unknown): boolean {
	if (!isRetryableAuthMeError(error)) return false;
	return retriesSoFar < (isTimeout(error) ? AUTH_ME_TIMEOUT_RETRIES : AUTH_ME_RETRY_DELAYS_MS.length);
}

/** React Query `retryDelay`: called with the same count as `shouldRetryAuthMe`. */
export function authMeRetryDelay(retriesSoFar: number): number {
	const index = Math.min(Math.max(retriesSoFar, 0), AUTH_ME_RETRY_DELAYS_MS.length - 1);
	return AUTH_ME_RETRY_DELAYS_MS[index];
}

/** @public Exercised by the unit tests. Failed sign-ins to a server the user names, per user, in `SIGN_IN_WINDOW_MS` (spec §11.2). */
export const SIGN_IN_FAILURES_PER_USER = 10;
/** @public Exercised by the unit tests. The same window for one user and one server (host and port), so one provider cannot be hammered. */
export const SIGN_IN_FAILURES_PER_SERVER = 5;
export const SIGN_IN_WINDOW_MS = 10 * 60_000;
/** The most rows one check reads: a burst of parallel attempts cannot make it grow without bound. */
export const SIGN_IN_ROWS_READ = 200;

/** The audit action of an attempt; rows of attempts that signed in are deleted, so the rest are failures. */
export const SIGN_IN_ATTEMPT_ACTION = "import.sign_in_attempt";

/** One attempt in the window: when it started and the server it named (`signInServerKey`). */
export type SignInAttemptRow = { at: number; server: string | null };

export type SignInVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** `host:port` in lower case, without a trailing dot, which is how attempts at one server are grouped. */
export function signInServerKey(host: string, port: number): string {
	return `${host.trim().toLowerCase().replace(/\.$/, "")}:${port}`;
}

/** Seconds until enough of `times` (ascending) have left the window for the count to be back at `limit`. */
function secondsUntilRoom(times: readonly number[], limit: number, now: number): number {
	// The refused attempt's own row is deleted, so only the others have to expire: the (n − limit)th oldest.
	const expiring = times[times.length - limit - 1];
	return Math.max(1, Math.ceil((expiring + SIGN_IN_WINDOW_MS - now) / 1000));
}

/**
 * Whether an attempt may go on, given every attempt still in the window **including its own** (it is written before the
 * count is read, so parallel attempts can never all see room: the n-th row written always counts at least n). Rows
 * older than the window are ignored. When it may not, the wait is until the oldest failures that matter have expired.
 */
export function evaluateSignInAttempts(rows: readonly SignInAttemptRow[], server: string, now: number): SignInVerdict {
	const since = now - SIGN_IN_WINDOW_MS;
	const user = rows
		.filter((row) => row.at > since)
		.map((row) => row.at)
		.sort((a, b) => a - b);
	const sameServer = rows
		.filter((row) => row.at > since && row.server === server)
		.map((row) => row.at)
		.sort((a, b) => a - b);
	const waits: number[] = [];
	if (user.length > SIGN_IN_FAILURES_PER_USER) waits.push(secondsUntilRoom(user, SIGN_IN_FAILURES_PER_USER, now));
	if (sameServer.length > SIGN_IN_FAILURES_PER_SERVER)
		waits.push(secondsUntilRoom(sameServer, SIGN_IN_FAILURES_PER_SERVER, now));
	return waits.length ? { allowed: false, retryAfterSeconds: Math.max(...waits) } : { allowed: true };
}

/** The refusal's text: how long to wait, in plain words. */
export function signInLimitMessage(retryAfterSeconds: number): string {
	const minutes = Math.ceil(retryAfterSeconds / 60);
	const wait = minutes <= 1 ? "a minute" : `${minutes} minutes`;
	return `Too many failed sign-ins to mail servers. Check the user name and password, then try again in ${wait}.`;
}

/**
 * Whether the server itself refused the login (as opposed to a connection that was cut). An aborted request that
 * already met this refusal stays a failed sign-in, so aborting cannot erase a wrong password from the count.
 */
export function isAuthRefusal(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return /sign-in failed|AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|invalid credentials|LOGIN failed/i.test(message);
}

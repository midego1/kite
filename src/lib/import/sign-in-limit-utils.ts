/** @public Exercised by the unit tests. Failed sign-ins to a server the user names, per user, in `SIGN_IN_WINDOW_MS` (spec §11.2). */
export const SIGN_IN_FAILURES_PER_USER = 10;
/** @public Exercised by the unit tests. The same window for one user and one server (host and port), so one provider cannot be hammered. */
export const SIGN_IN_FAILURES_PER_SERVER = 5;
/**
 * Cancelled sign-ins per user, and per user and server, in the same window. They are not failures (the page walks
 * away from a size step all the time), but a cancel can come after the credentials reached the server, so they are
 * bounded too: the server limit keeps cancelling from reaching one provider more often than failing would.
 */
const SIGN_IN_ABORTS_PER_USER = 15;
const SIGN_IN_ABORTS_PER_SERVER = 8;
export const SIGN_IN_WINDOW_MS = 10 * 60_000;
/** The most rows one check reads: a burst of parallel attempts cannot make it grow without bound. */
export const SIGN_IN_ROWS_READ = 200;

/** The audit action of an attempt; rows of attempts that signed in are deleted, so the rest are failures. */
export const SIGN_IN_ATTEMPT_ACTION = "import.sign_in_attempt";

/** One attempt in the window: when it started and the server it named (`signInServerKey`). */
export type SignInAttemptRow = { at: number; server: string | null; aborted?: boolean };

/** Why a sign-in is refused: too many failures (check the password), or too many cancelled attempts. */
export type SignInLimitReason = "failures" | "cancels";

export type SignInVerdict =
	{ allowed: true } | { allowed: false; retryAfterSeconds: number; reason: SignInLimitReason };

/** `host:port` in lower case, without a trailing dot, which is how attempts at one server are grouped. */
export function signInServerKey(host: string, port: number): string {
	return `${host.trim().toLowerCase().replace(/\.$/, "")}:${port}`;
}

/**
 * Seconds until `times` (ascending) is short enough to admit one more: at most `room` entries may remain, so the
 * (length − room)th oldest has to leave the window.
 */
function secondsUntilRoom(times: readonly number[], room: number, now: number): number {
	const expiring = times[times.length - room - 1];
	return Math.max(1, Math.ceil((expiring + SIGN_IN_WINDOW_MS - now) / 1000));
}

const oldestFirst = (rows: readonly SignInAttemptRow[]) => rows.map((row) => row.at).sort((a, b) => a - b);

/**
 * Whether an attempt may go on, given every attempt still in the window **including its own** (it is written before the
 * count is read, so parallel attempts can never all see room: the n-th row written always counts at least n). Rows
 * older than the window are ignored. Failures (and attempts in flight) are limited per user and per server; cancelled
 * attempts, which are marked once they end, are limited per user and per server too, counting the attempt being
 * checked as one that may still be cancelled (its own row is not marked yet). When it may not go on, the wait is until
 * the oldest rows that matter have expired.
 */
export function evaluateSignInAttempts(rows: readonly SignInAttemptRow[], server: string, now: number): SignInVerdict {
	const since = now - SIGN_IN_WINDOW_MS;
	const inWindow = rows.filter((row) => row.at > since);
	const failures = inWindow.filter((row) => !row.aborted);
	const cancels = inWindow.filter((row) => row.aborted);
	const failureWaits: number[] = [];
	const cancelWaits: number[] = [];
	const limit = (list: readonly SignInAttemptRow[], max: number, waits: number[], includeOwn: boolean) => {
		const times = oldestFirst(list);
		// A failure count includes the attempt's own row; a cancel count does not, so one more is allowed for.
		const room = includeOwn ? max : max - 1;
		if (times.length > room) waits.push(secondsUntilRoom(times, room, now));
	};
	limit(failures, SIGN_IN_FAILURES_PER_USER, failureWaits, true);
	limit(
		failures.filter((row) => row.server === server),
		SIGN_IN_FAILURES_PER_SERVER,
		failureWaits,
		true,
	);
	limit(cancels, SIGN_IN_ABORTS_PER_USER, cancelWaits, false);
	limit(
		cancels.filter((row) => row.server === server),
		SIGN_IN_ABORTS_PER_SERVER,
		cancelWaits,
		false,
	);
	if (failureWaits.length) return { allowed: false, retryAfterSeconds: Math.max(...failureWaits), reason: "failures" };
	if (cancelWaits.length) return { allowed: false, retryAfterSeconds: Math.max(...cancelWaits), reason: "cancels" };
	return { allowed: true };
}

/** The refusal's text: how long to wait, in plain words. Too many cancels never tell anyone to check the password. */
export function signInLimitMessage(retryAfterSeconds: number, reason: SignInLimitReason = "failures"): string {
	const minutes = Math.ceil(retryAfterSeconds / 60);
	const wait = minutes <= 1 ? "a minute" : `${minutes} minutes`;
	if (reason === "cancels") return `Too many sign-in attempts to mail servers were cancelled. Try again in ${wait}.`;
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

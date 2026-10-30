/** How often the pending list is read while an update runs. */
export const MIGRATION_POLL_MS = 2000;
/** How long answered polls may show an unchanged pending list, after the connection dropped, before the outcome is called unknown. */
export const MIGRATION_STALL_MS = 3 * 60_000;
/** The most a run with no progress is followed (polls timing out count here, not as a stall) before it is called unknown. */
export const MIGRATION_RECOVERY_CAP_MS = 20 * 60_000;
/** The POST is cut off, and the run followed through the pending list, once the list has been empty this long with it still open. */
const MIGRATION_POST_GRACE_MS = 15_000;

/**
 * Statuses a proxy or the platform answers when it gave up waiting (Cloudflare's 524 comes after 100 s) while the
 * server may still be migrating. A network error is the same case.
 */
export function isTransientStatus(status: number): boolean {
	return (status >= 502 && status <= 504) || (status >= 520 && status <= 524);
}

/** The pending list only ever shrinks during a run, so an older or out-of-order answer never undoes progress. */
export function mergeRemaining(current: string[] | null, next: string[]): string[] {
	return current && next.length > current.length ? current : next;
}

/**
 * Reads again only after the previous read finished (a slow answer never overlaps the next request), and
 * reports a failed read as `null`. Returns the function that stops it.
 */
export function startStatusPolling<T>({
	read,
	onResult,
	delayMs,
}: {
	read: () => Promise<T>;
	onResult: (result: T | null) => void;
	delayMs: number;
}): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const tick = async () => {
		let result: T | null = null;
		try {
			result = await read();
		} catch {
			result = null;
		}
		if (stopped) return;
		onResult(result);
		if (!stopped) timer = setTimeout(() => void tick(), delayMs);
	};
	timer = setTimeout(() => void tick(), delayMs);
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}

/**
 * Says when a run being followed after a dropped connection should be called unknown: when answered polls have shown
 * an unchanged list for `stallMs` in total (a timed-out poll tells nothing, so it adds no stall time), or when
 * nothing has dropped for `capMs`, whatever the polls did.
 */
export function createStallTracker({
	stallMs,
	capMs,
	startedAt,
	startCount,
}: {
	stallMs: number;
	capMs: number;
	startedAt: number;
	startCount: number;
}) {
	let lowest = startCount;
	let lastProgressAt = startedAt;
	let lastAnsweredAt: number | null = null;
	let stalledMs = 0;
	return {
		/** `count` is the pending count an answered poll showed, or null for a poll that failed or timed out. */
		observe(count: number | null, now: number): boolean {
			if (count === null) {
				lastAnsweredAt = null;
			} else if (count < lowest) {
				lowest = count;
				lastProgressAt = now;
				stalledMs = 0;
				lastAnsweredAt = now;
			} else {
				if (lastAnsweredAt !== null) stalledMs += now - lastAnsweredAt;
				lastAnsweredAt = now;
			}
			return stalledMs >= stallMs || now - lastProgressAt >= capMs;
		},
	};
}

/**
 * Whether the POST should be cut off: the pending list has been empty for a while and it still has not answered.
 * There is deliberately no time limit: on Workers a client that disconnects cancels the request, so giving up on a
 * slow update would stop the very thing being watched.
 */
export function shouldAbortPost({ emptySince, now }: { emptySince: number | null; now: number }): boolean {
	return emptySince !== null && now - emptySince >= MIGRATION_POST_GRACE_MS;
}

export const MIGRATION_RUN_FLAG = "kite-migration-apply";
/**
 * Only where navigator.locks does not exist: a flag nobody refreshed for this long belongs to a tab that closed or
 * crashed. A hidden tab's timers can be throttled to once a minute, so it is longer than that.
 */
const MIGRATION_FLAG_STALE_MS = 75_000;
/** A timestamp this far ahead is a clock that moved, not a fresh heartbeat. */
const MIGRATION_FLAG_FUTURE_MS = 5_000;

/** Whether another tab says it is applying updates; `value` is the raw localStorage entry. */
export function isRunFlagActive(value: string | null, now: number): boolean {
	if (!value) return false;
	const at = Number(value);
	if (!Number.isFinite(at)) return false;
	const age = now - at;
	return age > -MIGRATION_FLAG_FUTURE_MS && age < MIGRATION_FLAG_STALE_MS;
}

/** The Web Lock every run holds, so no other tab can start one and every tab can see that one is going. */
export const MIGRATION_RUN_LOCK = "kite-migration-apply";

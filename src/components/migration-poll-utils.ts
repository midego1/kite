/** How often the pending list is read while an update runs. */
export const MIGRATION_POLL_MS = 2000;
/** How long the pending list may stay unchanged, after the connection dropped, before the outcome is called unknown. */
export const MIGRATION_STALL_MS = 3 * 60_000;

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

/** Says when the number of pending updates has not dropped for `windowMs`. */
export function createStallTracker(windowMs: number, startedAt: number, startCount: number) {
	let lowest = startCount;
	let lastProgressAt = startedAt;
	return {
		/** True once `windowMs` has passed since the count last dropped (or since the start). */
		observe(count: number, now: number): boolean {
			if (count < lowest) {
				lowest = count;
				lastProgressAt = now;
			}
			return now - lastProgressAt >= windowMs;
		},
	};
}

export const MIGRATION_RUN_FLAG = "kite-migration-apply";
/** A flag nobody refreshed for this long belongs to a tab that closed or crashed. */
const MIGRATION_FLAG_STALE_MS = 20_000;

/** Whether another tab says it is applying updates; `value` is the raw localStorage entry. */
export function isRunFlagActive(value: string | null, now: number): boolean {
	if (!value) return false;
	const at = Number(value);
	return Number.isFinite(at) && now - at < MIGRATION_FLAG_STALE_MS;
}

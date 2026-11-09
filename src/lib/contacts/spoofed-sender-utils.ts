/** How long opening a message waits for the display-name check before showing it without one. */
export const SPOOFED_SENDER_LOOKUP_TIMEOUT_MS = 1500;

/**
 * Resolves with `promise`'s value, or with `fallback` once `ms` passed or the promise rejected. The
 * timer is always cleared; the slow promise is left to finish on its own and its result is dropped.
 */
export async function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	try {
		return await Promise.race([promise.catch(() => fallback), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

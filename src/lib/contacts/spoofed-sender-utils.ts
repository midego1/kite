/** How long opening a message waits for the display-name check before showing it without one. */
export const SPOOFED_SENDER_LOOKUP_TIMEOUT_MS = 1500;

/**
 * Resolves with `promise`'s value, or with `fallback` once `ms` passed or the promise rejected. The
 * timer is always cleared; the slow promise is left to finish on its own and its result is dropped.
 * `onTimeout` runs only when the time limit won (never for a rejection), so a caller can log it.
 */
export async function settleWithin<T>(
	promise: Promise<T>,
	ms: number,
	fallback: T,
	onTimeout?: () => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => {
			onTimeout?.();
			resolve(fallback);
		}, ms);
	});
	try {
		return await Promise.race([promise.catch(() => fallback), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

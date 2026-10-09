import type { ChannelResult } from "./alerts-types";

type RetryResult<T> = { ok: true; value: T; attempts: number } | { ok: false; error: unknown; attempts: number };

/** One successful channel is enough; failure only counts when nothing was sent. */
export function decideDeliveryOutcome(results: ChannelResult[]): "delivered" | "failed" | "skipped" {
	if (results.some((result) => result.outcome === "sent")) return "delivered";
	if (results.some((result) => result.outcome === "failed")) return "failed";
	return "skipped";
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Races the attempt against its own timer as well as aborting its signal, so an
 * attempt that ignores the signal still cannot hold the cron run open.
 */
async function attemptWithTimeout<T>(
	attempt: (signal: AbortSignal, n: number) => Promise<T>,
	n: number,
	timeoutMs: number,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const reason = new DOMException("The alert delivery attempt timed out", "TimeoutError");
			controller.abort(reason);
			reject(reason);
		}, timeoutMs);
	});
	try {
		return await Promise.race([Promise.resolve().then(() => attempt(controller.signal, n)), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export async function runWithRetry<T>(
	attempt: (signal: AbortSignal, n: number) => Promise<T>,
	opts: { attempts?: number; timeoutMs: number; delayMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<RetryResult<T>> {
	const attempts = opts.attempts ?? 2;
	const sleep = opts.sleep ?? defaultSleep;
	let error: unknown;
	for (let n = 1; n <= attempts; n++) {
		if (n > 1) await sleep(opts.delayMs);
		try {
			return { ok: true, value: await attemptWithTimeout(attempt, n, opts.timeoutMs), attempts: n };
		} catch (caught) {
			error = caught;
		}
	}
	return { ok: false, error, attempts };
}

/** Redirects are not followed (`redirect: "manual"`), so only 2xx counts as delivered. */
export function classifyWebhookResponse(status: number): { ok: true } | { ok: false; reason: "http_status" } {
	return status >= 200 && status < 300 ? { ok: true } : { ok: false, reason: "http_status" };
}

export function classifyDeliveryError(error: unknown): "timeout" | "network" {
	const name = error instanceof Error || error instanceof DOMException ? error.name : "";
	return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

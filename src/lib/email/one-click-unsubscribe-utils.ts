import type { PinnedPost } from "@/lib/net/types";
import { OutboundUrlError, parsePublicHttpUrl } from "@/lib/security/outbound-url";

/** How long the sender's endpoint gets to answer; RFC 8058 asks it to act without further interaction. */
const ONE_CLICK_TIMEOUT_MS = 10_000;
const USER_AGENT = "Kite-Unsubscribe/1.0";
const LOOPBACK_HOST = "127.0.0.1";

type OneClickOutcome =
	| { ok: true; status: number }
	| { ok: false; reason: "refused_url" | "timeout" | "network" | "redirect" | "http_error"; status?: number };

type OneClickOptions = {
	/**
	 * The Node server's `env.PINNED_POST`: resolves the name, refuses private addresses and connects only to the
	 * addresses it checked. Without it (Workers, which cannot reach private networks) the literal check is enough.
	 */
	pinnedPost?: PinnedPost;
	/** Dev and test only (`UNSUBSCRIBE_ALLOW_LOOPBACK`): an endpoint on 127.0.0.1, plain http allowed. */
	allowLoopback?: boolean;
	fetch?: typeof fetch;
	timeoutMs?: number;
};

/** Dev/test only: the e2e receiver on 127.0.0.1 is never reachable in production. */
export function isUnsubscribeLoopbackAllowed(flag: string | undefined, nodeEnv: string | undefined): boolean {
	return flag === "1" && nodeEnv !== "production";
}

function isLoopbackTarget(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && url.hostname === LOOPBACK_HOST;
	} catch {
		return false;
	}
}

/**
 * The URL the POST may go to, or null: public `https` only, through the shared literal guard (`parsePublicHttpUrl`):
 * no credentials, no private, local or metadata hosts written into the URL. On Node `PINNED_POST` then checks every
 * address the name resolves to and pins them for the connection.
 */
function oneClickTarget(value: string, options: OneClickOptions): URL | null {
	if (options.allowLoopback && isLoopbackTarget(value)) return new URL(value);
	try {
		const url = parsePublicHttpUrl(value);
		return url.protocol === "https:" ? url : null;
	} catch (error) {
		if (error instanceof OutboundUrlError) return null;
		throw error;
	}
}

/** `promise`, or a rejection with the signal's reason once it aborts, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		promise.then(resolve, reject);
	});
}

function failureReason(error: unknown): "timeout" | "network" {
	const name = (error as { name?: string } | null)?.name;
	return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

const POST_HEADERS = { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT };
const POST_BODY = "List-Unsubscribe=One-Click";

/** The POST through `fetch` (Workers): no redirect followed, the body cancelled unread. */
async function fetchStatus(url: URL, signal: AbortSignal, doFetch: typeof fetch): Promise<number> {
	const response = await doFetch(url.href, {
		method: "POST",
		headers: POST_HEADERS,
		body: POST_BODY,
		redirect: "manual",
		signal,
	});
	// The body is never read: nothing the sender answers reaches the reader.
	await response.body?.cancel().catch(() => undefined);
	return response.status;
}

/**
 * Sends the RFC 8058 one-click POST (`List-Unsubscribe=One-Click`, form-encoded). No cookies or referrer, never
 * follows a redirect (so a public URL cannot bounce the request to a private one), and gives up after the timeout,
 * which covers the DNS check on Node as well as the request: a lookup that answers late never starts the POST.
 * Only a 2xx counts: anything else leaves the reader with the link to open themselves.
 */
export async function postOneClickUnsubscribe(value: string, options: OneClickOptions = {}): Promise<OneClickOutcome> {
	const url = oneClickTarget(value, options);
	if (!url) return { ok: false, reason: "refused_url" };
	const signal = AbortSignal.timeout(options.timeoutMs ?? ONE_CLICK_TIMEOUT_MS);
	let status: number;
	try {
		status = await untilAborted(
			options.pinnedPost && !(options.allowLoopback && isLoopbackTarget(value))
				? options.pinnedPost(url.href, { body: POST_BODY, headers: POST_HEADERS, signal }).then((r) => r.status)
				: fetchStatus(url, signal, options.fetch ?? fetch),
			signal,
		);
	} catch (error) {
		if (error instanceof OutboundUrlError) return { ok: false, reason: "refused_url" };
		return { ok: false, reason: failureReason(error) };
	}
	if (status >= 200 && status < 300) return { ok: true, status };
	if (status >= 300 && status < 400) return { ok: false, reason: "redirect", status };
	return { ok: false, reason: "http_error", status };
}

import { assertPublicHttpUrl, OutboundUrlError } from "@/lib/security/outbound-url";

/** How long the sender's endpoint gets to answer; RFC 8058 asks it to act without further interaction. */
const ONE_CLICK_TIMEOUT_MS = 10_000;
const USER_AGENT = "Kite-Unsubscribe/1.0";
const LOOPBACK_HOST = "127.0.0.1";

type OneClickOutcome =
	| { ok: true; status: number }
	| { ok: false; reason: "refused_url" | "timeout" | "network" | "redirect" | "http_error"; status?: number };

type OneClickOptions = {
	resolveHost?: CloudflareEnv["RESOLVE_HOST"];
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
 * The URL the POST may go to, or null. Public `https` only, through the shared outbound guard (`assertPublicHttpUrl`):
 * no credentials, no private, local or metadata hosts, and on Node every address the name resolves to must be public.
 */
async function oneClickTarget(value: string, options: OneClickOptions = {}): Promise<URL | null> {
	if (options.allowLoopback && isLoopbackTarget(value)) return new URL(value);
	try {
		const url = await assertPublicHttpUrl({ RESOLVE_HOST: options.resolveHost }, value);
		return url.protocol === "https:" ? url : null;
	} catch (error) {
		if (error instanceof OutboundUrlError) return null;
		throw error;
	}
}

/**
 * Sends the RFC 8058 one-click POST (`List-Unsubscribe=One-Click`, form-encoded). No cookies or referrer, never
 * follows a redirect (so a public URL cannot bounce the request to a private one), and gives up after the timeout.
 * Only a 2xx counts: anything else leaves the reader with the link to open themselves.
 */
export async function postOneClickUnsubscribe(value: string, options: OneClickOptions = {}): Promise<OneClickOutcome> {
	const url = await oneClickTarget(value, options);
	if (!url) return { ok: false, reason: "refused_url" };
	const doFetch = options.fetch ?? fetch;
	let response: Response;
	try {
		response = await doFetch(url.href, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
			body: "List-Unsubscribe=One-Click",
			redirect: "manual",
			signal: AbortSignal.timeout(options.timeoutMs ?? ONE_CLICK_TIMEOUT_MS),
		});
	} catch (error) {
		const name = (error as { name?: string } | null)?.name;
		return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
	}
	// The body is never read: nothing the sender answers reaches the reader.
	await response.body?.cancel().catch(() => undefined);
	if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
	if (response.status >= 300 && response.status < 400)
		return { ok: false, reason: "redirect", status: response.status };
	return { ok: false, reason: "http_error", status: response.status };
}

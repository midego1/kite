const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Dev/test only: a plain-http loopback provider (the fake model) is never allowed in production. */
export function isAgentLoopbackAllowed(flag: string | undefined, nodeEnv: string | undefined): boolean {
	return flag === "1" && nodeEnv !== "production";
}

/** Dev/test only: the shorter timeout the specs set with `AI_TEST_TIMEOUT_MS`, or `fallback` everywhere else. */
export function aiCallTimeoutMs(
	env: { AI_ALLOW_INSECURE_LOOPBACK?: string; AI_TEST_TIMEOUT_MS?: string },
	nodeEnv: string | undefined,
	fallback: number,
): number {
	const value = Number(env.AI_TEST_TIMEOUT_MS);
	if (!isAgentLoopbackAllowed(env.AI_ALLOW_INSECURE_LOOPBACK, nodeEnv) || !Number.isInteger(value) || value <= 0)
		return fallback;
	return Math.min(value, fallback);
}

export function parseCustomAgentBaseUrl(customUrl: string, allowInsecureLoopback: boolean): string {
	const url = new URL(customUrl.trim());
	const loopbackHttp = allowInsecureLoopback && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
	if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password || url.search || url.hash)
		throw new Error("Custom provider URL must be an HTTPS base URL without credentials or query parameters");
	return url.toString().replace(/\/$/, "");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Dev/test only: a plain-http loopback provider (the fake model) is never allowed in production. */
export function isAgentLoopbackAllowed(flag: string | undefined, nodeEnv: string | undefined): boolean {
	return flag === "1" && nodeEnv !== "production";
}

export function parseCustomAgentBaseUrl(customUrl: string, allowInsecureLoopback: boolean): string {
	const url = new URL(customUrl.trim());
	const loopbackHttp = allowInsecureLoopback && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
	if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password || url.search || url.hash)
		throw new Error("Custom provider URL must be an HTTPS base URL without credentials or query parameters");
	return url.toString().replace(/\/$/, "");
}

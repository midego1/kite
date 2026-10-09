import type { CsrfRequestFacts } from "./csrf-types";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * API paths that are legitimately called cross-origin or without a browser:
 * API-key routes and public, self-authenticating webhooks. Matching is per path
 * segment, so `/api/inbound` covers `/api/inbound/ses` but not `/api/inboundx`.
 */
export const CSRF_EXEMPT_API_PREFIXES = ["/api/v1", "/api/inbound", "/api/public", "/api/seed"] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function requiresCsrfCheck(method: string, pathname: string): boolean {
	if (!UNSAFE_METHODS.has(method.toUpperCase())) return false;
	if (!matchesPrefix(pathname, "/api")) return false;
	return !CSRF_EXEMPT_API_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

function originHost(value: string): string | null {
	try {
		return new URL(value).host.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Bearer requests carry no ambient credential, so a browser cannot forge them.
 * Otherwise the request must come from one of `allowedHosts`, judged by
 * Sec-Fetch-Site first and the Origin header as a fallback.
 */
export function isAllowedMutationRequest(facts: CsrfRequestFacts): boolean {
	if (facts.authorization?.startsWith("Bearer ")) return true;
	if (facts.fetchSite === "same-origin") return true;
	if (facts.fetchSite === "cross-site" || facts.fetchSite === "same-site") return false;
	if (!facts.origin) return false;
	const host = originHost(facts.origin);
	if (!host) return false;
	return facts.allowedHosts.some((allowed) => allowed.toLowerCase() === host);
}

/** Hosts a browser may legitimately send mutations from: the request's own host and APP_URL's. */
export function getAllowedMutationHosts(requestHost: string | null | undefined, appUrl?: string | null): string[] {
	const hosts: string[] = [];
	if (requestHost) hosts.push(requestHost.toLowerCase());
	const appHost = appUrl ? originHost(appUrl) : null;
	if (appHost && !hosts.includes(appHost)) hosts.push(appHost);
	return hosts;
}

export function csrfRejection(): Response {
	return new Response(JSON.stringify({ error: "Cross-site request blocked" }), {
		status: 403,
		headers: { "Content-Type": "application/json" },
	});
}

/** Shared by worker.ts and the Node server: null to continue, or the 403 to return. */
export function checkCsrf(request: Request, appUrl?: string | null): Response | null {
	const url = new URL(request.url);
	if (!requiresCsrfCheck(request.method, url.pathname)) return null;
	const allowed = isAllowedMutationRequest({
		authorization: request.headers.get("Authorization"),
		fetchSite: request.headers.get("Sec-Fetch-Site"),
		origin: request.headers.get("Origin"),
		allowedHosts: getAllowedMutationHosts(request.headers.get("Host") ?? url.host, appUrl),
	});
	return allowed ? null : csrfRejection();
}

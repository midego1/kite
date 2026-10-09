import { expect, test, type APIRequestContext } from "@playwright/test";
import { listRouteFiles, routeMethods, routePath } from "../scripts/docs-generate.mjs";
import { ADMIN, BASE_URL } from "./support/constants";
import { probeUpgrade, realtimeVerdict } from "./support/realtime-probe.mjs";
import { PUBLIC_ROUTES, SKIPPED_ROUTES } from "./support/public-routes";

test.use({ storageState: { cookies: [], origins: [] } });

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CONCURRENCY = 8;

/** Same-origin headers, so the CSRF guard passes and only route authentication is under test. */
const sameOrigin = { Origin: BASE_URL, "Sec-Fetch-Site": "same-origin" };

/** `[id]` becomes a placeholder and catch-all segments (`[...x]`, `[[...x]]`) a single segment. */
function concretePath(route: string): string {
	return route.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, "x").replace(/\[[^\]]+\]/g, "e2e_probe");
}

async function probe(
	request: APIRequestContext,
	method: string,
	path: string,
	headers: Record<string, string> = sameOrigin,
) {
	const response = await request.fetch(path, {
		method,
		headers,
		data: SAFE_METHODS.has(method) ? undefined : {},
		maxRedirects: 0,
		failOnStatusCode: false,
	});
	return response.status();
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await run(items[index]);
			}
		}),
	);
	return results;
}

async function enumerateProbes() {
	const skipped = new Set(SKIPPED_ROUTES.map((route) => `${route.method} ${route.path}`));
	const probes: { method: string; path: string }[] = [];
	for (const filename of await listRouteFiles()) {
		const path = concretePath(routePath(filename));
		for (const method of await routeMethods(filename)) {
			if (!skipped.has(`${method} ${path}`)) probes.push({ method, path });
		}
	}
	return probes;
}

test("the public allowlist has a reason for every entry", () => {
	for (const route of [...PUBLIC_ROUTES, ...SKIPPED_ROUTES]) {
		expect(route.reason.trim(), `${route.method} ${route.path}`).not.toBe("");
	}
});

test("every API route answers 401 or 403 without a session, except the documented public routes", async ({
	request,
}) => {
	const probes = await enumerateProbes();
	expect(probes.length).toBeGreaterThan(150);

	const allowed = new Map(PUBLIC_ROUTES.map((route) => [`${route.method} ${route.path}`, route.status]));
	const results = await mapLimit(probes, CONCURRENCY, async ({ method, path }) => ({
		method,
		path,
		status: await probe(request, method, path),
	}));

	const violations: string[] = [];
	const seen = new Set<string>();
	for (const { method, path, status } of results) {
		const key = `${method} ${path}`;
		seen.add(key);
		const expected = allowed.get(key);
		if (expected !== undefined) {
			if (status !== expected) violations.push(`${key} -> ${status} (allowlisted as ${expected})`);
		} else if (status !== 401 && status !== 403) {
			violations.push(`${key} -> ${status} (expected 401 or 403)`);
		}
	}
	for (const key of allowed.keys()) {
		if (!seen.has(key)) violations.push(`${key} is allowlisted but no such route exists`);
	}
	expect(violations, `Unexpected statuses:\n${violations.join("\n")}`).toEqual([]);
});

test("the realtime endpoint refuses plain requests and unauthenticated upgrades", async ({ request }) => {
	const login = await request.post("/api/auth/login", {
		headers: sameOrigin,
		data: { email: ADMIN.email, password: ADMIN.password },
	});
	expect(login.status()).toBe(200);
	const session = login
		.headersArray()
		.filter((header) => header.name.toLowerCase() === "set-cookie")
		.map((header) => header.value.split(";")[0])
		.find((cookie) => cookie.startsWith("ep_session="));
	expect(session, "ep_session not set").toBeTruthy();

	const url = `${BASE_URL}/api/realtime`;
	const verdict = realtimeVerdict({
		plain: await probe(request, "GET", "/api/realtime", sameOrigin),
		anonymous: await probeUpgrade(url, sameOrigin),
		authenticated: await probeUpgrade(url, { ...sameOrigin, Cookie: session! }),
	});
	expect(verdict).toBeNull();
});

test("every /api/v1 method rejects an invalid bearer token", async ({ request }) => {
	const failures: string[] = [];
	let count = 0;
	for (const filename of await listRouteFiles()) {
		const route = routePath(filename);
		if (!route.startsWith("/api/v1/")) continue;
		for (const method of await routeMethods(filename)) {
			count++;
			const status = await probe(request, method, concretePath(route), {
				...sameOrigin,
				Authorization: "Bearer invalid",
			});
			if (status !== 401) failures.push(`${method} ${route} -> ${status}`);
		}
	}
	expect(count).toBeGreaterThan(0);
	expect(failures).toEqual([]);
});

test.describe("security headers", () => {
	const documentHeaders = async (request: APIRequestContext, path: string) => {
		const response = await request.get(path);
		expect(response.status()).toBe(200);
		return response.headers();
	};

	for (const path of ["/login", "/api/setup/status"]) {
		test(`${path} carries the hardening headers`, async ({ request }) => {
			const headers = await documentHeaders(request, path);
			expect(headers["content-security-policy"]).toContain("frame-ancestors 'self'");
			expect(headers["content-security-policy"]).toContain("object-src 'none'");
			expect(headers["x-content-type-options"]).toBe("nosniff");
			expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
			expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
			expect(headers["strict-transport-security"]).toBeTruthy();
			expect(headers["permissions-policy"]).toBeTruthy();
			if (path.startsWith("/api/")) {
				expect(headers["cache-control"]).toContain("no-store");
				expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
			}
		});
	}
});

// `Secure` is added only when the request is served over https (production); the e2e server speaks
// plain http, so these cookies must not carry it here.
test("session cookies are HttpOnly, SameSite=Lax and scoped to /", async ({ request }) => {
	const response = await request.post("/api/auth/login", {
		headers: sameOrigin,
		data: { email: ADMIN.email, password: ADMIN.password },
	});
	expect(response.status()).toBe(200);
	const setCookies = response
		.headersArray()
		.filter((header) => header.name.toLowerCase() === "set-cookie")
		.map((header) => header.value);
	for (const name of ["ep_session", "ep_accounts"]) {
		const cookie = setCookies.find((value) => value.startsWith(`${name}=`));
		expect(cookie, `${name} not set`).toBeTruthy();
		expect(cookie).toMatch(/;\s*HttpOnly/i);
		expect(cookie).toMatch(/;\s*SameSite=Lax/i);
		expect(cookie).toMatch(/;\s*Path=\//i);
		expect(cookie).not.toMatch(/;\s*Secure/i);
	}
});

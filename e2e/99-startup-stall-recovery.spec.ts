import { expect, test, type Page } from "@playwright/test";

// A start that stops moving while its page stays alive: its timers run, so the frozen-thread notice never shows and
// the service worker keeps getting heartbeats, but the startup screen shows nothing new. The boot watchdog
// (asset-recovery-utils.ts) compares the boot trace's phase and step on every tick: past the step's budget the step
// tries again (the session check aborts and retries), then the tab reloads once, and the next load reports the
// stall; a visible page the browser paints no frame for reloads at once. 99-startup-frozen covers the frozen-thread
// notice, 99-startup-freeze-reload the service worker.

const COMPOSE = { name: "Compose new email", exact: true } as const;
const ARMED_KEY = "e2e-stall-armed";

test.describe.configure({ timeout: 120_000 });

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

/**
 * The session check never times out (its timer is taken away, as in a page whose timeout never fires); the first
 * `held` requests to `/api/auth/me` never answer. Returns when each document load started and the boot reports.
 */
async function hangSessionCheck(page: Page, held: number) {
	await page.addInitScript(() => {
		AbortSignal.timeout = () => new AbortController().signal;
	});
	let seen = 0;
	await page.route("**/api/auth/me", (route) => {
		seen += 1;
		if (seen <= held) return;
		return route.continue();
	});
	return watchLoads(page);
}

function watchLoads(page: Page) {
	const startedAt = Date.now();
	const loads: number[] = [];
	const reports: Record<string, unknown>[] = [];
	page.on("request", (request) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads.push(Date.now() - startedAt);
		if (request.url().endsWith("/api/boot-report")) reports.push(JSON.parse(request.postData() ?? "{}"));
	});
	return { loads, reports, startedAt };
}

test("a session check that outlives its timeout is asked to try again and the start goes through", async ({ page }) => {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	const { loads } = await hangSessionCheck(page, 1);
	await page.goto("/inbox", { waitUntil: "commit" });
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	expect(loads).toHaveLength(1);
	expect(errors.some((text) => /the start stalled at loader-mounted.*trying again/.test(text))).toBe(true);
});

test("a session check that never answers offers Reload Kite, then reloads once and reports the stall", async ({
	page,
}) => {
	test.setTimeout(90_000);
	// Every check of the first load hangs, the retry included; the reloaded load's check answers.
	const { loads, reports } = await hangSessionCheck(page, 2);
	await page.goto("/inbox", { waitUntil: "commit" });
	await expect(page.getByRole("button", { name: "Reload Kite" })).toBeVisible({ timeout: 25_000 });
	expect(loads).toHaveLength(1);
	await expect.poll(() => loads.length, { timeout: 20_000 }).toBe(2);
	expect(loads[1] - loads[0]).toBeGreaterThan(20_000);
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => reports.map((body) => body.event)).toContain("startup_stalled");
	expect(reports.find((body) => body.event === "startup_stalled")).toMatchObject({
		page: "/inbox",
		phase: "loader-mounted",
		reason: "no-progress",
		reloaded: true,
		pending: expect.arrayContaining(["/api/auth/me"]),
	});
	expect(loads).toHaveLength(2);
});

test("a visible start the browser paints no frame for reloads by itself", async ({ page }) => {
	// One load gets no animation frames at all (as when the browser stops painting it) and keeps its screen up.
	await page.addInitScript((key) => {
		if (sessionStorage.getItem(key)) return;
		sessionStorage.setItem(key, "1");
		window.requestAnimationFrame = () => 0;
	}, ARMED_KEY);
	const { loads, reports } = await hangSessionCheck(page, 1);
	await page.goto("/inbox", { waitUntil: "commit" });
	// Ten seconds without a frame, before the session check's own budget runs out.
	await expect.poll(() => loads.length, { timeout: 20_000 }).toBe(2);
	expect(loads[1] - loads[0]).toBeLessThan(15_000);
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => reports.map((body) => body.event)).toContain("startup_stalled");
	expect(reports.find((body) => body.event === "startup_stalled")).toMatchObject({ reason: "no-frames" });
});

test("an IndexedDB open that never answers does not hold up the start", async ({ page }) => {
	await page.addInitScript(() => {
		const request = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null, readyState: "pending" };
		indexedDB.open = () => request as unknown as IDBOpenDBRequest;
	});
	const { loads } = watchLoads(page);
	await page.goto("/inbox", { waitUntil: "commit" });
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	expect(loads).toHaveLength(1);
});

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// The service worker's freeze watchdog (public/kite-sw.js): while the startup screen is up, the page posts it a
// heartbeat about twice a second, and a visible tab whose heartbeats stop for 10 seconds is reloaded from outside
// its main thread. Two ways to stop them: dropping the heartbeats while the page keeps running (a page whose timers
// stopped but that still takes tasks, reloaded at once), and a main thread blocked by a long synchronous loop, which
// Chromium navigates only once the loop ends (as it does a reload from the toolbar), so the reload lands then
// instead of the stuck load carrying on. 99-startup-frozen covers the frozen-thread notice and the next load's
// report; tests/kite-sw.test.mjs every decision of the worker.

const COMPOSE = { name: "Compose new email", exact: true } as const;
const ARMED_KEY = "e2e-freeze-armed";

test.describe.configure({ timeout: 150_000 });

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

type Freeze = {
	/** How many loads after arming freeze. */
	loads: number;
	/** Block the main thread this long once the startup screen has mounted. */
	blockMs?: number;
	/** Drop the heartbeats to the worker once the startup screen has mounted; the page keeps running. */
	silence?: boolean;
	/** These loads say they are hidden. */
	hidden?: boolean;
};

async function freezeAfterLoaderMounts(page: Page, freeze: Freeze) {
	await page.addInitScript(
		({ armedKey, loads, blockMs, silence, hidden }) => {
			if (sessionStorage.getItem(armedKey) !== "1") return;
			const used = Number(sessionStorage.getItem("e2e-freezes") || 0);
			if (used >= loads) return;
			if (hidden) {
				Object.defineProperty(Document.prototype, "visibilityState", { get: () => "hidden", configurable: true });
				Object.defineProperty(Document.prototype, "hidden", { get: () => true, configurable: true });
			}
			const mounted = () => (window as unknown as Record<string, unknown>).__kiteLoaderMounted === true;
			if (silence) {
				const post = ServiceWorker.prototype.postMessage;
				ServiceWorker.prototype.postMessage = function (this: ServiceWorker, message: unknown, ...rest: unknown[]) {
					if (mounted() && (message as { type?: string })?.type === "kite:boot-beat") return;
					return (post as (...args: unknown[]) => void).call(this, message, ...rest);
				} as typeof post;
			}
			const timer = setInterval(() => {
				if (!mounted()) return;
				clearInterval(timer);
				sessionStorage.setItem("e2e-freezes", String(used + 1));
				const end = Date.now() + (blockMs ?? 0);
				while (Date.now() < end) {
					// Frozen.
				}
			}, 20);
		},
		{ armedKey: ARMED_KEY, blockMs: 0, silence: false, hidden: false, ...freeze },
	);
}

/** A first load registers the service worker, which takes control of it once it has activated. */
async function startControlled(page: Page) {
	await page.goto("/inbox");
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() => page.evaluate(() => (navigator.serviceWorker?.controller ? 1 : 0)), { timeout: 20_000 })
		.toBe(1);
	await page.evaluate((key) => sessionStorage.setItem(key, "1"), ARMED_KEY);
}

/**
 * When each document load of the page started and the events the worker reported, from the moment it is called;
 * with `holdSessionFor`, the session check of that many loads never answers, so their startup screen stays up.
 */
async function watchLoads(page: Page, context: BrowserContext, { holdSessionFor = 0 } = {}) {
	const startedAt = Date.now();
	const loads: number[] = [];
	const reports: { event: string; at: number }[] = [];
	page.on("request", (request) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads.push(Date.now() - startedAt);
	});
	context.on("request", (request) => {
		if (!request.url().endsWith("/api/boot-report")) return;
		try {
			const event = JSON.parse(request.postData() ?? "{}").event ?? "previous_load_froze";
			reports.push({ event, at: Date.now() - startedAt });
		} catch {
			// Not a report.
		}
	});
	if (holdSessionFor > 0) {
		await page.route("**/api/auth/me", (route) => {
			if (loads.length <= holdSessionFor) return;
			return route.continue();
		});
	}
	const events = () => reports.map((report) => report.event);
	return { loads, reports, events };
}

test("a tab whose heartbeats stop on the startup screen reloads by itself within seconds and then starts", async ({
	page,
	context,
}) => {
	await freezeAfterLoaderMounts(page, { loads: 1, silence: true });
	await startControlled(page);
	const { loads, reports, events } = await watchLoads(page, context, { holdSessionFor: 1 });
	await page.goto("/inbox", { waitUntil: "commit" });
	await expect.poll(() => loads.length, { timeout: 25_000 }).toBe(2);
	// Ten seconds of silence after the screen mounted, then the next check.
	expect(loads[1] - loads[0]).toBeGreaterThan(9_000);
	expect(loads[1] - loads[0]).toBeLessThan(16_000);
	expect(events()).toContain("auto_reloaded_after_freeze");
	const report = reports.find((entry) => entry.event === "auto_reloaded_after_freeze");
	expect(report!.at).toBeLessThanOrEqual(loads[1] + 1_000);
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	expect(loads).toHaveLength(2);
	// The reloaded load heard so: it keeps the time for the worker and names it in its Details.
	await expect.poll(() => page.evaluate(() => Number(sessionStorage.getItem("kite:auto-reloaded-at")) > 0)).toBe(true);
	await expect
		.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("kite-boot-trace") ?? "{}").autoReloaded))
		.toBe(true);
});

test("a main thread blocked by a long loop lands on a fresh load as soon as it comes free", async ({
	page,
	context,
}) => {
	await freezeAfterLoaderMounts(page, { loads: 1, blockMs: 25_000 });
	await startControlled(page);
	const { loads, reports, events } = await watchLoads(page, context);
	await page.goto("/inbox", { waitUntil: "commit" });
	// The worker gives up on the frozen load after about ten seconds, long before the loop ends.
	await expect.poll(events, { timeout: 20_000 }).toContain("auto_reloaded_after_freeze");
	expect(reports[0].at).toBeLessThan(18_000);
	// Without it the frozen load would carry on by itself once the loop ends; with it the tab loads again.
	await expect.poll(() => loads.length, { timeout: 30_000 }).toBe(2);
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	expect(loads).toHaveLength(2);
	expect(await page.evaluate(() => sessionStorage.getItem("e2e-freezes"))).toBe("1");
});

test("a hidden tab that freezes is left alone", async ({ page, context }) => {
	await freezeAfterLoaderMounts(page, { loads: 1, blockMs: 20_000, hidden: true });
	await startControlled(page);
	const { loads, events } = await watchLoads(page, context);
	await page.goto("/inbox", { waitUntil: "commit" });
	// Past the loop and then some: the page carries on with the load it started.
	await page.waitForTimeout(26_000);
	expect(loads).toHaveLength(1);
	expect(events()).not.toContain("auto_reloaded_after_freeze");
	expect(await page.evaluate(() => sessionStorage.getItem("e2e-freezes"))).toBe("1");
});

test("a load that freezes again right after an automatic reload is reported, not reloaded again", async ({
	page,
	context,
}) => {
	await freezeAfterLoaderMounts(page, { loads: 2, silence: true });
	await startControlled(page);
	const { loads, events } = await watchLoads(page, context, { holdSessionFor: 2 });
	await page.goto("/inbox", { waitUntil: "commit" });
	await expect.poll(() => loads.length, { timeout: 25_000 }).toBe(2);
	// The second load goes silent too: the worker reports it and leaves the startup screen's notice as the way out.
	await expect.poll(events, { timeout: 25_000 }).toContain("freeze_not_reloaded");
	await page.waitForTimeout(3_000);
	expect(loads).toHaveLength(2);
	expect(events().filter((event) => event === "auto_reloaded_after_freeze")).toHaveLength(1);
	// The page itself still runs: once the session check answers it starts as usual.
	await page.unroute("**/api/auth/me");
	await page.getByRole("button", { name: /Try again/ }).click({ timeout: 20_000 });
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	expect(loads).toHaveLength(2);
});

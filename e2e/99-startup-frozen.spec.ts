import { expect, test, type Page } from "@playwright/test";

// A start that does not finish: the session check that hangs (the screen keeps moving and ends in its error state)
// and a main thread that stops, which runs no timer, so neither "Reload Kite" nor the boot watchdog's box can
// appear. Its way out is the startup screen's frozen-thread notice (`.loader-frozen`, loading-transition.tsx),
// which the compositor fades in once the watchdog's heartbeat on <html> stops restarting it. A spec cannot freeze
// the page and still read it, so the heartbeat is stopped instead; a real freeze was checked on a production build.
// The next load reports a load that froze to the server (`/api/boot-report`). 18, 65, 91 and 98 cover the rest.

const OVERLAY = "[data-loading-overlay]";
const NOTICE = "[data-loader-frozen]";
const COMPOSE = { name: "Compose new email", exact: true } as const;

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

function percent(page: Page) {
	return page.evaluate(() => {
		const text = document.querySelector("[data-startup-status]")?.parentElement?.textContent ?? "";
		const match = /(\d+)%$/.exec(text);
		return match ? Number(match[1]) : null;
	});
}

function noticeOpacity(page: Page) {
	return page.evaluate((selector) => {
		const notice = document.querySelector(selector);
		return notice ? Number(getComputedStyle(notice).opacity) : null;
	}, NOTICE);
}

/** The session check stays open for good while React runs the screen: its timeout is disabled. */
async function holdSessionCheck(page: Page) {
	await page.addInitScript(() => {
		AbortSignal.timeout = () => new AbortController().signal;
	});
	const held: (() => Promise<void>)[] = [];
	await page.route("**/api/auth/me", (route) => {
		held.push(() => route.continue());
	});
	return {
		held,
		release: async () => {
			await page.unroute("**/api/auth/me");
			await Promise.all(held.splice(0).map((next) => next().catch(() => undefined)));
		},
	};
}

test("a session check that never answers keeps the bar moving past 15% and ends in the error state", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.route("**/api/auth/me", () => undefined);
	await page.goto("/inbox", { waitUntil: "commit" });
	await page.waitForSelector(`${OVERLAY}[role="status"]`, { state: "attached", timeout: 20_000 });
	await expect(page.locator("[data-startup-status]")).toHaveText("Signing you in…");
	// A wait on the network is no frozen page: the bar keeps going while the session line runs.
	await expect.poll(() => percent(page), { timeout: 5_000 }).toBeGreaterThan(40);
	// The first attempt times out after 6 s and the one retry after 4 s more: then the error state, with a way out.
	const failure = page.locator(OVERLAY).getByRole("alert");
	await expect(failure).toContainText("Kite couldn't check your sign-in", { timeout: 20_000 });
	await expect(failure.getByRole("button", { name: "Try again" })).toBeVisible();
	await expect(page.locator(NOTICE)).toHaveCount(0);
});

test("while the page runs, the frozen-thread notice never shows, even on a start that takes long", async ({ page }) => {
	test.setTimeout(60_000);
	const session = await holdSessionCheck(page);
	await page.goto("/inbox", { waitUntil: "commit" });
	await page.waitForSelector(NOTICE, { state: "attached", timeout: 20_000 });
	await expect.poll(() => session.held.length).toBeGreaterThan(0);
	// Past the notice's 10 seconds: the watchdog's ticks keep restarting it.
	await page.waitForTimeout(13_000);
	expect(await noticeOpacity(page)).toBe(0);
	await expect(page.getByRole("button", { name: "Reload Kite" })).toBeVisible({ timeout: 10_000 });
	expect(await noticeOpacity(page)).toBe(0);
	await session.release();
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	await expect(page.locator(NOTICE)).toHaveCount(0);
});

test("once the page stops giving signs of life, the notice fades in by itself", async ({ page }) => {
	test.setTimeout(60_000);
	// The watchdog's beats stop, as on a main thread that froze (it keeps running here, so the page can be read).
	await page.addInitScript(() => {
		const setAttribute = Element.prototype.setAttribute;
		Element.prototype.setAttribute = function (name: string, value: string) {
			if (name === "data-kite-heartbeat" && this.hasAttribute(name)) return;
			return setAttribute.call(this, name, value);
		};
	});
	await holdSessionCheck(page);
	await page.goto("/inbox", { waitUntil: "commit" });
	await page.waitForSelector(NOTICE, { state: "attached", timeout: 20_000 });
	await page.waitForTimeout(5_000);
	expect(await noticeOpacity(page)).toBe(0);
	await expect.poll(() => noticeOpacity(page), { timeout: 12_000 }).toBe(1);
	const notice = page.locator(NOTICE);
	await expect(notice).toHaveText("Kite stopped responding. Reload this page to start again.");
	// Inside the viewport, on the startup screen, and not announced: nothing could announce it on a frozen page.
	await expect(notice).toBeInViewport();
	await expect(notice).toHaveAttribute("aria-hidden", "true");
	expect(await page.locator(OVERLAY).evaluate((overlay, selector) => !!overlay.querySelector(selector), NOTICE)).toBe(
		true,
	);
});

test("a tab whose previous load froze reports it to the server, with its step and build", async ({ page }) => {
	await page.addInitScript((key) => {
		if (sessionStorage.getItem("e2e-trace-seeded")) return;
		sessionStorage.setItem("e2e-trace-seeded", "1");
		sessionStorage.setItem(
			key,
			JSON.stringify({
				v: 1,
				page: "/inbox",
				phases: [
					{ p: "inline", t: 40 },
					{ p: "loader-mounted", t: 900 },
					{ p: "auth-answered", t: 1_010 },
					{ p: "children-rendering", t: 1_012 },
				],
				mounts: 1,
				beat: 1_100,
				visibleMs: 1_000,
				visible: true,
				step: { s: "reading-pane", t: 1_050 },
				build: "2026.10.31.7 (9b00167)",
				afterUpdate: true,
			}),
		);
	}, "kite-boot-trace");
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	const report = page.waitForRequest((request) => request.url().endsWith("/api/boot-report"));
	const answered = page.waitForResponse((response) => response.url().endsWith("/api/boot-report"));
	await page.goto("/inbox");
	const request = await report;
	expect(request.method()).toBe("POST");
	expect(JSON.parse(request.postData() ?? "null")).toEqual({
		page: "/inbox",
		phase: "children-rendering",
		afterMs: 1_100,
		visibleMs: 1_000,
		step: "reading-pane",
		build: "2026.10.31.7 (9b00167)",
		afterUpdate: true,
	});
	expect((await answered).status()).toBe(204);
	expect(errors).toContain("[kite] previous load froze at phase children-rendering (step reading-pane) after 1100 ms");
	// This load starts fine and reports nothing more.
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	const record = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("kite-boot-trace")!));
	await expect
		.poll(async () => (await record()).phases.map((entry: { p: string }) => entry.p))
		.toEqual([
			"inline",
			"loader-mounted",
			"auth-answered",
			"children-rendering",
			"children-committed",
			"auth-ready",
			"can-complete",
			"complete",
		]);
	expect((await record()).afterUpdate).toBeUndefined();
});

test("the server refuses a boot report from outside a session or that is not one", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	const status = (body: string, credentials: RequestCredentials = "same-origin") =>
		page.evaluate(
			async ({ body, credentials }) =>
				(
					await fetch("/api/boot-report", {
						method: "POST",
						body,
						credentials,
						headers: { "Content-Type": "text/plain" },
					})
				).status,
			{ body, credentials },
		);
	expect(await status(JSON.stringify({ page: "/inbox", phase: "loader-mounted", afterMs: 10, visibleMs: 10 }))).toBe(
		204,
	);
	expect(await status("not a report")).toBe(400);
	expect(await status(JSON.stringify({ page: "/inbox", phase: "Free text", afterMs: 10, visibleMs: 10 }))).toBe(400);
	expect(
		await status(JSON.stringify({ page: "/inbox", phase: "loader-mounted", afterMs: 10, visibleMs: 10 }), "omit"),
	).toBe(401);
});

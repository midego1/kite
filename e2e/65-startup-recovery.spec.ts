import { expect, test, type Page } from "@playwright/test";

// Startup never ends on an endless loader: a file that hangs instead of failing gets an automatic reload and then
// a static "Kite couldn't load" (the inline watchdog in src/components/asset-recovery-utils.ts), and a session
// check that fails or hangs is retried and then shows an error state with Try again (AuthGuard).

const COMPOSE = { name: "Compose new email", exact: true } as const;
const AUTH_ME = "**/api/auth/me";
/** A module of the startup screen's own subtree: while it hangs, React never takes the screen over. */
const isAuthGuardModule = (url: URL) => url.pathname.endsWith("/src/components/auth/auth-guard.tsx");

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

function countDocumentLoads(page: Page) {
	const documents = { count: 0 };
	page.on("request", (request) => {
		if (request.resourceType() === "document" && request.frame() === page.mainFrame()) documents.count += 1;
	});
	return documents;
}

async function openInbox(page: Page) {
	await page.goto("/inbox");
	await expect(page.getByRole("button", COMPOSE)).toBeVisible();
}

function bootFailure(page: Page) {
	return page.getByRole("alert").filter({ hasText: "Kite couldn't load." });
}

function sessionFailure(page: Page) {
	return page.getByRole("alert").filter({ hasText: "Kite couldn't check your sign-in." });
}

test.describe("files that hang", () => {
	test("a module that never arrives is reloaded instead of leaving the loader up", async ({ page }) => {
		await openInbox(page);
		const documents = countDocumentLoads(page);
		let requests = 0;
		// The first load's request is never answered: no error event, so only the watchdog can end it.
		await page.route(isAuthGuardModule, (route) => (requests++ === 0 ? undefined : route.continue()));

		await page.reload({ waitUntil: "commit" });
		await expect(page.locator("[data-loading-overlay][role=status]")).toBeVisible();
		// 8 seconds of visible time, plus `vite dev`'s 10-second grace after the last module that arrived.
		await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 45_000 });
		expect(documents.count).toBe(2);
		await expect(bootFailure(page)).toHaveCount(0);
		// React runs the startup screen again, so the reload budget starts over.
		await expect.poll(() => page.evaluate(() => sessionStorage.getItem("kite:asset-reload"))).toBeNull();
	});

	test("a module that arrives late is waited for, not reloaded", async ({ page }) => {
		await openInbox(page);
		const documents = countDocumentLoads(page);
		let requests = 0;
		// The entry module, which the document names: 15 seconds without progress, then it arrives.
		await page.route(
			(url) => url.pathname.endsWith("/entry-browser"),
			async (route) => {
				if (requests++ === 0) await new Promise((resolve) => setTimeout(resolve, 15_000));
				await route.continue();
			},
		);
		await page.reload({ waitUntil: "commit" });
		await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 45_000 });
		expect(documents.count).toBe(1);
		await expect(bootFailure(page)).toHaveCount(0);
	});

	test("once the reload budget is spent it shows Kite couldn't load, and Reload loads the app", async ({ page }) => {
		await openInbox(page);
		const documents = countDocumentLoads(page);
		// Four automatic reloads already happened in this tab.
		await page.evaluate(() =>
			sessionStorage.setItem("kite:asset-reload", JSON.stringify({ count: 4, since: Date.now() })),
		);
		let hang = true;
		await page.route(isAuthGuardModule, (route) => (hang ? undefined : route.continue()));

		await page.reload({ waitUntil: "commit" });
		const failure = bootFailure(page);
		await expect(failure).toBeVisible({ timeout: 30_000 });
		expect(documents.count).toBe(1);

		// The hung request stays hung (unrouting would release it and the app would start by itself); the reload's
		// request is answered.
		hang = false;
		await failure.getByRole("button", { name: "Reload" }).click();
		await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
		await expect(bootFailure(page)).toHaveCount(0);
		expect(documents.count).toBe(2);
	});
});

test.describe("the session check", () => {
	test("a session check that fails once is retried and the inbox loads", async ({ page }) => {
		await openInbox(page);
		let requests = 0;
		await page.route(AUTH_ME, (route) =>
			requests++ === 0 ? route.fulfill({ status: 503, body: "{}" }) : route.continue(),
		);
		await page.reload();
		await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 15_000 });
		expect(requests).toBe(2);
		await expect(sessionFailure(page)).toHaveCount(0);
	});

	test("a session check that hangs times out, is retried and the inbox loads", async ({ page }) => {
		await openInbox(page);
		let requests = 0;
		await page.route(AUTH_ME, (route) => (requests++ === 0 ? undefined : route.continue()));
		await page.reload();
		// One 6-second timeout and a 1-second wait.
		await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 20_000 });
		expect(requests).toBe(2);
	});

	test("a session check that keeps hanging shows the error state after one shorter retry", async ({ page }) => {
		await openInbox(page);
		let requests = 0;
		await page.route(AUTH_ME, () => {
			requests += 1;
		});
		const started = Date.now();
		await page.reload();
		// 6 seconds, a 1-second wait and 4 seconds.
		await expect(sessionFailure(page)).toBeVisible({ timeout: 20_000 });
		expect(Date.now() - started).toBeLessThan(18_000);
		expect(requests).toBe(2);
	});

	test("a session check that keeps failing shows Try again, which loads the inbox once the server answers", async ({
		page,
	}) => {
		await openInbox(page);
		let requests = 0;
		await page.route(AUTH_ME, (route) => {
			requests += 1;
			return route.fulfill({ status: 503, body: "{}" });
		});
		await page.reload();
		const failure = sessionFailure(page);
		// Three attempts, 1 and 2 seconds apart.
		await expect(failure).toBeVisible({ timeout: 10_000 });
		expect(requests).toBe(3);
		await expect(page.getByRole("button", COMPOSE)).toHaveCount(0);

		await page.unroute(AUTH_ME);
		await failure.getByRole("button", { name: "Try again" }).click();
		await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 15_000 });
		await expect(failure).toHaveCount(0);
	});

	test("coming back online after a failed check tries again by itself", async ({ page }) => {
		await openInbox(page);
		await page.route(AUTH_ME, (route) => route.fulfill({ status: 503, body: "{}" }));
		await page.reload();
		await expect(sessionFailure(page)).toBeVisible({ timeout: 10_000 });

		await page.unroute(AUTH_ME);
		await page.evaluate(() => window.dispatchEvent(new Event("online")));
		await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 15_000 });
	});

	test("Continue anyway opens the app without a session, which arrives on the next focus", async ({ page }) => {
		await openInbox(page);
		await page.route(AUTH_ME, (route) => route.fulfill({ status: 503, body: "{}" }));
		await page.reload();
		await sessionFailure(page).getByRole("button", { name: "Continue anyway" }).click();
		await expect(page.getByRole("main")).toBeVisible();

		await page.unroute(AUTH_ME);
		const answered = page.waitForResponse((response) => response.url().endsWith("/api/auth/me"));
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		expect((await answered).status()).toBe(200);
		await expect(page.getByRole("button", COMPOSE)).toBeVisible();
		await expect(sessionFailure(page)).toHaveCount(0);
	});

	test("a signed-out answer still goes to the sign-in page", async ({ page }) => {
		await openInbox(page);
		await page.route(AUTH_ME, (route) => route.fulfill({ status: 401, body: '{"error":"Unauthorized"}' }));
		await page.reload();
		await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
		await expect(sessionFailure(page)).toHaveCount(0);
	});
});

test("failing branding and a hanging migrations check do not hold the inbox", async ({ page }) => {
	await openInbox(page);
	await page.route("**/api/branding", (route) => route.fulfill({ status: 503, body: "{}" }));
	await page.route("**/api/migrations/pending", () => undefined);
	await page.reload();
	// The startup screen waits for running requests at most 10 seconds once the session is known.
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("[data-loading-overlay][role=status]")).toHaveCount(0);
});

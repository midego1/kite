import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext } from "./support/helpers";

const MESSAGE = "Kite was updated. Reload to get the latest version.";

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "wait" });
});

/** Answers `/api/version` with whatever `version.current` holds and counts the requests. */
async function routeVersion(page: Page, initial: string) {
	const version = { current: initial, requests: 0 };
	await page.route("**/api/version", async (route) => {
		version.requests += 1;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			headers: { "Cache-Control": "no-store" },
			body: JSON.stringify({ version: version.current }),
		});
	});
	return version;
}

/** Moves past the focus throttle, then returns to the tab the way a user would. */
async function returnToTab(page: Page, version: { requests: number }) {
	const before = version.requests;
	await page.clock.fastForward("01:01");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => version.requests).toBeGreaterThan(before);
}

function updateToast(page: Page) {
	return page.getByRole("status").filter({ hasText: MESSAGE });
}

async function openInbox(page: Page, version: { requests: number }) {
	await page.clock.install();
	await page.goto("/inbox");
	await expect(page.getByRole("main")).toBeVisible();
	await expect.poll(() => version.requests).toBeGreaterThan(0);
}

test("the server's version is only given to a signed-in user and is never cached", async () => {
	const api = await apiContext(STORAGE_STATE);
	const anonymous = await apiContext();
	try {
		const response = await api.get("/api/version");
		expect(response.status()).toBe(200);
		expect(response.headers()["cache-control"]).toBe("no-store");
		const body = (await response.json()) as { version: unknown };
		expect(typeof body.version).toBe("string");
		expect(body.version).not.toBe("");
		const again = (await (await api.get("/api/version")).json()) as { version: unknown };
		expect(again.version).toBe(body.version);

		const refused = await anonymous.get("/api/version");
		expect(refused.status()).toBe(401);
		expect(refused.headers()["cache-control"]).toBe("no-store");
	} finally {
		await api.dispose();
		await anonymous.dispose();
	}
});

test("no toast on the first load or while the version stays the same", async ({ page }) => {
	const version = await routeVersion(page, "deploy-1");
	await openInbox(page, version);
	await returnToTab(page, version);
	await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
	await expect(updateToast(page)).toHaveCount(0);
});

test("a new deployment shows the toast once, and Reload reloads the page", async ({ page }) => {
	const version = await routeVersion(page, "deploy-1");
	await openInbox(page, version);
	await expect(updateToast(page)).toHaveCount(0);

	version.current = "deploy-2";
	await returnToTab(page, version);
	const toast = updateToast(page);
	await expect(toast).toBeVisible();
	await expect(toast.getByRole("button", { name: "Reload" })).toBeVisible();
	await expect(toast.getByRole("button", { name: "Dismiss" })).toBeVisible();

	// Once shown, the tab stops asking and never stacks a second toast.
	const shownAt = version.requests;
	await page.clock.fastForward("06:00");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(updateToast(page)).toHaveCount(1);
	expect(version.requests).toBe(shownAt);

	await page.evaluate(() => {
		(window as unknown as { __beforeReload?: boolean }).__beforeReload = true;
	});
	await Promise.all([page.waitForEvent("load"), toast.getByRole("button", { name: "Reload" }).click()]);
	await expect(page.getByRole("main")).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { __beforeReload?: boolean }).__beforeReload)).toBe(undefined);
	// The reloaded tab runs the new version, so it starts from it and shows nothing.
	await expect.poll(() => version.requests).toBeGreaterThan(shownAt);
	await expect(updateToast(page)).toHaveCount(0);
});

test("Dismiss hides the toast for the rest of the tab's life", async ({ page }) => {
	const version = await routeVersion(page, "deploy-1");
	await openInbox(page, version);
	version.current = "deploy-2";
	await returnToTab(page, version);
	const toast = updateToast(page);
	await expect(toast).toBeVisible();

	await toast.getByRole("button", { name: "Dismiss" }).click();
	await expect(updateToast(page)).toHaveCount(0);

	version.current = "deploy-3";
	await page.clock.fastForward("06:00");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(updateToast(page)).toHaveCount(0);
});

test("an unknown version and failed checks never show the toast", async ({ page }) => {
	const version = await routeVersion(page, "");
	await openInbox(page, version);
	version.current = "deploy-1";
	await returnToTab(page, version);
	await expect(updateToast(page)).toHaveCount(0);

	await page.unroute("**/api/version");
	let failures = 0;
	await page.route("**/api/version", async (route) => {
		failures += 1;
		await route.abort("failed");
	});
	await page.clock.fastForward("01:01");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => failures).toBeGreaterThan(0);
	await expect(updateToast(page)).toHaveCount(0);
});

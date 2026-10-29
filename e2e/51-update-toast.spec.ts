import { expect, test, type Page } from "@playwright/test";
import { ADMIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { contrastBetween } from "./support/contrast";
import { apiContext, deliverInbound, signIn, uniqueToken, waitForHydration } from "./support/helpers";

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

/**
 * Answers the app's entry module with a 404 while `failing()` holds, as a Cloudflare location still on the previous
 * deployment does for the new deployment's chunks. Under `vite dev` the entry is the vite-rsc browser entry (each
 * page requests it more than once); a production build names it `/_next/static/chunks/index-<hash>.js`.
 */
async function failEntryModule(page: Page, failing: () => boolean) {
	const entry = { failed: 0 };
	await page.route(
		(url) => url.pathname.endsWith("/entry-browser"),
		async (route) => {
			if (!failing()) return route.continue();
			entry.failed += 1;
			await route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" });
		},
	);
	return entry;
}

function countDocumentLoads(page: Page) {
	const documents = { count: 0 };
	page.on("request", (request) => {
		if (request.resourceType() === "document" && request.frame() === page.mainFrame()) documents.count += 1;
	});
	return documents;
}

function setMarker(page: Page) {
	return page.evaluate(() => {
		(window as unknown as { __sameDocument?: boolean }).__sameDocument = true;
	});
}

function readMarker(page: Page) {
	return page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument);
}

test("a chunk of the previous deployment that is gone shows the toast, and Reload loads the new one even before its files reach every location", async ({
	page,
}) => {
	const version = await routeVersion(page, "deploy-1");
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible();
	await expect.poll(() => version.requests).toBeGreaterThan(0);
	const documents = countDocumentLoads(page);

	// The open tab lazily loads a chunk the new deployment no longer has: it checks the version at once and offers
	// a reload, without reloading under the user. A production build's preload helper reports the failed import as
	// `vite:preloadError`; doing the same here keeps an unhandled rejection from opening the dev error overlay.
	version.current = "deploy-2";
	await setMarker(page);
	await page.evaluate(async () => {
		try {
			await import(`/_next/static/chunks/removed-${Date.now()}.js`);
		} catch (error) {
			window.dispatchEvent(Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: error }));
		}
	});
	const toast = updateToast(page);
	await expect(toast).toBeVisible();
	// Longer than the wait before the first automatic reload.
	await page.waitForTimeout(1_500);
	expect(await readMarker(page)).toBe(true);
	expect(documents.count).toBe(0);

	// The first two loads get the new page but not its files; it used to stay on "Loading" until a manual refresh.
	const entry = await failEntryModule(page, () => documents.count <= 2);
	await toast.getByRole("button", { name: "Reload" }).click();
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 30_000 });
	expect(entry.failed).toBeGreaterThanOrEqual(2);
	expect(documents.count).toBe(3);
	expect(await readMarker(page)).toBe(undefined);
	// Once the app has rendered, the reload count starts over.
	await expect.poll(() => page.evaluate(() => sessionStorage.getItem("kite:asset-reload"))).toBeNull();
	await expect(updateToast(page)).toHaveCount(0);
});

test("files that never load stop the automatic reloads after four tries", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible();
	const documents = countDocumentLoads(page);
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});

	await failEntryModule(page, () => true);
	await page.reload();
	// The first load plus four automatic reloads, 1 + 2 + 4 + 8 seconds apart.
	await expect.poll(() => documents.count, { timeout: 60_000 }).toBe(5);
	await expect.poll(() => errors.some((text) => text.includes("could not be loaded after 4 reloads"))).toBe(true);
	// Instead of the startup screen forever, a static message with a Reload button (no React).
	await expect(page.getByRole("alert").filter({ hasText: "Kite couldn't load." })).toBeVisible();
	// Longer than the longest wait: no fifth reload follows.
	await page.waitForTimeout(9_000);
	expect(documents.count).toBe(5);

	await page.unroute((url) => url.pathname.endsWith("/entry-browser"));
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

test.describe("session changes", () => {
	// Signing out must not revoke the session shared by the other specs.
	test.use({ storageState: { cookies: [], origins: [] } });

	test("Dismiss stays in effect after signing out and back in", async ({ page }) => {
		const version = await routeVersion(page, "deploy-1");
		await signIn(page, ADMIN.email, ADMIN.password);
		await expect(page).toHaveURL(/\/inbox/);
		await openInbox(page, version);
		version.current = "deploy-2";
		await returnToTab(page, version);
		await expect(updateToast(page)).toBeVisible();
		await updateToast(page).getByRole("button", { name: "Dismiss" }).click();
		await expect(updateToast(page)).toHaveCount(0);
		const shownAt = version.requests;

		await page.evaluate(() => {
			(window as unknown as { __sameTab?: boolean }).__sameTab = true;
		});
		await page.getByRole("button", { name: "Open account menu" }).click();
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page).toHaveURL(/\/login/);
		await expect(updateToast(page)).toHaveCount(0);

		version.current = "deploy-3";
		// Submit the existing page rather than navigating, which would reset the host.
		await waitForHydration(page);
		await page.getByLabel("Email").fill(ADMIN.email);
		await page.getByLabel("Password").fill(ADMIN.password);
		await page.getByRole("button", { name: "Sign in" }).click();
		await expect(page).toHaveURL(/\/inbox/);
		await expect(page.getByRole("main")).toBeVisible();
		expect(await page.evaluate(() => (window as unknown as { __sameTab?: boolean }).__sameTab)).toBe(true);

		await page.clock.fastForward("06:00");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(updateToast(page)).toHaveCount(0);
		expect(version.requests).toBe(shownAt);
	});
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

const LOOKS = [
	{ label: "Kite dark", theme: "dark", classic: false },
	{ label: "Classic dark", theme: "dark", classic: true },
	{ label: "Kite light", theme: "light", classic: false },
	{ label: "Classic light", theme: "light", classic: true },
] as const;

for (const look of LOOKS) {
	test(`${look.label}: the update toast follows the theme and Reload is readable`, async ({ page }) => {
		await page.addInitScript(({ theme, classic }) => {
			localStorage.setItem("kite-theme", theme);
			if (classic) localStorage.setItem("kite-style", "classic");
			else localStorage.removeItem("kite-style");
		}, look);
		const version = await routeVersion(page, "deploy-1");
		await openInbox(page, version);
		version.current = "deploy-2";
		await returnToTab(page, version);
		const toast = updateToast(page);
		await expect(toast).toBeVisible();

		// react-hot-toast paints the card inline; it must use the theme's card colour, not its own white.
		const card = toast.locator("xpath=ancestor-or-self::*[contains(@style, 'background')][1]");
		const background = await card.evaluate((element) => getComputedStyle(element).backgroundColor);
		if (look.theme === "dark") expect(background).not.toBe("rgb(255, 255, 255)");
		else expect(background).toBe("rgb(255, 255, 255)");

		expect(await contrastBetween(toast.getByText(MESSAGE), card), `${look.label} message`).toBeGreaterThanOrEqual(4.5);
		const reload = toast.getByRole("button", { name: "Reload" });
		expect(await contrastBetween(reload), `${look.label} Reload label`).toBeGreaterThanOrEqual(4.5);
		// The button is its own fill, clearly apart from the card behind it, not text floating on it.
		const fill = await reload.evaluate((element) => getComputedStyle(element).backgroundColor);
		expect(fill).not.toBe(background);
		const dismiss = toast.getByRole("button", { name: "Dismiss" });
		expect(await contrastBetween(dismiss, card), `${look.label} Dismiss`).toBeGreaterThanOrEqual(3);
	});
}

test("toasts never cover the reader's reply box, in the bottom-right corner on desktop and phones", async ({
	page,
}) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Toast position ${uniqueToken()}`;
	try {
		const message = await deliverInbound(api, {
			from: `"Toast Sender" <toast@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject,
		});
		const version = await routeVersion(page, "deploy-1");
		await page.clock.install();
		for (const size of [
			{ width: 1400, height: 900 },
			{ width: 1100, height: 700 },
			{ width: 390, height: 780 },
		]) {
			await page.setViewportSize(size);
			await page.goto(`/inbox/${message.id}`);
			const replyBox = page.locator("[data-reply-box]");
			await expect(replyBox).toBeVisible();
			await expect.poll(() => version.requests).toBeGreaterThan(0);
			version.current = `deploy-${size.width}`;
			await returnToTab(page, version);
			const toast = updateToast(page);
			await expect(toast).toBeVisible();
			const label = `${size.width}px`;
			// The toast slides in, so wait for it to settle before measuring.
			await expect
				.poll(
					async () => {
						const box = (await toast.boundingBox())!;
						const reply = (await replyBox.boundingBox())!;
						return { above: box.y + box.height <= reply.y, inside: box.x + box.width <= size.width };
					},
					{ message: `${label}: above the reply box and inside the viewport` },
				)
				.toEqual({ above: true, inside: true });
			const toastBox = (await toast.boundingBox())!;
			expect(toastBox.y + toastBox.height, `${label}: at the bottom`).toBeGreaterThan(size.height / 2);
			// The reply box still takes a click through where the toast would have been.
			await expect(replyBox).toBeEnabled();
			await toast.getByRole("button", { name: "Dismiss" }).click();
			await expect(toast).toHaveCount(0);
		}
	} finally {
		await api.dispose();
	}
});

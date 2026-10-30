import { expect, test, type Page } from "@playwright/test";

const MESSAGE = "Kite was updated. Reload to get the latest version.";
const FLIGHT = "[data-reload-flight]";
const ANNOUNCEMENT = "Reloading…";

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "ignoreErrors" });
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

/** Opens the inbox on one version, then lets the tab learn about a newer one the way a user returning to it would. */
async function showUpdateToast(page: Page) {
	const version = await routeVersion(page, "deploy-1");
	await page.clock.install();
	await page.goto("/inbox");
	await expect(page.getByRole("main")).toBeVisible();
	await expect.poll(() => version.requests).toBeGreaterThan(0);
	version.current = "deploy-2";
	const before = version.requests;
	await page.clock.fastForward("01:01");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => version.requests).toBeGreaterThan(before);
	const toast = page.getByRole("status").filter({ hasText: MESSAGE });
	await expect(toast).toBeVisible();
	return toast;
}

/**
 * The page on its way out cannot be inspected once the reload is under way, so an init script reports what it sees
 * through a binding: `seen` whenever the flight scene is in the page and `announced` when the live region speaks.
 */
async function watchOutgoingPage(page: Page) {
	const events: string[] = [];
	await page.exposeBinding("__reportReload", (_source, event: string) => {
		events.push(event);
	});
	await page.addInitScript(
		({ selector, announcement }) => {
			const report = (window as unknown as { __reportReload: (event: string) => void }).__reportReload;
			let announced = false;
			new MutationObserver(() => {
				if (document.querySelector(selector)) report("seen");
				const status = [...document.querySelectorAll('[aria-live="assertive"]')].some(
					(element) => element.textContent === announcement,
				);
				if (status && !announced) {
					announced = true;
					report("announced");
				}
			}).observe(document, { childList: true, subtree: true, characterData: true });
		},
		{ selector: FLIGHT, announcement: ANNOUNCEMENT },
	);
	return events;
}

/** Resolves with the moment the reload's document request leaves the tab. */
function reloadRequest(page: Page) {
	return page
		.waitForRequest(
			(request) =>
				request.resourceType() === "document" &&
				request.frame() === page.mainFrame() &&
				new URL(request.url()).pathname === "/inbox",
			{ timeout: 10_000 },
		)
		.then(() => Date.now());
}

/** Clicks Reload and returns how long the reload took to start. The click must not wait on the navigation it starts. */
async function clickReload(page: Page, toast: ReturnType<Page["getByRole"]>) {
	const loaded = page.waitForEvent("load");
	const requested = reloadRequest(page);
	const startedAt = Date.now();
	await toast.getByRole("button", { name: "Reload" }).click({ noWaitAfter: true });
	return { startedAt, requested, loaded };
}

test("Reload in the update notice flies the kite away, announces the reload and then reloads the page", async ({
	page,
}) => {
	const events = await watchOutgoingPage(page);
	const toast = await showUpdateToast(page);
	const { startedAt, requested, loaded } = await clickReload(page, toast);

	// One round trip while the kite is still in the air: the scene is a decoration above everything (toasts sit at
	// 9999), out of the accessibility tree, with the kite's own animation running and the reload announced beside it.
	const scene = await page.waitForSelector(FLIGHT, { state: "attached", timeout: 2_000 });
	const seen = await scene.evaluate((element, announcement) => {
		const kite = element.querySelector("svg");
		return {
			ariaHidden: element.getAttribute("aria-hidden"),
			zIndex: Number(getComputedStyle(element).zIndex),
			coversViewport:
				element.getBoundingClientRect().width >= window.innerWidth &&
				element.getBoundingClientRect().height >= window.innerHeight,
			kiteAnimation: kite ? getComputedStyle(kite).animationName : "",
			announced: [...document.querySelectorAll('[aria-live="assertive"]')].some(
				(node) => node.textContent === announcement,
			),
		};
	}, ANNOUNCEMENT);
	expect(seen.ariaHidden).toBe("true");
	expect(seen.zIndex).toBeGreaterThan(9999);
	expect(seen.coversViewport).toBe(true);
	expect(seen.kiteAnimation).toBe("reload-flight-kite");
	expect(seen.announced).toBe(true);

	// The reload follows the flight: not before it has had its say, and never later than the fallback.
	const elapsed = (await requested) - startedAt;
	expect(elapsed, "reload after the flight").toBeGreaterThanOrEqual(500);
	expect(elapsed, "reload within 1.5 s").toBeLessThan(2_500);

	await loaded;
	// The reloaded tab boots as before and runs the new version, so there is no scene and no notice.
	await expect(page.getByRole("main")).toBeVisible();
	await expect(page.locator(FLIGHT)).toHaveCount(0);
	await expect(page.getByRole("status").filter({ hasText: MESSAGE })).toHaveCount(0);
	expect(events).toContain("seen");
	expect(events).toContain("announced");
});

test("with reduced motion, Reload reloads at once without the flight", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const events = await watchOutgoingPage(page);
	const toast = await showUpdateToast(page);
	const { startedAt, requested, loaded } = await clickReload(page, toast);

	expect((await requested) - startedAt, "an immediate reload").toBeLessThan(1_000);
	await loaded;
	await expect(page.getByRole("main")).toBeVisible();
	// The outgoing page announced the reload (so its observer was watching) but never drew the scene.
	expect(events).toContain("announced");
	expect(events).not.toContain("seen");
});

test("the reload never waits on the animation: with animations disabled the fallback timer reloads", async ({
	page,
}) => {
	const toast = await showUpdateToast(page);
	// No `animationend` will ever fire.
	await page.addStyleTag({ content: `${FLIGHT}, ${FLIGHT} * { animation: none !important; }` });
	const { startedAt, requested, loaded } = await clickReload(page, toast);

	await page.waitForSelector(FLIGHT, { state: "attached", timeout: 2_000 });
	expect((await requested) - startedAt, "the fallback reload").toBeLessThan(3_000);
	await loaded;
	await expect(page.getByRole("main")).toBeVisible();
});

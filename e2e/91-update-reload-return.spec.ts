import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";

const MESSAGE = "Kite was updated. Reload to get the latest version.";
const MARKER_KEY = "kite-reload-flight";
const RETURN_CLASS = "kite-reload-return";
const SCENE = "[data-reload-return]";
const OVERLAY = "[data-loading-overlay]";
const ANNOUNCEMENT = "Loading the new version…";
const STATIC_TEXT = "Updating Kite…";

/** Set to a directory to save frames of the startup screen there (the PR's). */
const SHOT_DIR = process.env.RETURN_SHOT_DIR;

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

/** Opens a page on one version, then lets the tab learn about a newer one the way a user returning to it would. */
async function showUpdateToast(page: Page, path = "/settings/account") {
	const version = await routeVersion(page, "deploy-1");
	await page.clock.install();
	await page.goto(path);
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
 * Holds the app's entry module (under `vite dev` the vite-rsc browser entry, requested more than once per page)
 * until `release()`, so the server-rendered startup screen stays up with React not yet running: what a slow
 * connection shows after a deploy. The stylesheet is a `<link>` of its own, so the screen is styled meanwhile.
 */
async function holdEntryModule(page: Page) {
	const held: Route[] = [];
	let holding = true;
	await page.route(
		(url) => url.pathname.endsWith("/entry-browser"),
		async (route) => {
			if (!holding) return route.continue();
			held.push(route);
		},
	);
	return {
		held,
		release: async () => {
			holding = false;
			await Promise.all(held.splice(0).map((route) => route.continue()));
		},
	};
}

/** Writes the marker the way `reloadToNewVersion` does, `ageMs` before the page loads. */
function markReturn(page: Page, ageMs = 0) {
	return page.addInitScript(
		({ key, ageMs }) => {
			if (sessionStorage.getItem("e2e-return-marked")) return;
			sessionStorage.setItem("e2e-return-marked", "1");
			sessionStorage.setItem(key, String(Date.now() - ageMs));
		},
		{ key: MARKER_KEY, ageMs },
	);
}

/** What the startup screen shows while the entry module is held. */
function readScreen(page: Page) {
	return page.evaluate(
		({ scene: sceneSelector, overlay: overlaySelector, announcement, staticText }) => {
			const html = document.documentElement;
			const overlay = document.querySelector(overlaySelector)!;
			const scene = overlay.querySelector(sceneSelector)!;
			const kite = scene.querySelector("svg")!;
			const rect = kite.getBoundingClientRect();
			const animationOf = (selector: string) => getComputedStyle(scene.querySelector(selector)!).animationName;
			const displayOf = (element: Element | null) => (element ? getComputedStyle(element).display : "missing");
			const spans = [...overlay.querySelectorAll("span.sr-only")];
			const statusLine = [...overlay.querySelectorAll("p")].find((p) => p.textContent === staticText) ?? null;
			return {
				returnClass: html.classList.contains("kite-reload-return"),
				sceneDisplay: getComputedStyle(scene).display,
				arrive: animationOf(".reload-return-arrive"),
				swing: animationOf(".reload-return-swing"),
				bob: getComputedStyle(kite).animationName,
				tail: animationOf(".reload-return-tail"),
				wind: displayOf(scene.querySelector(".reload-return-wind")),
				kiteOnScreen: rect.width > 40 && rect.height > 40,
				// Once it has arrived (1.3 s), the kite hangs inside the viewport.
				kiteInViewport:
					rect.top >= 0 && rect.left >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
				// The boot watchdog's "Kite couldn't load" box sits 80 px below the middle: the kite stays above it.
				kiteAboveFailureBox: rect.bottom <= window.innerHeight / 2 + 80,
				logoDisplay: displayOf(overlay.querySelector("img")),
				role: overlay.getAttribute("role"),
				// The live region says what is happening; the plain "Loading" is not in the tree.
				announced: spans.some((span) => span.textContent === announcement && getComputedStyle(span).display !== "none"),
				plainLoading: spans.some((span) => span.textContent === "Loading" && getComputedStyle(span).display !== "none"),
				staticTextDisplay: displayOf(statusLine),
				background: getComputedStyle(overlay).backgroundColor,
				loaderMounted: (window as unknown as { __kiteLoaderMounted?: boolean }).__kiteLoaderMounted === true,
				marker: sessionStorage.getItem("kite-reload-flight"),
			};
		},
		{ scene: SCENE, overlay: OVERLAY, announcement: ANNOUNCEMENT, staticText: STATIC_TEXT },
	);
}

/** Counts the DOM nodes added or removed anywhere in the document over `ms`: what the boot watchdog calls progress. */
function countMutations(page: Page, ms: number) {
	return page.evaluate(
		(ms) =>
			new Promise<number>((resolve) => {
				let records = 0;
				const observer = new MutationObserver((list) => {
					records += list.length;
				});
				observer.observe(document, { childList: true, subtree: true });
				setTimeout(() => {
					observer.disconnect();
					resolve(records);
				}, ms);
			}),
		ms,
	);
}

async function shot(page: Page, name: string) {
	if (!SHOT_DIR) return;
	mkdirSync(SHOT_DIR, { recursive: true });
	await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

/** Waits for the reloaded document's startup screen while React is held back. */
async function waitForReturnScreen(page: Page) {
	await page.waitForSelector(`html.${RETURN_CLASS}`, { state: "attached", timeout: 20_000 });
	await page.waitForSelector(`${OVERLAY}[role="status"]`, { state: "attached", timeout: 20_000 });
}

test("Reload in the update notice brings the kite back on the loading screen, which gives way to the app", async ({
	page,
}) => {
	const toast = await showUpdateToast(page);
	const entry = await holdEntryModule(page);
	const loaded = page.waitForEvent("load", { timeout: 60_000 });
	await toast.getByRole("button", { name: "Reload" }).click({ noWaitAfter: true });

	// The new document paints the kite's return before any of its scripts arrived.
	await waitForReturnScreen(page);
	await expect.poll(() => entry.held.length).toBeGreaterThan(0);
	await shot(page, "return-arriving");
	const screen = await readScreen(page);
	expect(screen.returnClass).toBe(true);
	expect(screen.sceneDisplay).toBe("block");
	expect(screen.arrive).toBe("reload-return-arrive");
	expect(screen.swing).toBe("reload-return-swing");
	expect(screen.bob).toBe("reload-return-bob");
	expect(screen.tail).toBe("reload-return-tail");
	expect(screen.wind).toBe("block");
	expect(screen.kiteOnScreen).toBe(true);
	expect(screen.logoDisplay).toBe("none");
	expect(screen.role).toBe("status");
	expect(screen.announced).toBe(true);
	expect(screen.plainLoading).toBe(false);
	expect(screen.staticTextDisplay).toBe("none");
	expect(screen.loaderMounted).toBe(false);
	expect(screen.marker).not.toBeNull();

	// Still the server's screen as far as the boot watchdog is concerned, and nothing it could take for progress:
	// the scene moves by CSS alone and adds no nodes while the entry is held.
	await page.waitForFunction(() => document.readyState !== "loading");
	expect(await countMutations(page, 1_500)).toBe(0);
	await shot(page, "return-floating");
	const floating = await readScreen(page);
	expect(floating.loaderMounted).toBe(false);
	expect(floating.kiteInViewport).toBe(true);
	expect(floating.kiteAboveFailureBox).toBe(true);

	// The app arrives: the screen fades out into it, the scene stops and the marker is gone.
	await entry.release();
	await loaded;
	await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
	await expect(page.locator(OVERLAY)).not.toHaveClass(/opacity-100/);
	await expect(page.locator("html")).not.toHaveClass(new RegExp(`\\b${RETURN_CLASS}\\b`));
	await expect(page.locator(SCENE)).toBeHidden();
	await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), MARKER_KEY)).toBeNull();
	await expect(page.getByRole("status").filter({ hasText: MESSAGE })).toHaveCount(0);
	await shot(page, "return-app");
});

test("an ordinary load shows the plain loading screen", async ({ page }) => {
	const entry = await holdEntryModule(page);
	const loaded = page.waitForEvent("load", { timeout: 60_000 });
	await page.goto("/inbox", { waitUntil: "commit" });
	await page.waitForSelector(`${OVERLAY}[role="status"]`, { state: "attached", timeout: 20_000 });
	await expect.poll(() => entry.held.length).toBeGreaterThan(0);
	await shot(page, "plain-loading");
	const screen = await readScreen(page);
	expect(screen.returnClass).toBe(false);
	expect(screen.sceneDisplay).toBe("none");
	expect(screen.logoDisplay).toBe("block");
	expect(screen.plainLoading).toBe(true);
	expect(screen.announced).toBe(false);
	expect(screen.marker).toBeNull();
	await entry.release();
	await loaded;
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 30_000 });
});

test("with reduced motion the kite stands still and the screen says Updating Kite…", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await markReturn(page);
	const entry = await holdEntryModule(page);
	const loaded = page.waitForEvent("load", { timeout: 60_000 });
	await page.goto("/inbox", { waitUntil: "commit" });
	await waitForReturnScreen(page);
	await shot(page, "return-reduced-motion");
	const screen = await readScreen(page);
	expect(screen.returnClass).toBe(true);
	expect(screen.sceneDisplay).toBe("block");
	expect(screen.kiteOnScreen).toBe(true);
	expect([screen.arrive, screen.swing, screen.bob, screen.tail]).toEqual(["none", "none", "none", "none"]);
	expect(screen.wind).toBe("none");
	expect(screen.staticTextDisplay).toBe("block");
	expect(screen.announced).toBe(true);
	await expect(page.getByText(STATIC_TEXT)).toBeVisible();
	await entry.release();
	await loaded;
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator("html")).not.toHaveClass(new RegExp(`\\b${RETURN_CLASS}\\b`));
});

test("a marker older than a minute is dropped and the plain screen shows", async ({ page }) => {
	await markReturn(page, 61_000);
	const entry = await holdEntryModule(page);
	const loaded = page.waitForEvent("load", { timeout: 60_000 });
	await page.goto("/inbox", { waitUntil: "commit" });
	await page.waitForSelector(`${OVERLAY}[role="status"]`, { state: "attached", timeout: 20_000 });
	const screen = await readScreen(page);
	expect(screen.returnClass).toBe(false);
	expect(screen.sceneDisplay).toBe("none");
	expect(screen.marker).toBeNull();
	await entry.release();
	await loaded;
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 30_000 });
});

const LOOKS = [
	{ label: "Kite dark", theme: "dark", style: "kite", viewport: { width: 1400, height: 900 } },
	{ label: "Kite light", theme: "light", style: "kite", viewport: { width: 1400, height: 900 } },
	{ label: "Kite classic dark", theme: "dark", style: "lavender", viewport: { width: 1400, height: 900 } },
	{ label: "Classic light phone", theme: "light", style: "classic", viewport: { width: 390, height: 844 } },
] as const;

for (const look of LOOKS) {
	test(`${look.label}: the screen follows the theme and the kite fits`, async ({ page }) => {
		await page.setViewportSize(look.viewport);
		await page.addInitScript(
			({ theme, style }) => {
				localStorage.setItem("kite-theme", theme);
				localStorage.setItem("kite-style", style);
			},
			{ theme: look.theme, style: look.style },
		);
		await markReturn(page);
		const entry = await holdEntryModule(page);
		const loaded = page.waitForEvent("load", { timeout: 60_000 });
		await page.goto("/inbox", { waitUntil: "commit" });
		await waitForReturnScreen(page);
		// Past the kite's arrival, so the frame shows it floating.
		await page.waitForTimeout(1_500);
		await shot(page, `return-${look.label.toLowerCase().replaceAll(" ", "-")}`);
		const screen = await readScreen(page);
		expect(screen.kiteInViewport).toBe(true);
		expect(screen.kiteAboveFailureBox).toBe(true);
		// Dark themes get a dark screen (the plain screen is always light); light ones stay light.
		const [r, g, b] = screen.background.match(/\d+/g)!.map(Number);
		if (look.theme === "dark") expect(r + g + b).toBeLessThan(200);
		else expect(r + g + b).toBeGreaterThan(700);
		await entry.release();
		await loaded;
		// The phone shows one pane without the desktop's Compose button; the main landmark is on both.
		await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
	});
}

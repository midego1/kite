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
			// A request of a document that was reloaded meanwhile cannot be continued any more.
			await Promise.all(held.splice(0).map((route) => route.continue().catch(() => undefined)));
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
				// The string ends at the hand just above the progress bar and never crosses it.
				kiteAboveBar: rect.bottom <= overlay.querySelector(".reload-return-track")!.getBoundingClientRect().top,
				skyDisplay: displayOf(overlay.querySelector(".reload-return-sky")),
				// The bar's box anchors the kite and holds nothing else; the status line and the step log sit outside it.
				boxHoldsOnlyBar: !overlay
					.querySelector(".reload-return-track")!
					.parentElement!.querySelector("[data-startup-status], [data-startup-steps]"),
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
	// Consumed as it was read: this load shows the return, no later one does.
	expect(screen.marker).toBeNull();

	// Still the server's screen as far as the boot watchdog is concerned, and nothing it could take for progress:
	// the scene moves by CSS alone and adds no nodes while the entry is held.
	await page.waitForFunction(() => document.readyState !== "loading");
	expect(await countMutations(page, 1_500)).toBe(0);
	await shot(page, "return-floating");
	const floating = await readScreen(page);
	expect(floating.loaderMounted).toBe(false);
	expect(floating.kiteInViewport).toBe(true);
	expect(floating.kiteAboveFailureBox).toBe(true);
	expect(floating.kiteAboveBar).toBe(true);
	expect(floating.boxHoldsOnlyBar).toBe(true);
	expect(floating.skyDisplay).toBe("block");

	// When the boot watchdog gives up it adds its "Kite couldn't load" box (asset-recovery-utils.ts); the scene
	// steps aside for it and the box's text keeps the theme's colour on the theme's background.
	await page.evaluate(() => {
		const box = document.createElement("div");
		box.id = "kite-boot-failure";
		box.setAttribute("role", "alert");
		box.textContent = "Kite couldn't load.";
		box.style.cssText = "position:fixed;left:50%;top:calc(50% + 80px);transform:translateX(-50%);z-index:110";
		document.body.appendChild(box);
	});
	await expect(page.locator(`${SCENE} svg`)).toBeHidden();
	await expect(page.locator(".reload-return-sky")).toBeHidden();
	const boxColours = await page.evaluate(() => {
		const box = document.getElementById("kite-boot-failure")!;
		const overlay = document.querySelector("[data-loading-overlay]")!;
		return { text: getComputedStyle(box).color, background: getComputedStyle(overlay).backgroundColor };
	});
	const sum = (colour: string) =>
		colour
			.match(/\d+/g)!
			.slice(0, 3)
			.reduce((total, part) => total + Number(part), 0);
	// Light text on the dark overlay (the default theme is dark).
	expect(sum(boxColours.text)).toBeGreaterThan(600);
	expect(sum(boxColours.background)).toBeLessThan(200);
	await page.evaluate(() => document.getElementById("kite-boot-failure")!.remove());
	await expect(page.locator(`${SCENE} svg`)).toBeVisible();

	// The app arrives: the screen fades out into it, the scene stops and the marker is gone.
	await entry.release();
	await loaded;
	await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
	await expect(page.locator(OVERLAY)).not.toHaveClass(/opacity-100/);
	await expect(page.locator("html")).not.toHaveClass(new RegExp(`\\b${RETURN_CLASS}\\b`));
	await expect(page.locator(`${SCENE} svg`)).toBeHidden();
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
	// The caption sits below the bar without moving it: the string still ends above the bar.
	expect(screen.kiteAboveBar).toBe(true);
	const caption = page.getByText(STATIC_TEXT);
	await expect(caption).toBeVisible();
	const [captionBox, trackBox] = await Promise.all([
		caption.boundingBox(),
		page.locator(".reload-return-track").boundingBox(),
	]);
	expect(captionBox!.y).toBeGreaterThanOrEqual(trackBox!.y + trackBox!.height);
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

/** Counts the tab's document loads: the boot watchdog's reloads among them. */
function countDocumentLoads(page: Page) {
	const documents = { count: 0 };
	page.on("request", (request) => {
		if (request.resourceType() === "document" && request.frame() === page.mainFrame()) documents.count += 1;
	});
	return documents;
}

const hasReturnClass = (page: Page) =>
	page.evaluate((name) => document.documentElement.classList.contains(name), RETURN_CLASS);

test("the return shows once: refreshing /inbox while it loads gives the plain screen, then the app", async ({
	page,
}) => {
	await markReturn(page);
	const entry = await holdEntryModule(page);
	await page.goto("/inbox", { waitUntil: "commit" });
	await waitForReturnScreen(page);
	expect(await page.evaluate((key) => sessionStorage.getItem(key), MARKER_KEY)).toBeNull();

	// Startup is slow and the user refreshes (F5) within the minute: an ordinary load, not the kite again.
	const loaded = page.waitForEvent("load", { timeout: 60_000 });
	await page.reload({ waitUntil: "commit" });
	await page.waitForSelector(`${OVERLAY}[role="status"]`, { state: "attached", timeout: 20_000 });
	expect(await hasReturnClass(page)).toBe(false);
	await entry.release();
	await loaded;
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator(OVERLAY)).not.toHaveClass(/opacity-100/);
});

test("without the marker a refresh of /inbox loads the app with the plain screen", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 30_000 });
	await page.reload();
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 30_000 });
	expect(await hasReturnClass(page)).toBe(false);
	await expect(page.locator(OVERLAY)).not.toHaveClass(/opacity-100/);
});

test("the scene is cosmetic: a startup that never finishes drops it by itself and reaches Kite couldn't load", async ({
	page,
}) => {
	// Three loads of the server's screen: two boot-watchdog reloads (vite dev waits up to 30 and 15 quiet seconds),
	// then the message.
	test.setTimeout(180_000);
	await markReturn(page);
	const documents = countDocumentLoads(page);
	// The entry never arrives, on this load or the watchdog's reloads: React never starts.
	await holdEntryModule(page);
	await page.goto("/inbox", { waitUntil: "commit" });
	await waitForReturnScreen(page);
	// The scene has a hard cap of its own: the plain screen takes over well before the watchdog acts.
	await expect.poll(() => hasReturnClass(page), { timeout: 12_000 }).toBe(false);
	await expect(page.locator(`${SCENE} svg`)).toBeHidden();
	expect(documents.count).toBe(1);

	// The watchdog's reload starts plainly too, and its "Kite couldn't load" is the way out.
	await expect.poll(() => documents.count, { timeout: 60_000 }).toBeGreaterThan(1);
	await page.waitForSelector(`${OVERLAY}[role="status"]`, { state: "attached", timeout: 20_000 });
	expect(await hasReturnClass(page)).toBe(false);
	const failure = page.getByRole("alert").filter({ hasText: "Kite couldn't load." });
	await expect(failure).toBeVisible({ timeout: 90_000 });
	expect(await hasReturnClass(page)).toBe(false);
});

/**
 * Keeps the session check open for good (the request timeout itself never fires, as in e2e/18), so React runs the
 * startup screen and it never finishes: what a start that hangs after React took over looks like.
 */
async function hangSessionCheck(page: Page) {
	await page.addInitScript(() => {
		AbortSignal.timeout = () => new AbortController().signal;
	});
	await page.route("**/api/auth/me", () => undefined);
}

test("a start that hangs after React took over offers Reload Kite with Details from the boot trace", async ({
	page,
}) => {
	test.setTimeout(90_000);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	// The previous load of this tab froze in its first render: its heartbeat stopped while visible.
	await page.addInitScript((key) => {
		if (sessionStorage.getItem("e2e-trace-seeded")) return;
		sessionStorage.setItem("e2e-trace-seeded", "1");
		const phases = [
			{ p: "inline", t: 40 },
			{ p: "loader-mounted", t: 900 },
			{ p: "auth-ready", t: 1_000 },
		];
		sessionStorage.setItem(
			key,
			JSON.stringify({ v: 1, phases, mounts: 1, beat: 1_100, visibleMs: 1_000, visible: true }),
		);
	}, "kite-boot-trace");
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await hangSessionCheck(page);
	await page.goto("/inbox?view=private", { waitUntil: "commit" });
	await page.waitForSelector(`${OVERLAY}[role="status"]`, { state: "attached", timeout: 20_000 });
	await expect.poll(() => errors).toContain("[kite] previous load froze at phase auth-ready after 1100 ms");
	// Visible time, counted from the screen's first mount.
	const reload = page.getByRole("button", { name: "Reload Kite" });
	await expect(reload).toBeVisible({ timeout: 25_000 });
	const recovery = page.locator(".loading-recovery");
	await recovery.getByText("Details", { exact: true }).click();
	const details = recovery.locator("[data-boot-details]");
	await expect(details).toBeVisible();
	await expect(details).toContainText("Previous load froze at auth-ready after 1.1 s");
	await shot(page, "hang-details");
	await expect(details).toContainText("Phase: loader-mounted");
	await expect(details).toContainText("Loader mounted: yes");
	await expect(details).toContainText(/In flight: [^\n]*\/api\/auth\/me/);
	// No query strings: neither the page's nor a request's.
	await expect(details).not.toContainText("private");
	await recovery.getByRole("button", { name: "Copy details" }).click();
	await expect(recovery.getByRole("button", { name: "Copied" })).toBeVisible();
	const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
	expect(copied.phase).toBe("loader-mounted");
	expect(copied.previousLoad).toEqual({ phase: "auth-ready", afterMs: 1_100, visibleMs: 1_000 });
	expect(copied.inFlight.map((entry: { path: string }) => entry.path)).toContain("/api/auth/me");
	// The record survives in the tab for the next load, which finds this one stuck at the screen, not complete.
	const record = await page.evaluate(() => JSON.parse(sessionStorage.getItem("kite-boot-trace")!));
	expect(record.page).toBe("/inbox");
	expect(record.phases.map((entry: { p: string }) => entry.p)).not.toContain("complete");
	expect(record.visibleMs).toBeGreaterThan(10_000);
});

test("a startup screen that keeps being mounted again gets Kite couldn't load, even while it shows Reload Kite", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await hangSessionCheck(page);
	// Once React runs the screen, an element standing in for a remounting screen is replaced every 150 ms ahead of
	// React's own. It carries React's way out, so only the remount guard can call the screen stuck.
	await page.addInitScript(
		(overlay) => {
			const swap = () => {
				if (!(window as unknown as { __kiteLoaderMounted?: boolean }).__kiteLoaderMounted) return;
				document.querySelector("[data-e2e-remount]")?.remove();
				const fake = document.createElement("div");
				fake.setAttribute("data-e2e-remount", "");
				fake.setAttribute(overlay, "");
				fake.setAttribute("role", "status");
				fake.style.display = "none";
				const recovery = document.createElement("div");
				recovery.className = "loading-recovery";
				fake.appendChild(recovery);
				document.body.insertBefore(fake, document.body.firstChild);
			};
			setInterval(swap, 150);
		},
		OVERLAY.slice(1, -1),
	);
	await page.goto("/inbox", { waitUntil: "commit" });
	await page.waitForSelector(`${OVERLAY}[role="status"]`, { state: "attached", timeout: 20_000 });
	await expect(page.getByRole("button", { name: "Reload Kite" })).toBeVisible({ timeout: 25_000 });
	const failure = page.getByRole("alert").filter({ hasText: "Kite couldn't load." });
	await expect(failure).toBeVisible({ timeout: 30_000 });
	await expect(failure).toHaveAttribute("data-loader-stuck", "");
	await failure.getByText("Details", { exact: true }).click();
	const details = failure.locator("[data-boot-details]");
	await expect(details).toBeVisible();
	await expect(details).toContainText(/overlay remounts: ([3-9]|\d{2,})/);
	await shot(page, "remount-loop-details");
	await expect(failure.getByRole("button", { name: "Copy details" })).toBeVisible();
	// Its Reload starts over.
	const loaded = page.waitForEvent("load", { timeout: 30_000 });
	await failure.getByRole("button", { name: "Reload", exact: true }).click();
	await loaded;
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

test("a startup failure ends the return: the plain failure screen shows and the marker is gone", async ({ page }) => {
	await markReturn(page);
	await page.route("**/api/auth/me", (route) => route.abort("failed"));
	await page.goto("/inbox");
	const failure = page.getByRole("alert").filter({ hasText: "Kite couldn't check your sign-in." });
	await expect(failure).toBeVisible({ timeout: 15_000 });
	await expect(page.locator("html")).not.toHaveClass(new RegExp(`\\b${RETURN_CLASS}\\b`));
	await expect(page.locator(`${SCENE} svg`)).toBeHidden();
	await expect(page.locator(".reload-return-sky")).toBeHidden();
	await shot(page, "return-startup-failure");
	// The plain screen of the theme (dark by default: the dark theme remaps the screen's palette, so it is dark
	// too) with the failure's text readable on it.
	const colours = await page.evaluate(() => {
		const overlay = document.querySelector("[data-loading-overlay]")!;
		const alert = overlay.querySelector('[role="alert"] p')!;
		return { background: getComputedStyle(overlay).backgroundColor, text: getComputedStyle(alert).color };
	});
	const sum = (colour: string) =>
		colour
			.match(/\d+/g)!
			.slice(0, 3)
			.reduce((total, part) => total + Number(part), 0);
	expect(sum(colours.background)).toBeLessThan(200);
	expect(sum(colours.text)).toBeGreaterThan(600);
	expect(await page.evaluate((key) => sessionStorage.getItem(key), MARKER_KEY)).toBeNull();
	// Continue anyway opens the app without a replay.
	await page.unroute("**/api/auth/me");
	await failure.getByRole("button", { name: "Continue anyway" }).click();
	await expect(page.getByRole("main")).toBeVisible({ timeout: 15_000 });
});

test.describe("signed out", () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test("being sent to the sign-in page ends the return, so signing in within the minute loads plainly", async ({
		page,
	}) => {
		await markReturn(page);
		await page.goto("/inbox");
		await expect(page).toHaveURL(/\/login/);
		await expect(page.locator("html")).not.toHaveClass(new RegExp(`\\b${RETURN_CLASS}\\b`));
		await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), MARKER_KEY)).toBeNull();
		// A reload of the sign-in page within the minute is an ordinary load.
		await page.reload();
		await expect(page.locator("html")).not.toHaveClass(new RegExp(`\\b${RETURN_CLASS}\\b`));
	});
});

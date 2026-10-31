import { expect, test, type Page, type Route } from "@playwright/test";
import { RELEASE_VERSION } from "./support/constants";

// The startup screen's step log (src/components/startup-steps.tsx): five lines that fill in with real facts of
// this start as the app learns them, without a request of their own. The loader's recovery paths (the boot
// watchdog, Reload Kite, "Kite couldn't load") are covered by 18, 65 and 91 and stay untouched.

const COMPOSE = { name: "Compose new email", exact: true } as const;
const STEPS = "[data-startup-steps] > li[data-startup-step]";

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** Holds a request until `release()`; later requests of the same URL pass. */
async function hold(page: Page, url: string | ((url: URL) => boolean)) {
	const held: Route[] = [];
	let holding = true;
	await page.route(url, async (route) => {
		if (!holding) return route.continue();
		held.push(route);
	});
	return {
		held,
		release: async () => {
			holding = false;
			await Promise.all(held.splice(0).map((route) => route.continue().catch(() => undefined)));
		},
	};
}

function readSteps(page: Page) {
	return page.$$eval(STEPS, (items) =>
		items.map((item) => ({
			id: item.getAttribute("data-startup-step"),
			state: item.getAttribute("data-step-state"),
			tone: item.getAttribute("data-step-tone"),
			label: item.children[1]?.textContent ?? "",
			detail: item.children[2]?.textContent ?? "",
		})),
	);
}

test("the server's screen already lists the five steps, with the first one running", async ({ page }) => {
	const entry = await hold(page, (url) => url.pathname.endsWith("/entry-browser"));
	await page.goto("/inbox", { waitUntil: "commit" });
	await page.waitForSelector('[data-loading-overlay][role="status"]', { state: "attached", timeout: 20_000 });
	await expect.poll(() => entry.held.length).toBeGreaterThan(0);
	const steps = await readSteps(page);
	expect(steps.map((step) => step.id)).toEqual(["load", "session", "database", "mail", "ready"]);
	expect(steps.map((step) => step.state)).toEqual(["running", "todo", "todo", "todo", "todo"]);
	expect(steps[0].label).toBe(`Loading Kite v${RELEASE_VERSION}`);
	expect(steps[0].detail).toMatch(/^[a-f0-9]{7}$/);
	await expect(page.locator("[data-startup-step-counter]")).toHaveText("STEP 1/5");
	await entry.release();
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
});

test("the steps fill in with the facts of this start while the session check runs, then the screen gives way", async ({
	page,
}) => {
	const session = await hold(page, "**/api/auth/me");
	await page.goto("/inbox");
	await expect.poll(() => session.held.length).toBeGreaterThan(0);

	// React runs the screen: the load line is done, the session line runs, the database and ready lines wait for
	// it. The mail line may already be done: the app badge reads the counts before the session check answers.
	await expect(page.locator(`${STEPS}[data-startup-step="session"]`)).toHaveAttribute("data-step-state", "running");
	let steps = await readSteps(page);
	expect(steps.map((step) => step.state).filter((_, index) => index !== 3)).toEqual([
		"done",
		"running",
		"todo",
		"todo",
	]);
	expect(["todo", "done"]).toContain(steps[3].state);
	expect(steps[0].detail).toMatch(/^[a-f0-9]{7}$/);
	expect(steps[1].label).toBe("Signing you in…");
	await expect(page.locator("[data-startup-status]")).toHaveText("Signing you in…");
	await expect(page.locator("[data-startup-step-counter]")).toHaveText("STEP 2/5");

	await session.release();
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	await expect(page.locator("[data-loading-overlay]")).not.toHaveClass(/opacity-100/);
	// The screen completed: every line done, the session named, the database and mail lines carrying real facts.
	await expect(page.locator(`${STEPS}[data-startup-step="ready"]`)).toHaveAttribute("data-step-state", "done");
	steps = await readSteps(page);
	expect(steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done"]);
	expect(steps[1].label).toBe("Signed in");
	expect(steps[1].detail).toBe("Demo User");
	expect(steps[2].detail).toBe("Up to date");
	expect(steps[3].detail).toMatch(/^\d+ mailbox(es)? · \d+ unread$/);
	expect(steps[4].detail).toMatch(/^\d+\.\d s$/);
	await expect(page.locator("[data-startup-step-counter]")).toHaveText("STEP 5/5");
});

test("database updates waiting are named on the database line, as a warning", async ({ page }) => {
	await page.route("**/api/migrations/pending", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pending: 2 }) }),
	);
	await page.goto("/inbox");
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	const database = page.locator(`${STEPS}[data-startup-step="database"]`);
	await expect(database).toHaveAttribute("data-step-state", "done");
	await expect(database).toHaveAttribute("data-step-tone", "warn");
	await expect(database).toContainText("2 updates waiting");
});

test("a failed session check shows the failure instead of the steps, and Continue anyway opens the app", async ({
	page,
}) => {
	await page.route("**/api/auth/me", (route) => route.abort("failed"));
	await page.goto("/inbox");
	const failure = page.getByRole("alert").filter({ hasText: "Kite couldn't check your sign-in." });
	await expect(failure).toBeVisible({ timeout: 15_000 });
	await expect(page.locator("[data-startup-steps]")).toHaveCount(0);
	await failure.getByRole("button", { name: "Continue anyway" }).click();
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 15_000 });
});

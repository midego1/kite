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

type StepSnapshot = { id: string | null; state: string | null; tone: string | null; label: string; detail: string }[];

/**
 * The step log leaves the page with the startup screen, right after the last line is done, so what it ended on
 * is kept by an observer installed before the page loads: `window.__kiteStepLog` is the last snapshot taken.
 */
function trackSteps(page: Page) {
	return page.addInitScript(() => {
		const snapshot = () => {
			const list = document.querySelector("[data-startup-steps]");
			if (!list) return;
			(window as unknown as { __kiteStepLog?: unknown }).__kiteStepLog = {
				steps: [...list.querySelectorAll("li[data-startup-step]")].map((item) => ({
					id: item.getAttribute("data-startup-step"),
					state: item.getAttribute("data-step-state"),
					tone: item.getAttribute("data-step-tone"),
					label: item.children[1]?.textContent ?? "",
					detail: item.children[2]?.textContent ?? "",
				})),
				counter: list.querySelector("[data-startup-step-counter]")?.textContent ?? "",
			};
		};
		new MutationObserver(snapshot).observe(document, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});
	});
}

function lastSteps(page: Page) {
	return page.evaluate(
		() => (window as unknown as { __kiteStepLog?: { steps: StepSnapshot; counter: string } }).__kiteStepLog,
	);
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
	await trackSteps(page);
	const session = await hold(page, "**/api/auth/me");
	await page.goto("/inbox");
	await expect.poll(() => session.held.length).toBeGreaterThan(0);

	// React runs the screen: the load line is done, the session line runs, the database and ready lines wait for
	// it. The mail line may already be done: the app badge reads the counts before the session check answers.
	await expect(page.locator(`${STEPS}[data-startup-step="session"]`)).toHaveAttribute("data-step-state", "running");
	const steps = await readSteps(page);
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
	// The screen completed and left: its last state had every line done, the session named, the database and
	// mail lines carrying real facts, and the counter at the end.
	await expect(page.locator("[data-startup-steps]")).toHaveCount(0);
	const last = await lastSteps(page);
	expect(last).toBeTruthy();
	expect(last!.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done"]);
	expect(last!.steps[1].label).toBe("Signed in");
	expect(last!.steps[1].detail).toBe("Demo User");
	expect(last!.steps[2].detail).toBe("Up to date");
	expect(last!.steps[3].detail).toMatch(/^\d+ mailbox(es)? · \d+ unread$/);
	expect(last!.steps[4].detail).toMatch(/^\d+\.\d s$/);
	expect(last!.counter).toBe("STEP 5/5");
});

test("database updates waiting are named on the database line, as a warning", async ({ page }) => {
	await trackSteps(page);
	await page.route("**/api/migrations/pending", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pending: 2 }) }),
	);
	await page.goto("/inbox");
	await expect(page.getByRole("button", COMPOSE)).toBeVisible({ timeout: 30_000 });
	await expect(page.locator("[data-startup-steps]")).toHaveCount(0);
	const database = (await lastSteps(page))?.steps.find((step) => step.id === "database");
	expect(database?.state).toBe("done");
	expect(database?.tone).toBe("warn");
	expect(database?.detail).toBe("2 updates waiting");
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

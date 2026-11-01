import { expect, test, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, setSendingSettings, uniqueToken } from "./support/helpers";

// Sending closes the composer; the undo-send bar outlives it and Undo opens the held message again. While a composer
// is open (another one, opened during the hold) the bar must keep clear of it, in every composer mode and size.

const RECIPIENT = "receiver@e2e.test";

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box) {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function box(locator: Locator): Promise<Box> {
	const found = await locator.boundingBox();
	if (!found) throw new Error("element has no box");
	return found;
}

/** The floating composer, docked or expanded. */
function popup(page: Page) {
	return page
		.getByRole("region", { name: "Compose message" })
		.or(page.getByRole("dialog", { name: "Compose message" }));
}

function undoBar(page: Page) {
	return page.getByRole("status").filter({ hasText: /Sending in \d+s/ });
}

async function openComposer(page: Page) {
	const phone = (page.viewportSize()?.width ?? 0) < 768;
	// Below md the sidebar is a sheet that slides over the page from the menu button.
	if (phone) await page.getByRole("button", { name: "Open menu" }).click();
	await page.getByRole("button", { name: "Compose" }).click();
	await expect(popup(page).getByLabel("To", { exact: true })).toBeAttached();
	if (phone) await page.getByRole("button", { name: "Close menu" }).click();
	await expect(page.getByRole("button", { name: "Close menu" })).toBeHidden();
	await expect(popup(page).getByLabel("To", { exact: true })).toBeVisible();
}

/** Fills the floating composer and sends it; returns the subject. */
async function fillAndSend(page: Page) {
	const composer = popup(page);
	const to = composer.getByLabel("To", { exact: true });
	await to.fill(RECIPIENT);
	await to.press("Enter");
	await expect(composer.getByRole("button", { name: `Remove ${RECIPIENT}` })).toBeVisible();
	const subject = `Placement ${uniqueToken()}`;
	await composer.getByLabel("Subject").fill(subject);
	await composer.getByRole("textbox", { name: "Message body" }).fill("Where does the undo bar go?");
	await composer.getByRole("button", { name: "Send", exact: true }).click();
	// The composer is hidden while the request runs and closed once the bar has taken over.
	await expect(undoBar(page)).toBeVisible();
	await expect(popup(page)).toHaveCount(0);
	return subject;
}

/** The bar is inside the viewport, wide enough to read, clear of every box, and its Undo button is on top. */
async function expectBarClear(page: Page, others: Locator[]) {
	const bar = undoBar(page);
	await expect(bar).toBeVisible();
	const barBox = await box(bar);
	const viewport = page.viewportSize()!;
	expect(barBox.x).toBeGreaterThanOrEqual(0);
	expect(barBox.y).toBeGreaterThanOrEqual(0);
	expect(barBox.x + barBox.width).toBeLessThanOrEqual(viewport.width);
	expect(barBox.y + barBox.height).toBeLessThanOrEqual(viewport.height);
	expect(barBox.width, "bar collapsed").toBeGreaterThanOrEqual(Math.min(320, viewport.width - 32));

	for (const frame of others) {
		// The whole composer first, then each control in it (the footer holds Send, formatting, attach and Write with Kite).
		expect(overlaps(barBox, await box(frame)), "bar over the composer").toBe(false);
		for (const control of await frame.locator("button, input, [contenteditable='true']").all()) {
			if (!(await control.isVisible())) continue;
			const html = await control.evaluate((el) => el.outerHTML.slice(0, 80));
			expect(overlaps(barBox, await box(control)), `bar over ${html}`).toBe(false);
		}
	}

	const undo = bar.getByRole("button", { name: "Undo" });
	const undoBox = await box(undo);
	const topmostIsUndo = await page.evaluate(
		({ x, y }) => !!document.elementFromPoint(x, y)?.closest("[role='status'] button"),
		{ x: undoBox.x + undoBox.width / 2, y: undoBox.y + undoBox.height / 2 },
	);
	expect(topmostIsUndo, "Undo is covered").toBe(true);
}

const SIZES = [
	{ name: "desktop", width: 1700, height: 900 },
	{ name: "laptop", width: 1100, height: 700 },
	{ name: "phone", width: 390, height: 844 },
];

test.describe("the undo-send bar", () => {
	test.beforeAll(async () => {
		const api = await apiContext(STORAGE_STATE);
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 30 });
		await api.dispose();
	});
	test.afterAll(async () => {
		const api = await apiContext(STORAGE_STATE);
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
		await api.dispose();
	});

	for (const mode of ["docked", "expanded"] as const) {
		test(`closes the ${mode} composer on Send, and Undo opens it again with the message`, async ({ page }) => {
			await page.setViewportSize({ width: 1700, height: 900 });
			await page.goto("/inbox");
			await openComposer(page);
			if (mode === "expanded") await page.getByRole("button", { name: "Open composer as modal" }).click();
			const subject = await fillAndSend(page);

			await expect(popup(page)).toHaveCount(0);
			const bar = undoBar(page);
			await expect(bar).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.hasAttribute("data-composer"))).toBe(false);
			// Bottom right, where notices live when nothing is open.
			const barBox = await box(bar);
			expect(barBox.x + barBox.width).toBeGreaterThan(1700 - 64);
			expect(barBox.y + barBox.height).toBeGreaterThan(900 - 160);

			await bar.getByRole("button", { name: "Undo" }).click();
			await expect(page.getByText("Sending undone")).toBeVisible();
			const composer = popup(page);
			await expect(composer.getByLabel("Subject")).toHaveValue(subject);
			await expect(composer.getByRole("button", { name: `Remove ${RECIPIENT}` })).toBeVisible();
			await expect(composer.getByRole("textbox", { name: "Message body" })).toContainText(
				"Where does the undo bar go?",
			);
			await expect(bar).toBeHidden();
		});
	}

	test("sending from the Compose page leaves it, and Undo opens the message in the composer", async ({ page }) => {
		await page.setViewportSize({ width: 1700, height: 900 });
		await page.goto("/compose");
		const to = page.getByLabel("To", { exact: true });
		await to.fill(RECIPIENT);
		await to.press("Enter");
		const subject = `Placement ${uniqueToken()}`;
		await page.getByLabel("Subject").fill(subject);
		await page.getByRole("textbox", { name: "Message body" }).fill("From the full page");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(page).toHaveURL(/\/sent/);
		const bar = undoBar(page);
		await expect(bar).toBeVisible();
		await bar.getByRole("button", { name: "Undo" }).click();
		await expect(popup(page).getByLabel("Subject")).toHaveValue(subject);
		await expect(popup(page).getByRole("textbox", { name: "Message body" })).toContainText("From the full page");
	});

	test("the bar also shows in the settings and admin shells", async ({ page }) => {
		await page.setViewportSize({ width: 1700, height: 900 });
		await page.goto("/settings/composing");
		await openComposer(page);
		const subject = await fillAndSend(page);
		await undoBar(page).getByRole("button", { name: "Undo" }).click();
		await expect(popup(page).getByLabel("Subject")).toHaveValue(subject);
	});

	test("Send now still works after the composer closed", async ({ page }) => {
		await page.setViewportSize({ width: 1700, height: 900 });
		await page.goto("/inbox");
		await openComposer(page);
		await fillAndSend(page);
		await expect(popup(page)).toHaveCount(0);
		const bar = undoBar(page);
		await expect(bar).toBeVisible();
		await bar.getByRole("button", { name: "Send now" }).click();
		await expect(bar).toBeHidden();
		await expect(popup(page)).toHaveCount(0);
	});

	for (const size of SIZES) {
		test.describe(`with another composer open, ${size.name}`, () => {
			test.use({ viewport: { width: size.width, height: size.height } });

			test("docked", async ({ page }) => {
				await page.goto("/inbox");
				await openComposer(page);
				await fillAndSend(page);
				await openComposer(page);
				await expectBarClear(page, [popup(page)]);
			});

			test("expanded", async ({ page }) => {
				await page.goto("/inbox");
				await openComposer(page);
				await fillAndSend(page);
				await openComposer(page);
				await page.getByRole("button", { name: "Open composer as modal" }).click();
				await expectBarClear(page, [popup(page)]);
			});

			test("minimized", async ({ page }) => {
				await page.goto("/inbox");
				await openComposer(page);
				await fillAndSend(page);
				await openComposer(page);
				await page.getByRole("button", { name: "Minimize composer" }).click();
				await expectBarClear(page, [popup(page)]);
			});

			test("compose page", async ({ page }) => {
				await page.goto("/compose");
				await openComposer(page);
				await fillAndSend(page);
				const card = page.locator("form").filter({ has: page.getByLabel("Subject") });
				await expectBarClear(page, [card]);
			});
		});
	}

	test.describe("compose page with a short window", () => {
		test.use({ viewport: { width: 1100, height: 560 } });

		test("the card's footer stays clear at every scroll position", async ({ page }) => {
			await page.goto("/compose");
			await openComposer(page);
			await fillAndSend(page);
			const card = page.locator("form").filter({ has: page.getByLabel("Subject") });
			await expectBarClear(page, [card]);
			const scroller = page.locator("div.overflow-auto").filter({ has: card }).first();
			for (const top of [0, 10_000]) {
				await scroller.evaluate((el, value) => el.scrollTo(0, value), top);
				await expectBarClear(page, [card]);
			}
		});
	});

	test.describe("docked beside the open assistant", () => {
		test.use({ viewport: { width: 1500, height: 900 } });

		test("the bar clears both the composer and the assistant window", async ({ page }) => {
			const api = await apiContext(STORAGE_STATE);
			const before = (await (await api.get("/api/admin/agent")).json()) as { assistantEnabled: boolean };
			expect((await api.put("/api/admin/agent", { data: { enabled: true } })).ok()).toBe(true);
			try {
				await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
				await page.goto("/inbox");
				const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
				await expect(toggle).toBeVisible();
				if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();

				await openComposer(page);
				await fillAndSend(page);
				await openComposer(page);
				await page.getByRole("button", { name: "Open email assistant" }).click();
				await page.getByRole("button", { name: "Restore composer" }).click();
				const panel = page.locator("#email-assistant-panel");
				await expect(panel).toBeVisible();
				await expectBarClear(page, [popup(page), panel]);
				await page.getByRole("button", { name: "Close composer" }).click();
			} finally {
				await api.put("/api/admin/agent", { data: { enabled: before.assistantEnabled } });
				await api.dispose();
			}
		});
	});
});

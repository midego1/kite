import { expect, test, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, setSendingSettings, uniqueToken } from "./support/helpers";

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

async function openComposer(page: Page) {
	const compose = page.getByRole("button", { name: "Compose" });
	const phone = (page.viewportSize()?.width ?? 0) < 768;
	// Below md the sidebar is a sheet that slides over the page from the menu button.
	if (phone) await page.getByRole("button", { name: "Open menu" }).click();
	await compose.click();
	await expect(page.getByLabel("To", { exact: true })).toBeAttached();
	// The sheet stays over the composer until it is closed.
	if (phone) await page.getByRole("button", { name: "Close menu" }).click();
	await expect(page.getByRole("button", { name: "Close menu" })).toBeHidden();
	await expect(page.getByLabel("To", { exact: true })).toBeVisible();
}

async function fillAndSend(page: Page) {
	const to = page.getByLabel("To", { exact: true });
	await to.fill(RECIPIENT);
	await to.press("Enter");
	await expect(page.getByRole("button", { name: `Remove ${RECIPIENT}` })).toBeVisible();
	await page.getByLabel("Subject").fill(`Placement ${uniqueToken()}`);
	await page.getByRole("textbox", { name: "Message body" }).fill("Where does the undo bar go?");
	await page.getByRole("button", { name: "Send", exact: true }).click();
}

/** The bar clears every box of the composer, and its Undo button is the topmost element at its centre. */
async function expectBarClear(page: Page, frame: Locator) {
	const bar = page.getByRole("status").filter({ hasText: /Sending in \d+s/ });
	await expect(bar).toBeVisible();
	const barBox = await box(bar);
	const viewport = page.viewportSize()!;
	expect(barBox.x).toBeGreaterThanOrEqual(0);
	expect(barBox.y).toBeGreaterThanOrEqual(0);
	expect(barBox.x + barBox.width).toBeLessThanOrEqual(viewport.width);
	expect(barBox.y + barBox.height).toBeLessThanOrEqual(viewport.height);

	// The whole composer first, then each control in it (the footer holds Send, formatting, attach and Write with Kite).
	expect(overlaps(barBox, await box(frame)), "bar over the composer").toBe(false);
	for (const control of await frame.locator("button, input, [contenteditable='true']").all()) {
		if (!(await control.isVisible())) continue;
		expect(
			overlaps(barBox, await box(control)),
			`bar over ${await control.evaluate((el) => el.outerHTML.slice(0, 80))}`,
		).toBe(false);
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

test.describe("the undo-send bar stays clear of the composer", () => {
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

	for (const size of SIZES) {
		test.describe(size.name, () => {
			test.use({ viewport: { width: size.width, height: size.height } });

			test("floating composer", async ({ page }) => {
				await page.goto("/inbox");
				await openComposer(page);
				await fillAndSend(page);
				await expectBarClear(page, page.getByRole("region", { name: "Compose message" }));
			});

			test("expanded composer", async ({ page }) => {
				await page.goto("/inbox");
				await openComposer(page);
				await page.getByRole("button", { name: "Open composer as modal" }).click();
				await fillAndSend(page);
				await expectBarClear(page, page.getByRole("dialog", { name: "Compose message" }));
			});

			test("minimized composer", async ({ page }) => {
				await page.goto("/inbox");
				await openComposer(page);
				await fillAndSend(page);
				await page.getByRole("button", { name: "Minimize composer" }).click();
				await expectBarClear(page, page.getByRole("region", { name: "Compose message" }));
			});

			test("compose page", async ({ page }) => {
				await page.goto("/compose");
				await fillAndSend(page);
				await expectBarClear(page, page.locator("form").filter({ has: page.getByLabel("Subject") }));
			});
		});
	}
});

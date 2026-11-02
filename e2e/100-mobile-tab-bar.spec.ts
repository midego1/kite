import { expect, test, type Page } from "@playwright/test";
import { openMessage } from "./support/helpers";

// The phone tab bar: Mail, the modules that are on, and More (the full mail menu), in the space the
// section pill used to own. It folds away for the reader and Compose and returns from md up to the sidebar.

function primaryNav(page: Page) {
	return page.getByRole("navigation", { name: "Primary" });
}

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("the bar follows the section and More opens the mail menu", async ({ page }) => {
		await page.goto("/inbox");
		const bar = primaryNav(page);
		await expect(bar).toBeVisible();
		await expect(bar.getByRole("link", { name: /^Mail/ })).toHaveAttribute("aria-current", "page");
		for (const label of ["Calendar", "Drive", "Money"]) {
			await expect(bar.getByRole("link", { name: label, exact: true })).toBeVisible();
		}

		await bar.getByRole("link", { name: "Calendar", exact: true }).click();
		await expect(page).toHaveURL(/\/calendar$/);
		await expect(bar.getByRole("link", { name: "Calendar", exact: true })).toHaveAttribute("aria-current", "page");

		await bar.getByRole("link", { name: "Drive", exact: true }).click();
		await expect(page).toHaveURL(/\/drive$/);
		await expect(bar.getByRole("link", { name: "Drive", exact: true })).toHaveAttribute("aria-current", "page");

		await bar.getByRole("link", { name: "Money", exact: true }).click();
		await expect(page).toHaveURL(/\/finance$/);
		await expect(bar.getByRole("link", { name: "Money", exact: true })).toHaveAttribute("aria-current", "page");

		await bar.getByRole("button", { name: "More navigation" }).click();
		const menu = page.getByRole("dialog", { name: "Menu" });
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("link", { name: /^Inbox\b/ })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
	});

	test("opening a message and Compose hide the bar, and Back brings it back", async ({ page }) => {
		await page.goto("/inbox");
		await expect(primaryNav(page)).toBeVisible();

		await openMessage(page, "Cannot access workspace");
		await expect(primaryNav(page)).toHaveCount(0);

		await page.getByRole("button", { name: "Back to Inbox" }).click();
		await expect(page).toHaveURL(/\/inbox$/);
		await expect(primaryNav(page)).toBeVisible();

		await page.goto("/compose");
		await expect(primaryNav(page)).toHaveCount(0);
	});

	test("the floating composer hides the bar until it closes", async ({ page }) => {
		await page.goto("/inbox");
		await primaryNav(page).getByRole("button", { name: "More navigation" }).click();
		await page
			.getByRole("dialog", { name: "Menu" })
			.getByRole("button", { name: /^Compose/ })
			.click();
		await expect(primaryNav(page)).toHaveCount(0);

		await page.getByRole("button", { name: "Close composer" }).first().click();
		await expect(primaryNav(page)).toBeVisible();
	});

	test("the Settings pill sits above the bar instead of over it", async ({ page }) => {
		await page.goto("/settings/account");
		const bar = primaryNav(page);
		const pill = page.getByRole("button", { name: "My account", exact: true });
		await expect(bar).toBeVisible();
		await expect(pill).toBeVisible();
		const [pillBox, barBox] = await Promise.all([pill.boundingBox(), bar.boundingBox()]);
		expect(pillBox && barBox && pillBox.y + pillBox.height <= barBox.y).toBe(true);
	});
});

test("the bar folds away at the sidebar breakpoint and returns when the window narrows", async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 800 });
	await page.goto("/inbox");
	await expect(primaryNav(page)).toHaveCount(0);
	await expect(
		page
			.locator("aside")
			.first()
			.getByRole("link", { name: /^Inbox\b/ }),
	).toBeVisible();

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(primaryNav(page)).toBeVisible();
	await page.setViewportSize({ width: 1024, height: 800 });
	await expect(primaryNav(page)).toHaveCount(0);
});

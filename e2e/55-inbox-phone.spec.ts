import { expect, test } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// Below md the inbox shows one pane at a time: the list, or the open email with a back button. The sidebar
// is a sheet that slides over the page from the menu button.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

let subject: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	subject = `Phone pane ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Phone Sender" <phone@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Read on a phone.",
	});
	await api.dispose();
});

test("opening an email replaces the list, and Back returns to it", async ({ page }) => {
	await page.goto("/inbox");
	const list = page.getByRole("list", { name: "Inbox" });
	await expect(list.getByText(subject, { exact: true })).toBeVisible();
	await expect(page.locator("[data-reading-pane]")).toHaveCount(0);

	await list.getByText(subject, { exact: true }).click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByRole("list", { name: "Inbox" })).toHaveCount(0);
	// The reader's toolbar stays on one row on a phone.
	const toolbar = page.getByRole("button", { name: "More actions" });
	const back = page.getByRole("button", { name: "Back to Inbox" });
	expect(Math.abs((await toolbar.boundingBox())!.y - (await back.boundingBox())!.y)).toBeLessThan(4);
	await expect(page.getByRole("button", { name: /^Reply to Phone Sender/ })).toBeVisible();

	await back.click();
	await expect(page).toHaveURL(/\/inbox$/);
	await expect(page.getByRole("list", { name: "Inbox" }).getByText(subject, { exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toHaveCount(0);
});

test("the menu opens the sidebar as a sheet, which closes on navigation and on Escape", async ({ page }) => {
	await page.goto("/inbox");
	const menuButton = page.getByRole("button", { name: "Open menu" });
	await menuButton.click();
	const sheet = page.getByRole("dialog", { name: "Menu" });
	await expect(sheet).toBeVisible();
	await expect(page.locator("[data-mobile-menu]")).toHaveAttribute("aria-expanded", "true");
	await sheet.getByRole("link", { name: /^Starred\b/ }).click();
	await expect(page).toHaveURL(/\/starred$/);
	await expect(sheet).toHaveCount(0);

	await menuButton.click();
	await expect(sheet).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expect(menuButton).toBeFocused();

	await menuButton.click();
	await sheet.getByRole("button", { name: "Close menu" }).click();
	await expect(sheet).toHaveCount(0);
});

test("the list's search and category chips share the phone header without hiding the folder name", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("list", { name: "Inbox" }).getByText(subject, { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Primary", exact: true })).toBeVisible();
	await expect(page.getByRole("textbox", { name: /Search mail/ })).toBeVisible();
	const title = page.getByRole("main").locator("p", { hasText: /^Inbox$/ });
	await expect(title).toBeVisible();
	expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

// A touch screen never hovers, so a row's quick actions (archive, trash, mark read, snooze and the star) must
// not depend on it: they show as a static, always-on action bar under the row instead (message-list-row-actions.tsx).
test("a row's archive, trash, snooze and star are visible and at least 44px without hovering", async ({ page }) => {
	await page.goto("/inbox");
	const row = page.locator("[data-message-row]").filter({ hasText: subject });
	await expect(row).toBeVisible();

	for (const name of ["Archive", "Trash", "Snooze"]) {
		const button = row.getByRole("button", { name, exact: true });
		await expect(button).toBeVisible();
		const box = await button.boundingBox();
		expect(box && box.width >= 44 && box.height >= 44, `${name} is at least 44x44`).toBe(true);
	}
	// One accessible name in both states (message-row-parts.tsx); the pressed state carries whether it is starred.
	const star = row.getByRole("button", { name: "Star" }).first();
	await expect(star).toBeVisible();
	await expect(star).toHaveAttribute("aria-pressed", "false");
	const starBox = await star.boundingBox();
	expect(starBox && starBox.width >= 44 && starBox.height >= 44, "Star is at least 44x44").toBe(true);

	await star.click();
	await expect(star).toHaveAttribute("aria-pressed", "true");
});

// Upstream Mailflare review (docs/upstream/mailflare-review-2026-11-08.md #14): the reader's own toolbar row
// (Reply, Trash, Report spam, More) must not overflow the sticky header and push More off screen on a narrow
// phone — it scrolls inside itself instead (message-actions.tsx), and More stays pinned after it.
test("the reader toolbar's More trigger stays on screen on a small phone", async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 568 });
	await page.goto("/inbox");
	await page.getByRole("list", { name: "Inbox" }).getByText(subject, { exact: true }).click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();

	const more = page.getByRole("button", { name: "More actions" });
	await expect(more).toBeVisible();
	const box = await more.boundingBox();
	expect(box && box.x >= 0 && box.x + box.width <= 320, "More actions stays within the 320px viewport").toBe(true);

	await more.click();
	await expect(page.getByRole("button", { name: "Show original" })).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { contrastBetween } from "./support/contrast";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// "Kite was updated" is the first row of a message list, styled like mail but never part of it. Pages without a
// list keep the toast.

let subject: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	subject = `Update row ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Update Sender" <update-row@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Update row body.",
	});
	await api.dispose();
});

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "wait" });
});

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

/** Opens a page, then makes the next version check find a new deployment. */
async function announceNewVersion(page: Page, path: string) {
	const version = await routeVersion(page, "3f2a9c1e-7b4d-4e6a-9c1d-0123456789ab");
	await page.clock.install();
	await page.goto(path);
	await expect(page.getByRole("main")).toBeVisible();
	await expect.poll(() => version.requests).toBeGreaterThan(0);
	version.current = "9d8e7f60-1111-4222-8333-444455556666";
	const before = version.requests;
	await page.clock.fastForward("01:01");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => version.requests).toBeGreaterThan(before);
}

function row(page: Page) {
	return page.locator("[data-update-notice]");
}

function toast(page: Page) {
	return page.getByRole("status").filter({ hasText: "Kite was updated. Reload to get the latest version." });
}

test("the notice is the first row of the list, not a message", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	const notice = row(page);
	await expect(notice).toBeVisible();
	await expect(notice).toContainText("Kite");
	await expect(notice).toContainText("Kite was updated");
	await expect(notice).toContainText("Reload to get the latest version");
	await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();
	await expect(notice.getByRole("button", { name: "Dismiss" })).toBeAttached();
	// The list has a toast-free page and the notice sits above every message.
	await expect(toast(page)).toHaveCount(0);
	const first = page.locator("[data-message-row]").first();
	await expect(first).toBeVisible();
	const noticeBox = await notice.boundingBox();
	const firstBox = await first.boundingBox();
	expect(noticeBox!.y).toBeLessThan(firstBox!.y);
	await expect(notice.locator("[data-message-row]")).toHaveCount(0);
	await expect(notice.getByRole("checkbox")).toHaveCount(0);
	await page.screenshot({ path: test.info().outputPath("update-row.png") });
});

test("it is skipped by selection and the j/k keys", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await expect(row(page)).toBeVisible();
	const rows = page.locator("[data-message-row]");
	await expect(rows.first()).toBeVisible();
	const messageRows = await rows.count();
	expect(messageRows).toBeGreaterThan(0);
	// From the top, j lands on the first message, not on the notice.
	const firstId = await rows.first().getAttribute("data-message-row");
	await page.keyboard.press("j");
	await expect(page.locator("[data-message-row]:focus-within")).toHaveAttribute("data-message-row", firstId!);
	await page.keyboard.press("k");
	await page.keyboard.press("k");
	// k at the top stays on a message and never lands on the notice.
	expect(await page.evaluate(() => !!document.activeElement?.closest("[data-update-notice]"))).toBe(false);
	await expect(rows).toHaveCount(messageRows);
});

test("clicking the row itself does not reload, only Reload does", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await page.evaluate(() => {
		(window as unknown as { __beforeReload?: boolean }).__beforeReload = true;
	});
	await row(page).getByText("Kite was updated", { exact: true }).click();
	await page.waitForTimeout(500);
	expect(await page.evaluate(() => (window as unknown as { __beforeReload?: boolean }).__beforeReload)).toBe(true);
	await expect(row(page)).toBeVisible();
});

test("one live region announces the notice once, and the row has none of its own", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await expect(row(page)).toBeVisible();
	await expect(row(page).getByRole("status")).toHaveCount(0);
	const live = page.locator("[aria-live=polite]").filter({ hasText: "A new version of Kite is available." });
	await expect(live).toHaveCount(1);
	await row(page).getByRole("button", { name: "Dismiss" }).click();
	await expect(live).toHaveCount(0);
});

test("Drafts keep their wide rows, so the notice is wide there even on a phone", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 800 });
	await announceNewVersion(page, "/drafts");
	const notice = row(page);
	await expect(notice).toBeVisible();
	const subject = await notice.getByText("Kite was updated", { exact: true }).boundingBox();
	const preview = await notice.getByText(/Reload to get the latest version/).boundingBox();
	// Wide rows hold subject and preview on one line.
	expect(Math.abs(subject!.y - preview!.y)).toBeLessThan(6);
});

test("Reload reloads the page", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await page.evaluate(() => {
		(window as unknown as { __beforeReload?: boolean }).__beforeReload = true;
	});
	await Promise.all([page.waitForEvent("load"), row(page).getByRole("button", { name: "Reload" }).click()]);
	await expect(page.getByRole("main")).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { __beforeReload?: boolean }).__beforeReload)).toBe(undefined);
});

test("Dismiss hides the row, also when the list changes", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await row(page).getByRole("button", { name: "Dismiss" }).click();
	await expect(row(page)).toHaveCount(0);
	await expect(toast(page)).toHaveCount(0);
	await page.getByRole("link", { name: "Sent", exact: true }).first().click();
	await expect(page).toHaveURL(/\/sent/);
	await expect(row(page)).toHaveCount(0);
	await expect(toast(page)).toHaveCount(0);
});

test("the row follows the list across folders", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await expect(row(page)).toHaveCount(1);
	await page.getByRole("link", { name: "Sent", exact: true }).first().click();
	await expect(page).toHaveURL(/\/sent/);
	await expect(row(page)).toHaveCount(1);
});

test("a page without a message list keeps the toast", async ({ page }) => {
	await announceNewVersion(page, "/settings/account");
	await expect(toast(page)).toBeVisible();
	await expect(row(page)).toHaveCount(0);
});

test("on a phone the notice is a stacked row", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 800 });
	await announceNewVersion(page, "/inbox");
	const notice = row(page);
	await expect(notice).toBeVisible();
	await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();
	await expect(notice.getByRole("button", { name: "Dismiss" })).toBeVisible();
	await page.screenshot({ path: test.info().outputPath("update-row-phone.png") });
});

for (const look of [
	{ label: "light", theme: "light" },
	{ label: "dark", theme: "dark" },
]) {
	test(`${look.label}: the row's text, Reload and Dismiss are readable`, async ({ page }) => {
		await page.addInitScript((theme) => localStorage.setItem("kite-theme", theme), look.theme);
		await announceNewVersion(page, "/inbox");
		const notice = row(page);
		await expect(notice).toBeVisible();
		await expect(page.locator("[data-message-row]").first()).toBeVisible();
		expect(
			await contrastBetween(notice.getByText("Kite was updated"), notice),
			`${look.label} subject`,
		).toBeGreaterThanOrEqual(4.5);
		expect(
			await contrastBetween(notice.getByText(/Reload to get the latest/), notice),
			`${look.label} preview`,
		).toBeGreaterThanOrEqual(4.5);
		expect(
			await contrastBetween(notice.getByRole("button", { name: "Reload" })),
			`${look.label} Reload`,
		).toBeGreaterThanOrEqual(4.5);
		// The close button shows on hover and focus.
		await notice.hover();
		expect(
			await contrastBetween(notice.getByRole("button", { name: "Dismiss" }), notice),
			`${look.label} Dismiss`,
		).toBeGreaterThanOrEqual(3);
		await page.screenshot({ path: `test-results/screenshots/update-row-${look.label}.png` });
	});
}

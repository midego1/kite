import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS, VERSION_ROUTE } from "./support/constants";
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

type VersionAnswer = { current: string; requests: number; urls: string[]; details: Record<string, unknown> };

async function routeVersion(page: Page, initial: string) {
	const version: VersionAnswer = { current: initial, requests: 0, urls: [], details: {} };
	await page.route(VERSION_ROUTE, async (route) => {
		version.requests += 1;
		version.urls.push(route.request().url());
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			headers: { "Cache-Control": "no-store" },
			body: JSON.stringify({ version: version.current, ...version.details }),
		});
	});
	return version;
}

/** Opens a page, then makes the next version check find a new deployment (which may name its release and notes). */
async function announceNewVersion(page: Page, path: string, details: Record<string, unknown> = {}) {
	const version = await routeVersion(page, "3f2a9c1e-7b4d-4e6a-9c1d-0123456789ab");
	await page.clock.install();
	await page.goto(path);
	await expect(page.getByRole("main")).toBeVisible();
	await expect.poll(() => version.requests).toBeGreaterThan(0);
	version.current = "9d8e7f60-1111-4222-8333-444455556666";
	version.details = details;
	const before = version.requests;
	await page.clock.fastForward("01:01");
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => version.requests).toBeGreaterThan(before);
	return version;
}

function row(page: Page) {
	return page.locator("[data-update-notice]");
}

function reader(page: Page) {
	return page.locator("[data-update-reader]");
}

function toast(page: Page) {
	return page.getByRole("status").filter({ hasText: "Kite was updated. Reload to get the latest version." });
}

/** The row's own Reload and Dismiss show on hover, like a message's row actions. */
async function rowAction(page: Page, name: "Reload" | "Dismiss") {
	await row(page).hover();
	return row(page).getByRole("button", { name, exact: true });
}

function opener(page: Page) {
	return row(page).getByRole("button", { name: /Open what's new/ });
}

const NOTES = {
	release: "2099.01.01.0",
	notes: [
		{
			name: "2099.01.01.0",
			date: "2099-01-01",
			sections: [
				{ title: "Added", items: ["**Snooze** gets a [setting](/settings/inbox).", "A second note."] },
				{ title: "Fixed", items: ["Something `small`."] },
			],
		},
	],
};

test("the notice is the first row of the list, drawn like a message from Kite", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	const notice = row(page);
	await expect(notice).toBeVisible();
	await expect(notice).toContainText("Kite");
	await expect(notice).toContainText("Kite was updated");
	await expect(notice).toContainText("Reload to get the latest version");
	await expect(notice.locator("time")).toHaveCount(1);
	await expect(notice.locator("img")).toHaveCount(1);
	// Unread until opened, like new mail, and no tinted card at rest.
	await expect(opener(page)).toHaveAccessibleName(/^Unread, Kite was updated, from Kite/);
	expect(await notice.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
	await expect(await rowAction(page, "Reload")).toBeVisible();
	await expect(notice.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
	// The list has a toast-free page and the notice sits above every message.
	await expect(toast(page)).toHaveCount(0);
	const first = page.locator("[data-message-row]").first();
	await expect(first).toBeVisible();
	const noticeBox = await notice.boundingBox();
	const firstBox = await first.boundingBox();
	expect(noticeBox!.y).toBeLessThan(firstBox!.y);
	// Same row anatomy as the message beside it; the preview line makes it at most one line taller.
	expect(noticeBox!.height).toBeGreaterThanOrEqual(firstBox!.height - 2);
	expect(noticeBox!.height).toBeLessThan(firstBox!.height + 24);
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

test("clicking the row opens What's new in the reader, without reloading", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await page.evaluate(() => {
		(window as unknown as { __beforeReload?: boolean }).__beforeReload = true;
	});
	await row(page).getByText("Kite was updated", { exact: true }).click();
	const pane = reader(page);
	await expect(pane).toBeVisible();
	await expect(pane.getByRole("heading", { level: 1, name: "Kite was updated" })).toBeFocused();
	await expect(pane).toContainText("Kite");
	await expect(pane.locator("time")).toHaveCount(1);
	await expect(pane).toContainText("Reload to get the latest version.");
	await expect(pane.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
	await expect(pane.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
	// The opened row is marked as the open one and reads as read; nothing reloaded.
	await expect(opener(page)).toHaveAttribute("aria-current", "true");
	await expect(opener(page)).toHaveAccessibleName(/^Kite was updated, from Kite/);
	expect(await page.evaluate(() => (window as unknown as { __beforeReload?: boolean }).__beforeReload)).toBe(true);
	await expect(row(page)).toBeVisible();
	await page.screenshot({ path: test.info().outputPath("update-reader.png") });
});

test("a message opened afterwards takes the reader, and the notice opens over an open message", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await opener(page).click();
	await expect(reader(page)).toBeVisible();
	await page.locator("[data-message-row]").filter({ hasText: subject }).first().getByRole("link").first().click();
	await expect(page).toHaveURL(/\/inbox\/[^/]+$/);
	await expect(reader(page)).toHaveCount(0);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	// From an open message the row leaves it, as opening another message would.
	await opener(page).click();
	await expect(reader(page)).toBeVisible();
	await expect(page).toHaveURL(/\/inbox$/);
});

test("the new server's release and notes become the subject, preview and body", async ({ page }) => {
	const version = await announceNewVersion(page, "/inbox", NOTES);
	// The tab names its own build, so only a different server adds notes.
	expect(version.urls.every((url) => new URL(url).searchParams.has("have"))).toBe(true);
	const notice = row(page);
	await expect(notice).toContainText("Kite 2099.01.01.0 is ready");
	await expect(notice).toContainText("Reload to get the latest version · Snooze gets a setting.");
	await opener(page).click();
	const pane = reader(page);
	await expect(pane.getByRole("heading", { level: 1, name: "Kite 2099.01.01.0 is ready" })).toBeVisible();
	await expect(pane.getByRole("heading", { level: 2, name: /2099\.01\.01\.0/ })).toBeVisible();
	await expect(pane.getByRole("heading", { level: 3, name: "Fixed" })).toBeVisible();
	await expect(pane.getByRole("listitem").filter({ hasText: "A second note." })).toHaveCount(1);
	await page.screenshot({ path: test.info().outputPath("update-reader-notes.png") });
	// An app link in a note opens in the app and closes the reader.
	await pane.getByRole("link", { name: "setting" }).click();
	await expect(page).toHaveURL(/\/settings\/inbox/);
});

test("Reload in the row reloads the page", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await page.evaluate(() => {
		(window as unknown as { __beforeReload?: boolean }).__beforeReload = true;
	});
	await Promise.all([page.waitForEvent("load"), (await rowAction(page, "Reload")).click()]);
	await expect(page.getByRole("main")).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { __beforeReload?: boolean }).__beforeReload)).toBe(undefined);
});

test("Reload in the reader reloads the page", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await opener(page).click();
	await page.evaluate(() => {
		(window as unknown as { __beforeReload?: boolean }).__beforeReload = true;
	});
	await Promise.all([
		page.waitForEvent("load"),
		reader(page).getByRole("button", { name: "Reload", exact: true }).click(),
	]);
	await expect(page.getByRole("main")).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { __beforeReload?: boolean }).__beforeReload)).toBe(undefined);
});

test("one live region announces the notice once, and the row has none of its own", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await expect(row(page)).toBeVisible();
	await expect(row(page).getByRole("status")).toHaveCount(0);
	const live = page.locator("[aria-live=polite]").filter({ hasText: "A new version of Kite is available." });
	await expect(live).toHaveCount(1);
	await (await rowAction(page, "Dismiss")).click();
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
	// Drafts have no reader, so the row opens nothing there.
	await expect(opener(page)).toHaveCount(0);
});

test("Dismiss hides the row, also when the list changes", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await (await rowAction(page, "Dismiss")).click();
	await expect(row(page)).toHaveCount(0);
	await expect(toast(page)).toHaveCount(0);
	await page.getByRole("link", { name: "Sent", exact: true }).first().click();
	await expect(page).toHaveURL(/\/sent/);
	await expect(row(page)).toHaveCount(0);
	await expect(toast(page)).toHaveCount(0);
});

test("Dismiss in the reader closes it and hides the row", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await opener(page).click();
	await reader(page).getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(reader(page)).toHaveCount(0);
	await expect(row(page)).toHaveCount(0);
	await expect(toast(page)).toHaveCount(0);
	await expect(page.getByTestId("reading-pane-empty")).toBeVisible();
});

test("the row follows the list across folders, and What's new stays behind", async ({ page }) => {
	await announceNewVersion(page, "/inbox");
	await expect(row(page)).toHaveCount(1);
	await opener(page).click();
	await expect(reader(page)).toBeVisible();
	await page.getByRole("link", { name: "Sent", exact: true }).first().click();
	await expect(page).toHaveURL(/\/sent/);
	await expect(row(page)).toHaveCount(1);
	await expect(reader(page)).toHaveCount(0);
});

test("a page without a message list keeps the toast", async ({ page }) => {
	await announceNewVersion(page, "/settings/account");
	await expect(toast(page)).toBeVisible();
	await expect(row(page)).toHaveCount(0);
});

test("on a phone the notice is a stacked row that opens a full-screen reader with Back", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 800 });
	await announceNewVersion(page, "/inbox");
	const notice = row(page);
	await expect(notice).toBeVisible();
	await expect(notice.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
	await expect(notice.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
	await page.screenshot({ path: test.info().outputPath("update-row-phone.png") });
	await opener(page).click();
	const pane = reader(page);
	await expect(pane).toBeVisible();
	await expect(row(page)).toHaveCount(0);
	// The reader carries the notice while the list is off screen, so no toast takes over.
	await expect(toast(page)).toHaveCount(0);
	const box = await pane.boundingBox();
	expect(box!.width).toBeGreaterThan(360);
	await page.screenshot({ path: test.info().outputPath("update-reader-phone.png") });
	await pane.getByRole("button", { name: "Back to Inbox" }).click();
	await expect(reader(page)).toHaveCount(0);
	await expect(row(page)).toBeVisible();
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
		// The rows have no background of their own; the list panel has it.
		const list = page.locator("aside").filter({ has: notice });
		expect(
			await contrastBetween(notice.getByText("Kite was updated"), list),
			`${look.label} subject`,
		).toBeGreaterThanOrEqual(4.5);
		expect(
			await contrastBetween(notice.getByText(/Reload to get the latest/), list),
			`${look.label} preview`,
		).toBeGreaterThanOrEqual(4.5);
		// The actions show on hover, on the pill's own background.
		const actions = notice.locator("[data-update-actions]");
		expect(
			await contrastBetween(await rowAction(page, "Reload"), actions),
			`${look.label} Reload`,
		).toBeGreaterThanOrEqual(3);
		expect(
			await contrastBetween(notice.getByRole("button", { name: "Dismiss", exact: true }), actions),
			`${look.label} Dismiss`,
		).toBeGreaterThanOrEqual(3);
		await page.screenshot({ path: `test-results/screenshots/update-row-${look.label}.png` });
		await opener(page).click();
		const pane = reader(page);
		expect(
			await contrastBetween(pane.getByRole("heading", { level: 1 }), page.locator("section").filter({ has: pane })),
			`${look.label} reader subject`,
		).toBeGreaterThanOrEqual(4.5);
		await page.screenshot({ path: `test-results/screenshots/update-reader-${look.label}.png` });
	});
}

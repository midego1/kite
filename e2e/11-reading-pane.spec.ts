import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

let subject: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	subject = `Reading pane ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Pane Sender" <pane@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Reading pane body.",
	});
	await api.dispose();
});

function messageRow(page: Page) {
	return page
		.getByRole("main")
		.locator("div.group")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();
}

async function chooseSetting(page: Page, name: string) {
	if (!/\/(inbox|sent|starred)/.test(new URL(page.url()).pathname)) await page.goto("/inbox");
	await page.getByRole("button", { name: "Open account menu" }).click();
	const option = page.getByRole("radio", { name, exact: true });
	await option.click();
	await expect(option).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");
}

test("Right of inbox is the default and keeps the list beside an open message", async ({ page }) => {
	await page.goto("/inbox");
	const layout = page.locator("[data-reading-pane]");
	await expect(layout).toHaveAttribute("data-reading-pane", "right");
	await expect(page.getByTestId("reading-pane-empty")).toBeVisible();
	await expect(page.getByText("Select a message to read")).toBeVisible();

	const list = page.getByRole("main").locator("[data-density]");
	await expect(list.getByText(subject, { exact: true })).toBeVisible();
	await list.evaluate((element) => {
		(element as HTMLElement & { __e2eMarker?: boolean }).__e2eMarker = true;
	});

	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByTestId("reading-pane-empty")).toHaveCount(0);
	await expect(list.getByText(subject, { exact: true })).toBeVisible();
	// The same list element survives opening the message, so it was not remounted.
	expect(await list.evaluate((element) => (element as HTMLElement & { __e2eMarker?: boolean }).__e2eMarker)).toBe(true);
});

test("No split shows the list full width and replaces it with the open message", async ({ page }) => {
	await chooseSetting(page, "No split");
	await page.goto("/inbox");
	await expect(page.locator("[data-reading-pane]")).toHaveCount(0);
	await expect(page.getByText("Select a message to read")).toHaveCount(0);
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByRole("main").locator("[data-density]")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Back to Inbox" })).toBeVisible();
});

test("Below inbox stacks the list above the reading pane", async ({ page }) => {
	await chooseSetting(page, "Below inbox");
	await page.goto("/inbox");
	await expect(page.locator("[data-reading-pane]")).toHaveAttribute("data-reading-pane", "below");
	await expect(page.getByTestId("reading-pane-empty")).toBeVisible();
	await openMessage(page, subject);
	const heading = page.getByRole("heading", { level: 1, name: subject });
	await expect(heading).toBeVisible();
	const listBox = await page.getByRole("main").locator("[data-density]").boundingBox();
	const headingBox = await heading.boundingBox();
	expect(listBox && headingBox && headingBox.y > listBox.y).toBe(true);
	await chooseSetting(page, "Right of inbox");
});

test("density changes the height of message rows", async ({ page }) => {
	await chooseSetting(page, "No split");
	await chooseSetting(page, "Comfortable");
	await page.goto("/inbox");
	const comfortable = (await messageRow(page).boundingBox())?.height ?? 0;

	await chooseSetting(page, "Compact");
	await page.goto("/inbox");
	await expect(page.getByRole("main").locator("[data-density]")).toHaveAttribute("data-density", "compact");
	const compact = (await messageRow(page).boundingBox())?.height ?? 0;
	expect(compact).toBeGreaterThan(0);
	expect(compact).toBeLessThan(comfortable);

	await chooseSetting(page, "Right of inbox");
	await page.goto("/inbox");
	const stackedCompact = (await messageRow(page).boundingBox())?.height ?? 0;
	await chooseSetting(page, "Default");
	await page.goto("/inbox");
	await expect(page.getByRole("main").locator("[data-density]")).toHaveAttribute("data-density", "default");
	const stackedDefault = (await messageRow(page).boundingBox())?.height ?? 0;
	expect(stackedCompact).toBeLessThan(stackedDefault);
});

test("the header button hides the list and choosing a split layout shows it again", async ({ page }) => {
	await chooseSetting(page, "Right of inbox");
	const list = page.getByRole("main").locator("[data-density]");
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();

	await page.getByRole("button", { name: "Hide email list" }).click();
	// The hidden list slides out of a zero-width column and is made inert rather than removed.
	await expect(page.locator("[inert]").getByText(subject, { exact: true })).toHaveCount(1);
	await page.reload();
	await expect(page.getByRole("button", { name: "Show email list" })).toBeVisible();

	await page.getByRole("button", { name: "Open account menu" }).click();
	await page.getByRole("radio", { name: "Right of inbox", exact: true }).click();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "Hide email list" })).toBeVisible();
	await expect(page.locator("[inert]").getByText(subject, { exact: true })).toHaveCount(0);
	await expect(list.getByText(subject, { exact: true })).toBeVisible();
});

test("the list can be shown next to the open assistant", async ({ page }) => {
	await chooseSetting(page, "Right of inbox");
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	const assistant = page.getByRole("button", { name: "Open email assistant" });
	test.skip((await assistant.count()) === 0, "The assistant is not enabled in this environment.");

	await assistant.click();
	const show = page.getByRole("button", { name: "Show email list" });
	await expect(show).toBeEnabled();
	await show.click();
	await expect(page.getByRole("button", { name: "Hide email list" })).toBeVisible();
	await expect(page.locator("[inert]").getByText(subject, { exact: true })).toHaveCount(0);

	// The choice survives a reload while the assistant stays open.
	await page.reload();
	await expect(page.getByRole("button", { name: "Close email assistant" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Hide email list" })).toBeVisible();

	// Closing the assistant keeps the list.
	await page.getByRole("button", { name: "Close email assistant" }).click();
	await expect(page.getByRole("button", { name: "Hide email list" })).toBeVisible();
});

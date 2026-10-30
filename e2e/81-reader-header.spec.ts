import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

// The reader toolbar has no × and no "N of M unread" counter. The list toggle (split) or the Back button (one
// column) is the first control, before the newer and older email arrows.

let subject: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	subject = `Reader header ${uniqueToken()}`;
	for (const title of [`Older ${subject}`, subject]) {
		await deliverInbound(api, {
			from: `"Header Sender" <header@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject: title,
			text: "Reader header body.",
		});
	}
	await api.dispose();
});

function toolbar(page: Page) {
	return page.locator("div.sticky").filter({ has: page.getByRole("button", { name: "Newer email" }) });
}

async function expectFirstThenArrows(page: Page, first: string) {
	const bar = toolbar(page);
	await expect(bar.getByRole("button", { name: "Newer email" })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Close message" })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Close message" })).toHaveCount(0);
	await expect(page.getByText(/\d+ of \d+ unread/)).toHaveCount(0);
	const lead = await bar.getByRole("button", { name: first }).boundingBox();
	const newer = await bar.getByRole("button", { name: "Newer email" }).boundingBox();
	const older = await bar.getByRole("button", { name: "Older email" }).boundingBox();
	expect(lead!.x).toBeLessThan(newer!.x);
	expect(newer!.x).toBeLessThan(older!.x);
	// The first control starts the toolbar: nothing else is to its left.
	const buttons = await bar.getByRole("button").all();
	expect(await buttons[0].getAttribute("aria-label")).toBe(first);
}

test("split view: the list toggle leads the toolbar and the × and unread counter are gone", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/inbox");
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expectFirstThenArrows(page, "Hide email list");
	await toolbar(page).getByRole("button", { name: "Hide email list" }).click();
	await expect(toolbar(page).getByRole("button", { name: "Show email list" })).toBeVisible();
	await toolbar(page).getByRole("button", { name: "Show email list" }).click();
	await expect(toolbar(page).getByRole("button", { name: "Hide email list" })).toBeVisible();
});

test("one column: Back leads the toolbar and still returns to the list", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/inbox");
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expectFirstThenArrows(page, "Back to Inbox");
	await toolbar(page).getByRole("button", { name: "Back to Inbox" }).click();
	await expect(page).toHaveURL(/\/inbox$/);
});

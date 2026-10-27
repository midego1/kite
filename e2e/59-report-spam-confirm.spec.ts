import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken, waitForMessage } from "./support/helpers";

// Reporting spam trains the filter, so every route to it asks first, and the toast that follows can undo it.

async function deliver(label: string) {
	const api = await apiContext(STORAGE_STATE);
	const subject = `${label} ${uniqueToken()}`;
	const message = await deliverInbound(api, {
		from: `"Report Sender" <${uniqueToken("rs")}@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: `Body of ${label}.`,
	});
	await api.dispose();
	return { subject, id: message.id };
}

async function statusOf(subject: string, status: string) {
	const api = await apiContext(STORAGE_STATE);
	try {
		await waitForMessage(api, subject, { status });
	} finally {
		await api.dispose();
	}
}

/** The message is still where it was: asserted after the dialog closed, so a late request would show. */
async function expectStill(page: Page, subject: string, status: string) {
	await page.waitForTimeout(500);
	await statusOf(subject, status);
}

const dialog = (page: Page, name: string) => page.getByRole("alertdialog", { name });
const toastFor = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

function rowFor(page: Page, subject: string) {
	return page
		.getByRole("main")
		.locator("div.group")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();
}

async function openReader(page: Page, id: string, subject: string) {
	await page.goto(`/inbox/${id}`);
	await expect(page.getByRole("heading", { name: subject })).toBeVisible();
}

test("the reader's Report spam button asks first, Cancel and Esc do nothing, Confirm reports, and the toast undoes it", async ({
	page,
}) => {
	const { id, subject } = await deliver("Toolbar report");
	await openReader(page, id, subject);
	const button = page.getByRole("button", { name: /^Report spam/ });

	await button.click();
	const confirm = dialog(page, "Report as spam?");
	await expect(confirm).toContainText("filters future mail from this sender as spam");
	await expect(confirm).toContainText("learns");
	// Focus starts on Cancel, so Enter does not confirm by accident.
	await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(confirm).toHaveCount(0);
	await expectStill(page, subject, "received");

	await button.click();
	await page.keyboard.press("Escape");
	await expect(confirm).toHaveCount(0);
	await expectStill(page, subject, "received");

	await button.click();
	await confirm.getByRole("button", { name: "Report spam" }).click();
	await statusOf(subject, "spam");
	const toast = toastFor(page, "Reported as spam");
	await expect(toast).toBeVisible();
	await toast.getByRole("button", { name: "Undo" }).click();
	await statusOf(subject, "received");
});

test("the ! key and the Move menu ask first too", async ({ page }) => {
	const { id, subject } = await deliver("Key report");
	await openReader(page, id, subject);

	await page.keyboard.press("!");
	await expect(dialog(page, "Report as spam?")).toBeVisible();
	await dialog(page, "Report as spam?").getByRole("button", { name: "Cancel" }).click();
	await expectStill(page, subject, "received");

	await page.getByRole("button", { name: "Move to", exact: true }).click();
	await page.getByRole("menuitem", { name: "Spam" }).click();
	await expect(dialog(page, "Report as spam?")).toBeVisible();
	await dialog(page, "Report as spam?").getByRole("button", { name: "Cancel" }).click();
	await expectStill(page, subject, "received");

	await page.keyboard.press("!");
	await dialog(page, "Report as spam?").getByRole("button", { name: "Report spam" }).click();
	await statusOf(subject, "spam");
});

test("the phone toolbar's Report spam asks first", async ({ page }) => {
	const { id, subject } = await deliver("Phone report");
	await page.setViewportSize({ width: 390, height: 800 });
	await openReader(page, id, subject);
	await page.getByRole("button", { name: "Report spam" }).click();
	await dialog(page, "Report as spam?").getByRole("button", { name: "Cancel" }).click();
	await expectStill(page, subject, "received");
	await page.getByRole("button", { name: "Report spam" }).click();
	await dialog(page, "Report as spam?").getByRole("button", { name: "Report spam" }).click();
	await statusOf(subject, "spam");
});

test("reporting a selection names the count, Cancel changes nothing, and Undo puts every message back", async ({
	page,
}) => {
	const first = await deliver("Bulk report A");
	const second = await deliver("Bulk report B");
	await page.goto("/inbox");
	for (const { subject } of [first, second]) await rowFor(page, subject).getByRole("checkbox").check();
	await expect(page.getByText("2 selected")).toBeVisible();

	await page.getByRole("button", { name: "Report spam" }).first().click();
	const confirm = dialog(page, "Report 2 messages as spam?");
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Cancel" }).click();
	for (const { subject } of [first, second]) await expectStill(page, subject, "received");

	await page.getByRole("button", { name: "Report spam" }).first().click();
	await confirm.getByRole("button", { name: "Report spam" }).click();
	for (const { subject } of [first, second]) await statusOf(subject, "spam");
	const toast = toastFor(page, "2 messages reported as spam");
	await expect(toast).toBeVisible();
	await toast.getByRole("button", { name: "Undo" }).click();
	for (const { subject } of [first, second]) await statusOf(subject, "received");
});

test("moving mail out of Spam with Not spam asks nothing", async ({ page }) => {
	const { id, subject } = await deliver("Not spam report");
	await openReader(page, id, subject);
	await page.getByRole("button", { name: /^Report spam/ }).click();
	await dialog(page, "Report as spam?").getByRole("button", { name: "Report spam" }).click();
	await statusOf(subject, "spam");

	// Moving it back needs no question.
	await page.goto(`/spam`);
	await rowFor(page, subject).getByRole("checkbox").check();
	await page.getByRole("button", { name: "Not spam" }).first().click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await statusOf(subject, "received");
});

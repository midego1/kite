import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
});

async function deliver(label: string) {
	const subject = `${label} ${uniqueToken()}`;
	const message = await deliverInbound(api, {
		from: `"Access Sender" <access@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
	});
	return { subject, message };
}

test("the skip link is the first tab stop and moves focus to the main content", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("list", { name: "Inbox" })).toBeVisible();
	await page.keyboard.press("Tab");
	const skip = page.getByRole("link", { name: "Skip to main content" });
	await expect(skip).toBeFocused();
	await expect(skip).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("main")).toBeFocused();
});

test("a message row is reachable by keyboard and Enter opens the message", async ({ page }) => {
	const { subject, message } = await deliver("Keyboard row");
	await page.goto("/inbox");
	const row = page.getByRole("list", { name: "Inbox" }).getByRole("listitem").filter({ hasText: subject });
	await expect(row).toHaveCount(1);
	await expect(row.getByRole("checkbox", { name: "Select message from Access Sender" })).toBeVisible();
	await expect(row.getByRole("button", { name: "Star", exact: true, pressed: false })).toBeAttached();
	await expect(row.getByText("Unread", { exact: true })).toBeAttached();

	await row.getByRole("checkbox").focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	const link = row.getByRole("link", { name: new RegExp(subject) });
	await expect(link).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(new RegExp(`/inbox/${message.id}$`));
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(link).toHaveAttribute("aria-current", "true");
});

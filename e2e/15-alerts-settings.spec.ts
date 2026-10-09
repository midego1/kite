import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, waitForHydration } from "./support/helpers";

const WEBHOOK_API = "/api/admin/alerts/webhook";
const LOCAL_URL = "http://127.0.0.1:3299/hook/E2ESECRETTOKEN";
const SLACK_URL = "https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE";

test.afterEach(async () => {
	const api = await apiContext(STORAGE_STATE);
	const cleared = await api.delete(WEBHOOK_API);
	expect(cleared.ok(), await cleared.text()).toBe(true);
	await api.dispose();
});

async function openAlerts(page: Page) {
	await page.goto("/alerts");
	await expect(page.getByRole("heading", { name: "Alerts", level: 1 })).toBeVisible();
	await waitForHydration(page);
	await expect(page.getByLabel("Webhook URL")).toBeEnabled();
}

function waitForWebhook(page: Page, method: string) {
	return page.waitForResponse(
		(response) => response.url().endsWith(WEBHOOK_API) && response.request().method() === method,
	);
}

test("the alerts page is reachable from the Admin menu", async ({ page }) => {
	await page.goto("/admin");
	const menu = page.getByRole("complementary", { name: "Admin menu" });
	await menu
		.getByRole("navigation", { name: "Administration" })
		.getByRole("link", { name: "Alerts", exact: true })
		.click();
	await expect(page).toHaveURL(/\/alerts$/);
	await expect(page.getByRole("heading", { name: "Alerts", level: 1 })).toBeVisible();
	await expect(page.getByLabel("Webhook URL")).toBeVisible();
	await expect(menu.getByRole("navigation").locator('a[aria-current="page"]')).toHaveText(["Alerts"]);
	await expect(page.getByRole("link", { name: "account settings" })).toHaveAttribute("href", "/settings/account");
});

test("saves, masks and removes the webhook URL", async ({ page }) => {
	await openAlerts(page);
	const input = page.getByLabel("Webhook URL");
	const testButton = page.getByRole("button", { name: "Send test alert" });
	await expect(testButton).toBeDisabled();

	await input.fill(LOCAL_URL);
	const saved = waitForWebhook(page, "PUT");
	await page.getByRole("button", { name: "Save" }).click();
	expect((await saved).ok()).toBe(true);
	await expect(page.getByRole("status")).toHaveText("Webhook saved.");
	await expect(page.getByText("127.0.0.1:3299/…")).toBeVisible();
	await expect(input).toHaveValue("");
	await expect(testButton).toBeEnabled();
	expect(await page.content()).not.toContain("E2ESECRETTOKEN");

	await page.reload();
	await expect(page.getByText("127.0.0.1:3299/…")).toBeVisible();
	expect(await page.content()).not.toContain("E2ESECRETTOKEN");

	await waitForHydration(page);
	const removed = waitForWebhook(page, "DELETE");
	await page.getByRole("button", { name: "Remove" }).click();
	expect((await removed).ok()).toBe(true);
	await expect(page.getByRole("status")).toHaveText("Webhook removed.");
	await expect(page.getByText("127.0.0.1:3299/…")).toHaveCount(0);
	await expect(testButton).toBeDisabled();

	await page.reload();
	await expect(page.getByRole("button", { name: "Send test alert" })).toBeDisabled();
	await expect(page.getByText(/^Saved:/)).toHaveCount(0);
});

test("rejects an http URL to a public host and a private address", async ({ page }) => {
	await openAlerts(page);
	const input = page.getByLabel("Webhook URL");

	await input.fill("http://example.com/x");
	let saved = waitForWebhook(page, "PUT");
	await page.getByRole("button", { name: "Save" }).click();
	expect((await saved).status()).toBe(400);
	await expect(page.getByRole("status")).toHaveText("Use an https:// URL.");

	await input.fill("https://10.0.0.1/x");
	saved = waitForWebhook(page, "PUT");
	await page.getByRole("button", { name: "Save" }).click();
	expect((await saved).status()).toBe(400);
	await expect(page.getByRole("status")).toHaveText(/private or local/);
	await expect(page.getByText(/^Saved:/)).toHaveCount(0);

	const api = await apiContext(STORAGE_STATE);
	expect(await (await api.get(WEBHOOK_API)).json()).toMatchObject({ configured: false });
	await api.dispose();
});

test("shows the detected format and persists a chosen one", async ({ page }) => {
	await openAlerts(page);
	const format = page.getByLabel("Format");
	await expect(format.locator("option")).toHaveText(["Auto-detect", "Slack", "Discord", "ntfy", "Generic JSON"]);

	await page.getByLabel("Webhook URL").fill(SLACK_URL);
	let saved = waitForWebhook(page, "PUT");
	await page.getByRole("button", { name: "Save" }).click();
	expect((await saved).ok()).toBe(true);
	await expect(page.getByText("Detected format: Slack")).toBeVisible();
	await expect(page.getByText("hooks.slack.com/…")).toBeVisible();

	await format.selectOption({ label: "ntfy" });
	saved = waitForWebhook(page, "PUT");
	await page.getByRole("button", { name: "Save" }).click();
	expect((await saved).ok()).toBe(true);

	await page.reload();
	await expect(page.getByLabel("Format")).toHaveValue("ntfy");
	await expect(page.getByText(/^Detected format/)).toHaveCount(0);
	const api = await apiContext(STORAGE_STATE);
	expect(await (await api.get(WEBHOOK_API)).json()).toMatchObject({ configured: true, kind: "ntfy" });
	await api.dispose();
});

test("the alert webhook API refuses anonymous callers", async () => {
	const anonymous = await apiContext();
	expect((await anonymous.get(WEBHOOK_API)).status()).toBe(401);
	expect((await anonymous.put(WEBHOOK_API, { data: { url: SLACK_URL } })).status()).toBe(401);
	expect((await anonymous.delete(WEBHOOK_API)).status()).toBe(401);
	expect((await anonymous.post(`${WEBHOOK_API}/test`)).status()).toBe(401);
	await anonymous.dispose();
});

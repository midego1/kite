import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, signIn, uniqueToken } from "./support/helpers";

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

test("the command palette and the shortcuts help keep focus inside and give it back", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("list", { name: "Inbox" })).toBeVisible();
	const opener = page.getByRole("button", { name: "Open account menu" });
	await opener.focus();

	await expect(async () => {
		if (!(await page.getByRole("dialog", { name: "Command palette" }).isVisible()))
			await page.keyboard.press("Control+k");
		await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible({ timeout: 1000 });
	}).toPass();
	const combobox = page.getByRole("combobox", { name: "Search commands" });
	await expect(combobox).toBeFocused();
	await expect(page.getByRole("listbox", { name: "Commands" }).getByRole("option").first()).toHaveAttribute(
		"aria-selected",
		"true",
	);
	const first = await combobox.getAttribute("aria-activedescendant");
	await page.keyboard.press("ArrowDown");
	await expect(combobox).not.toHaveAttribute("aria-activedescendant", first ?? "");
	await page.keyboard.press("Tab");
	await expect(combobox).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
	await expect(opener).toBeFocused();

	await page.keyboard.press("?");
	const help = page.getByRole("dialog", { name: "Keyboard Shortcuts" });
	await expect(help).toBeVisible();
	await expect(help.getByRole("button", { name: "Close keyboard shortcuts" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(help.getByRole("button", { name: "Close keyboard shortcuts" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(help).toHaveCount(0);
	await expect(opener).toBeFocused();
});

test("Escape closes the account menu and leaves focus on its button", async ({ page }) => {
	await page.goto("/inbox");
	const button = page.getByRole("button", { name: "Open account menu" });
	await button.click();
	await expect(button).toHaveAttribute("aria-expanded", "true");
	await page.keyboard.press("Escape");
	await expect(button).toHaveAttribute("aria-expanded", "false");
	await expect(button).toBeFocused();
});

test("the composer takes focus when it opens and gives it back when it closes", async ({ page }) => {
	await page.goto("/inbox");
	const compose = page.getByRole("button", { name: "Compose" });
	await compose.click();
	const composer = page.getByRole("region", { name: "Compose message" });
	await expect(composer).toBeVisible();
	await expect(composer.getByLabel("To")).toBeFocused();
	await composer.getByRole("button", { name: "Close composer" }).click();
	await expect(composer).toHaveCount(0);
	await expect(compose).toBeFocused();
});

test.describe("signed out", () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test("the sign-in page is titled", async ({ page }) => {
		await page.goto("/login");
		await expect(page).toHaveTitle(/^Sign in - /);
	});

	test("a failed sign-in is announced and tied to the fields", async ({ page }) => {
		await signIn(page, `nobody-${uniqueToken()}@example.com`, "not-the-password");
		const alert = page.getByRole("alert").filter({ hasText: "Invalid credentials" });
		await expect(alert).toBeVisible();
		await expect(alert).toHaveAttribute("id", "login-error");
		for (const field of [page.getByLabel("Email"), page.getByLabel("Password")]) {
			await expect(field).toHaveAttribute("aria-invalid", "true");
			await expect(field).toHaveAttribute("aria-describedby", "login-error");
		}
	});
});

test("a settings form announces its result as a status message", async ({ page }) => {
	await page.goto("/settings/security");
	await page.getByLabel("Current password").fill("anything-at-all");
	await page.getByLabel("New password", { exact: true }).fill("first-password-1");
	await page.getByLabel("Confirm new password").fill("second-password-2");
	await page.getByRole("button", { name: "Change password" }).click();
	await expect(page.getByRole("status").filter({ hasText: "New passwords do not match" })).toBeVisible();
});

test("the startup overlay is announced only while it is showing", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("list", { name: "Inbox" })).toBeVisible();
	const overlay = page.locator("[data-loading-overlay]");
	await expect(overlay).toHaveAttribute("aria-hidden", "true");
	await expect(overlay).not.toHaveAttribute("role", "status");
	await expect(overlay.locator("img")).toHaveAttribute("alt", "");
});

test("pages are titled after themselves, also after a client-side navigation", async ({ page }) => {
	await page.goto("/settings/account");
	await expect(page).toHaveTitle(/^My account - /);
	await page.getByRole("navigation", { name: "Security" }).getByRole("link", { name: "Security", exact: true }).click();
	await expect(page).toHaveURL(/\/settings\/security$/);
	await expect(page).toHaveTitle(/^Security - /);
	await page.goto("/domains");
	await expect(page).toHaveTitle(/^Domains - /);
	await page.goto("/inbox");
	await expect(page).toHaveTitle(/^Inbox/);
});

test("each page has one h1, and the folder list keeps a heading while a message is open", async ({ page }) => {
	for (const path of [
		"/inbox",
		"/sent",
		"/settings/account",
		"/settings/inbox",
		"/settings/rules",
		"/settings/export",
		"/admin",
		"/domains",
	]) {
		await page.goto(path);
		await expect(page.getByRole("main")).toBeVisible();
		await expect(page.getByRole("heading", { level: 1 }), path).toHaveCount(1);
	}
	await page.goto("/inbox");
	await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toHaveCount(1);
	const { subject, message } = await deliver("Heading check");
	await page.goto(`/inbox/${message.id}`);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(subject);
	await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toHaveCount(1);
});

test("navigation landmarks have distinct names", async ({ page }) => {
	for (const path of ["/inbox", "/settings/account", "/domains"]) {
		await page.goto(path);
		await expect(page.getByRole("main")).toBeVisible();
		const names = await page
			.getByRole("navigation")
			.evaluateAll((navs) => navs.map((nav) => nav.getAttribute("aria-label") ?? ""));
		expect(names.length, path).toBeGreaterThan(0);
		expect(
			names.filter((name) => !name),
			path,
		).toEqual([]);
		expect(new Set(names).size, path).toBe(names.length);
	}
});

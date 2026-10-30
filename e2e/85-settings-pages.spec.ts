import { expect, test, type Page } from "@playwright/test";

// The personal Settings pages after the reorganisation: the menu groups, every route rendering as a page of its
// own, and no page wider than a phone.

const SETTINGS_ROUTES: { path: string; heading: string }[] = [
	{ path: "/settings/account", heading: "My account" },
	{ path: "/settings/appearance", heading: "Appearance" },
	{ path: "/settings/security", heading: "Security" },
	{ path: "/settings/inbox", heading: "Inbox settings" },
	{ path: "/settings/composing", heading: "Composing" },
	{ path: "/settings/notifications", heading: "Notifications" },
	{ path: "/settings/rules", heading: "Rules & routing" },
	{ path: "/settings/connected-accounts", heading: "Connected accounts" },
	{ path: "/settings/app-passwords", heading: "App passwords" },
	{ path: "/settings/api-keys", heading: "API keys" },
	{ path: "/settings/import", heading: "Import" },
	{ path: "/settings/export", heading: "Export" },
];

/** How far the page or any scrolling element inside it is wider than the viewport. */
async function horizontalOverflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const root = document.documentElement;
		let overflow = root.scrollWidth - root.clientWidth;
		for (const element of Array.from(document.querySelectorAll<HTMLElement>("main *"))) {
			const rect = element.getBoundingClientRect();
			if (rect.width === 0) continue;
			overflow = Math.max(overflow, Math.ceil(rect.right - root.clientWidth));
		}
		return overflow;
	});
}

test("the Settings menu groups pages by Account, Mail, Integrations and Data", async ({ page }) => {
	await page.goto("/settings/account");
	const menu = page.getByRole("complementary", { name: "Settings menu" });
	const groups = menu.getByRole("navigation");
	await expect(groups).toHaveCount(4);
	await expect(groups.nth(0)).toHaveAttribute("aria-label", "Account");
	await expect(groups.nth(1)).toHaveAttribute("aria-label", "Mail");
	await expect(groups.nth(2)).toHaveAttribute("aria-label", "Integrations");
	await expect(groups.nth(3)).toHaveAttribute("aria-label", "Data");
	await expect(menu.getByRole("navigation", { name: "Data" }).getByRole("link")).toHaveText(["Import", "Export"]);
	await page.getByRole("link", { name: "Composing" }).click();
	await expect(page).toHaveURL(/\/settings\/composing$/);
	await expect(page.getByRole("heading", { level: 1, name: "Composing" })).toBeVisible();
	// The page panel's trail (decorative, hidden from assistive technology) names the group the page sits in.
	await expect(page.locator('p[aria-hidden="true"]', { hasText: "Composing" })).toHaveText(/Settings.*Mail.*Composing/);
	await expect(page.getByRole("switch", { name: "Preview before sending" })).toBeVisible();
	await expect(page.getByLabel(/^Signature for /)).toBeVisible();
	await expect(page.getByRole("switch", { name: /^Enable auto-reply for / })).toBeVisible();
});

test("composing and notification settings left the Inbox page, and the old auto-reply address follows them", async ({
	page,
}) => {
	await page.goto("/settings/inbox");
	await expect(page.getByRole("heading", { level: 1, name: "Inbox settings" })).toBeVisible();
	await expect(page.getByRole("switch", { name: "Group emails into conversations" })).toBeVisible();
	await expect(page.getByRole("switch", { name: "Preview before sending" })).toHaveCount(0);
	await expect(page.getByRole("switch", { name: "Enable browser notifications" })).toHaveCount(0);
	await page.goto("/settings/notifications");
	await expect(page.getByRole("switch", { name: "Enable browser notifications" })).toBeVisible();
	await page.goto("/settings/auto-reply");
	await expect(page).toHaveURL(/\/settings\/composing$/);
});

test("every Settings page has one heading and a form that announces its result", async ({ page }) => {
	for (const { path, heading } of SETTINGS_ROUTES) {
		await page.goto(path);
		await expect(page.getByRole("heading", { level: 1 }), path).toHaveText(heading);
		await expect(page.getByRole("heading", { level: 1 }), path).toHaveCount(1);
	}
	await page.goto("/settings/account");
	await page.getByLabel("Name", { exact: true }).fill(`Demo User ${Date.now() % 1000}`);
	await page.getByRole("button", { name: "Save profile" }).click();
	await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
	await page.getByLabel("Name", { exact: true }).fill("Demo User");
	await page.getByRole("button", { name: "Save profile" }).click();
	await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	test("every Settings page fits the screen width", async ({ page }) => {
		for (const { path, heading } of SETTINGS_ROUTES) {
			await page.goto(path);
			await expect(page.getByRole("heading", { level: 1, name: heading }), path).toBeVisible();
			expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
		}
	});
});

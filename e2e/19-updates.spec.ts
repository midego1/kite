import { expect, test, type Page } from "@playwright/test";
import { DOMAIN, RELEASE_VERSION, STORAGE_STATE } from "./support/constants";
import { apiContext, signIn, uniqueToken } from "./support/helpers";

const PENDING_API = "/api/migrations/pending";
const APPLY_API = "/api/admin/migrations";
const USER_PASSWORD = "updates-user-password-123";

async function openInbox(page: Page) {
	const status = page.waitForResponse((response) => response.url().includes(PENDING_API));
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose", exact: true })).toBeVisible({ timeout: 15_000 });
	await status;
}

test("the sidebar footer shows when this build was made and opens the release notes", async ({ page }) => {
	await openInbox(page);

	const updated = page.getByRole("button", { name: /^Updated / });
	await expect(updated).toBeVisible();
	// The label is filled in after mount, in the browser's locale and time zone.
	await expect(updated).not.toHaveText(/…/);
	await expect(page.getByRole("link", { name: "Source code" })).toBeVisible();
	await expect(page.getByText(new RegExp(`Kite v${RELEASE_VERSION.replaceAll(".", "\\.")}`))).toBeVisible();

	await updated.click();
	const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(`Kite v${RELEASE_VERSION}`);
	await expect(dialog).toContainText("Unreleased changes");
	await expect(dialog).toContainText("The sidebar footer shows when this build was made");
	// Inline code and links from the changelog are rendered, not shown as markdown.
	await expect(dialog.locator("code", { hasText: "AUTO_APPLY_MIGRATIONS=1" })).toHaveCount(1);
	await expect(dialog.getByRole("link", { name: "Deployment" })).toHaveAttribute(
		"href",
		/https:\/\/github\.com\/.+\/blob\/main\/docs\/deployment\.md/,
	);
	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(dialog).toBeHidden();
});

test("a release note that links to a setting opens that page in the app", async ({ page }) => {
	await openInbox(page);
	await page.getByRole("button", { name: /^Updated / }).click();
	const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
	// Several notes may link to the same setting; any of them must behave the same.
	const settingLink = dialog.getByRole("link", { name: "Settings → Inbox → Notifications" }).first();
	await expect(settingLink).toHaveAttribute("href", "/settings/inbox");
	// An app page opens in this tab, unlike outside links.
	await expect(settingLink).not.toHaveAttribute("target", "_blank");
	await settingLink.click();
	await expect(page).toHaveURL(/\/settings\/inbox$/);
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("button", { name: "Send test notification" })).toBeVisible();
});

test("no database banner while the schema is up to date", async ({ page }) => {
	await openInbox(page);
	await expect(page.getByRole("region", { name: "Database updates" })).toHaveCount(0);
});

test("the primary admin applies pending database updates from the banner", async ({ page }) => {
	let pending = 2;
	const posts: string[] = [];
	await page.route(`**${PENDING_API}`, async (route) => {
		await route.fulfill({ json: { pending, names: ["0001_add_column.sql", "0002_add_table.sql"] } });
	});
	await page.route(`**${APPLY_API}`, async (route) => {
		posts.push(route.request().method());
		if (route.request().method() !== "POST") return route.continue();
		pending = 0;
		await route.fulfill({
			json: {
				ready: true,
				pending: [],
				unknown: [],
				applied: ["0001_add_column.sql", "0002_add_table.sql"],
				backupId: "bak_e2e",
			},
		});
	});

	await openInbox(page);
	const banner = page.getByRole("region", { name: "Database updates" });
	await expect(banner).toBeVisible();
	await expect(banner).toContainText("Kite was updated, but the database still needs 2 updates");
	await expect(banner).toContainText("new email may not appear and some pages may fail");
	await expect(banner).toContainText("0001_add_column.sql");
	await expect(banner.getByRole("link", { name: "Admin overview" })).toHaveAttribute("href", "/admin");

	await banner.getByRole("button", { name: "Apply now" }).click();
	await expect(banner).toContainText("Database updated");
	await expect(banner).toContainText("2 database updates applied. A safety backup was saved first.");
	// The warning is gone once the status reports nothing pending, and only one POST was sent.
	await expect(banner).not.toContainText("Kite was updated");
	expect(posts).toEqual(["POST"]);
});

test("a member is told to ask an administrator and gets no Apply button", async ({ browser }) => {
	const api = await apiContext(STORAGE_STATE);
	const domains = (await (await api.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
	const domain = domains.domains.find((entry) => entry.hostname === DOMAIN);
	expect(domain).toBeDefined();
	const username = uniqueToken("updates");
	const created = await api.post("/api/accounts", {
		data: { username, domainId: domain!.id, password: USER_PASSWORD, role: "user" },
	});
	expect(created.ok(), await created.text()).toBe(true);
	await api.dispose();

	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await page.route(`**${PENDING_API}`, (route) => route.fulfill({ json: { pending: 1 } }));
	await signIn(page, `${username}@${DOMAIN}`, USER_PASSWORD);
	const banner = page.getByRole("region", { name: "Database updates" });
	await expect(banner).toBeVisible();
	await expect(banner).toContainText("still needs 1 update");
	await expect(banner).toContainText("Ask an administrator to apply them.");
	await expect(banner.getByRole("button", { name: "Apply now" })).toHaveCount(0);
	await expect(banner.getByRole("link", { name: "Admin overview" })).toHaveCount(0);
	await context.close();
});

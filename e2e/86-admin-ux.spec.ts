import { expect, test, type Browser, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, signIn, uniqueToken } from "./support/helpers";

const PASSWORD = "admin-ux-password-123";

/** The Admin menu groups in order, with the pages each one holds. */
const ADMIN_GROUPS: { name: string; links: string[] }[] = [
	{ name: "Admin overview", links: ["Overview"] },
	{ name: "People", links: ["Accounts", "Activity"] },
	{ name: "Mail", links: ["Domains", "Mailboxes", "Routing"] },
	{ name: "AI", links: ["Agent", "AI usage"] },
	{ name: "Modules", links: ["Modules", "Drive"] },
	{ name: "Data", links: ["Backups", "Storage"] },
	{ name: "System", links: ["General", "Branding", "Alerts", "API keys", "Webhooks"] },
];

/** Every admin route and the level-1 heading it shows. Detail routes are filled in from the API. */
const ADMIN_ROUTES: { path: string; heading: string | RegExp }[] = [
	{ path: "/admin", heading: "Overview" },
	{ path: "/accounts", heading: "Accounts" },
	{ path: "/activity", heading: "Activity" },
	{ path: "/domains", heading: "Domains" },
	{ path: "/mailboxes", heading: "Mailboxes" },
	{ path: "/routing", heading: "Routing" },
	{ path: "/agent", heading: "Agent" },
	{ path: "/ai-usage", heading: "AI usage" },
	{ path: "/modules", heading: "Modules" },
	{ path: "/drive/settings", heading: "Drive" },
	{ path: "/backups", heading: "Backups" },
	{ path: "/storage", heading: "Storage" },
	{ path: "/general", heading: "General" },
	{ path: "/branding", heading: "Branding" },
	{ path: "/alerts", heading: "Alerts" },
	{ path: "/api-keys", heading: "API keys" },
	{ path: "/webhooks", heading: "Webhooks" },
];

async function horizontalOverflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const main = document.querySelector("main");
		const whole = document.documentElement.scrollWidth - window.innerWidth;
		return Math.max(whole, main ? main.scrollWidth - main.clientWidth : 0);
	});
}

type Account = { id: string; email: string; role: string };

async function createAccount(role: "user" | "admin"): Promise<Account> {
	const api = await apiContext(STORAGE_STATE);
	const { domains } = (await (await api.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
	const username = `ux${role}${uniqueToken("")}`;
	const response = await api.post("/api/accounts", {
		data: { username, domainId: domains[0].id, password: PASSWORD, role },
	});
	expect(response.ok(), await response.text()).toBe(true);
	const { account } = (await response.json()) as { account: Account };
	await api.dispose();
	return account;
}

async function firstMailboxId(): Promise<string> {
	const api = await apiContext(STORAGE_STATE);
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
	await api.dispose();
	return mailboxes[0].id;
}

async function signInFresh(browser: Browser, email: string, viewport?: { width: number; height: number }) {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport });
	const page = await context.newPage();
	await signIn(page, email, PASSWORD);
	await expect(page).toHaveURL(/\/inbox/);
	return { context, page };
}

test("the Admin menu groups its pages by task, in order, with Drive settings under Modules", async ({ page }) => {
	await page.goto("/admin");
	const menu = page.getByRole("complementary", { name: "Admin menu" });
	const groups = menu.getByRole("navigation");
	await expect(groups).toHaveCount(ADMIN_GROUPS.length);
	for (const [index, group] of ADMIN_GROUPS.entries()) {
		const landmark = groups.nth(index);
		await expect(landmark).toHaveAttribute("aria-label", group.name);
		await expect(landmark.getByRole("link")).toHaveText(group.links);
	}
	// The trail over the page names the new group.
	await page.goto("/backups");
	await expect(page.getByRole("heading", { level: 1, name: "Backups" })).toBeVisible();
	await expect(page.getByText("Data", { exact: true }).first()).toBeVisible();
	await page.goto("/accounts");
	await expect(page.getByText("People", { exact: true }).first()).toBeVisible();
});

test("the overview leads with what needs attention, then counts that open their pages", async ({ page }) => {
	await page.goto("/admin");
	await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
	const attention = page.getByRole("region", { name: "Needs attention" });
	await expect(attention).toBeVisible();
	// The database is current and small, so neither is listed; the backup line follows the health endpoint, since
	// specs that ran earlier may have left a backup behind.
	await expect(attention.getByTestId("attention-migrations")).toHaveCount(0);
	await expect(attention.getByTestId("attention-database-size")).toHaveCount(0);
	const api = await apiContext(STORAGE_STATE);
	const health = (await (await api.get("/api/backups/health")).json()) as {
		lastSuccess: unknown;
		lastFailure: unknown;
		inProgress: boolean;
	};
	await api.dispose();
	if (health.lastFailure) {
		await expect(attention.getByTestId("attention-backup-failed")).toContainText("The last backup failed");
	} else if (!health.lastSuccess && !health.inProgress) {
		await expect(attention.getByTestId("attention-backup-none")).toContainText("No successful backup yet");
		await expect(attention.getByRole("link", { name: "Open Backups" })).toHaveAttribute("href", "/backups");
	} else {
		await expect(attention.getByTestId(/attention-backup/)).toHaveCount(0);
	}

	const glance = page.getByRole("region", { name: "At a glance" });
	await expect(glance.getByTestId("stat-accounts")).toContainText("Accounts");
	await expect(glance.getByTestId("stat-accounts")).toHaveAttribute("href", "/accounts");
	await expect(glance.getByTestId("stat-mailboxes")).toHaveAttribute("href", "/mailboxes");
	await expect(glance.getByTestId("stat-domains")).toContainText(/\d+/);
	await expect(glance.getByTestId("stat-database")).toContainText(/MB|KB/);
	await expect(glance.getByTestId("stat-database")).toHaveAttribute("href", "#database-size");
	// The cards below keep their place and their test ids, so the specs that drive them still find them.
	await expect(page.getByTestId("database-size-card")).toBeVisible();
	await expect(page.getByTestId("backup-health-card")).toBeVisible();
	await glance.getByTestId("stat-mailboxes").click();
	await expect(page).toHaveURL(/\/mailboxes$/);
});

test("the overview counts endpoint answers each admin only what they may read, and members not at all", async ({
	browser,
}) => {
	const api = await apiContext(STORAGE_STATE);
	const counts = (await (await api.get("/api/admin/overview")).json()) as {
		accounts: { total: number; admins: number };
		mailboxes: { total: number };
		domains: { total: number } | null;
		webhooks: { failingHooks: number } | null;
		aiErrors: { recent: number; capped: boolean } | null;
	};
	await api.dispose();
	expect(counts.accounts.total).toBeGreaterThanOrEqual(counts.accounts.admins);
	expect(counts.mailboxes.total).toBeGreaterThan(0);
	expect(counts.domains?.total).toBeGreaterThan(0);
	expect(counts.webhooks).toEqual({ failingHooks: expect.any(Number), recentFailures: expect.any(Number) });
	expect(counts.aiErrors).toEqual({ recent: expect.any(Number), capped: false });

	const admin = await createAccount("admin");
	const { context, page } = await signInFresh(browser, admin.email);
	const theirs = (await (await page.request.get("/api/admin/overview")).json()) as typeof counts;
	expect(theirs.accounts.total).toBe(counts.accounts.total + 1);
	expect(theirs.domains).toBeNull();
	expect(theirs.webhooks).toBeNull();
	expect(theirs.aiErrors).toBeNull();
	await context.close();

	const member = await createAccount("user");
	const session = await signInFresh(browser, member.email);
	expect((await session.page.request.get("/api/admin/overview")).status()).toBe(403);
	await session.context.close();
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("every admin route shows its heading without horizontal overflow", async ({ page }) => {
		const user = await createAccount("user");
		const mailboxId = await firstMailboxId();
		const routes = [
			...ADMIN_ROUTES,
			{ path: `/accounts/${user.id}`, heading: "Details" },
			{ path: `/accounts/${user.id}/permissions`, heading: "Permissions" },
			{ path: `/accounts/${user.id}/mailboxes`, heading: "Mailboxes" },
			{ path: `/accounts/${user.id}/password`, heading: "Password" },
			{ path: `/mailboxes/${mailboxId}`, heading: /.+/ },
		];
		for (const route of routes) {
			await page.goto(route.path);
			await expect(page.getByRole("main").getByRole("heading", { level: 1, name: route.heading }).first()).toBeVisible({
				timeout: 30_000,
			});
			expect(await horizontalOverflow(page), route.path).toBeLessThanOrEqual(0);
		}
	});
});

test("a non-primary admin never sees primary-only controls", async ({ browser }) => {
	const admin = await createAccount("admin");
	const { context, page } = await signInFresh(browser, admin.email);

	// The overview has no database card to apply migrations from, but the counts they may read; the menu holds only
	// the pages they may open.
	await page.goto("/admin");
	await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Update database" })).toHaveCount(0);
	await expect(page.getByTestId("stat-accounts")).toBeVisible();
	await expect(page.getByTestId("stat-database")).toHaveCount(0);
	await expect(page.getByRole("region", { name: "Needs attention" })).toBeVisible();
	const menu = page.getByRole("complementary", { name: "Admin menu" });
	for (const label of ["Agent", "Backups", "Storage", "General", "Modules", "API keys", "Webhooks", "Alerts"])
		await expect(menu.getByRole("link", { name: label, exact: true })).toHaveCount(0);
	await expect(menu.getByRole("link", { name: "Accounts", exact: true })).toBeVisible();

	// Without the user grant there is no New account button; with it, the dialog has no role choice.
	await page.goto("/accounts");
	await expect(page.getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible();
	await expect(page.getByRole("button", { name: "New account" })).toHaveCount(0);

	// Their own permissions page: the role cannot be changed and primary admin cannot be transferred.
	await page.goto(`/accounts/${admin.id}/permissions`);
	await expect(page.getByRole("heading", { level: 1, name: "Permissions" })).toBeVisible();
	await expect(page.getByRole("combobox", { name: "Role" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Transfer primary admin" })).toHaveCount(0);

	// Primary-only pages bounce back to the overview.
	for (const path of ["/agent", "/storage", "/modules"]) {
		await page.goto(path);
		await expect(page).toHaveURL(/\/admin$/);
	}
	await context.close();
});

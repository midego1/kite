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

	// The overview has no database card to apply migrations from; the menu holds only the pages they may open.
	await page.goto("/admin");
	await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Update database" })).toHaveCount(0);
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

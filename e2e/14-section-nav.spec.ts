import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, signIn, uniqueToken } from "./support/helpers";

const PASSWORD = "section-nav-password-123";

function settingsMenu(page: Page): Locator {
	return page.getByRole("complementary", { name: "Settings menu" });
}

function adminMenu(page: Page): Locator {
	return page.getByRole("complementary", { name: "Admin menu" });
}

function modeSwitchOf(menu: Locator): Locator {
	return menu.getByRole("group", { name: "Settings or admin" });
}

function currentLinks(menu: Locator): Locator {
	return menu.getByRole("navigation").locator('a[aria-current="page"]');
}

async function expectMode(menu: Locator, mode: "Settings" | "Admin", current: string) {
	await expect(modeSwitchOf(menu).getByRole("link", { name: mode })).toHaveAttribute("aria-current", "page");
	await expect(menu.getByRole("heading", { level: 1, name: mode })).toBeVisible();
	await expect(currentLinks(menu)).toHaveText([current]);
}

// The admin pages and the heading each one shows.
const adminPages = [
	{ label: "Overview", path: "/admin", heading: "Admin settings" },
	{ label: "Mailboxes", path: "/mailboxes", heading: "Mailboxes" },
	{ label: "Domains", path: "/domains", heading: "Domains" },
	{ label: "Routing", path: "/routing", heading: "Routing" },
	{ label: "Webhooks", path: "/webhooks", heading: "Webhooks" },
	{ label: "API keys", path: "/api-keys", heading: "Admin API keys" },
	{ label: "General", path: "/general", heading: "General" },
	{ label: "Agent", path: "/agent", heading: "Agent" },
	{ label: "Accounts", path: "/accounts", heading: "Accounts" },
	{ label: "Activity", path: "/activity", heading: "Activity" },
	{ label: "Backups", path: "/backups", heading: "Database Backups" },
	{ label: "Alerts", path: "/alerts", heading: "Alerts" },
	{ label: "AI usage", path: "/ai-usage", heading: "AI Usage" },
	{ label: "Branding", path: "/branding", heading: "Branding" },
];

const primaryOnlyLabels = [
	"Webhooks",
	"API keys",
	"General",
	"Agent",
	"Activity",
	"Backups",
	"Alerts",
	"AI usage",
	"Branding",
];

async function horizontalOverflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const main = document.querySelector("main");
		const page = document.documentElement.scrollWidth - window.innerWidth;
		return Math.max(page, main ? main.scrollWidth - main.clientWidth : 0);
	});
}

async function createAccount(role: "user" | "admin"): Promise<string> {
	const api = await apiContext(STORAGE_STATE);
	const { domains } = (await (await api.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
	const username = `nav${role}${uniqueToken("")}`;
	const response = await api.post("/api/accounts", {
		data: { username, domainId: domains[0].id, password: PASSWORD, role },
	});
	expect(response.ok(), await response.text()).toBe(true);
	await api.dispose();
	return `${username}@${domains[0].hostname}`;
}

async function signInFresh(browser: Browser, email: string) {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await signIn(page, email, PASSWORD);
	await expect(page).toHaveURL(/\/inbox/);
	return { context, page };
}

function pageSearch(page: Page, mode: "settings" | "admin" = "settings"): Locator {
	return page.getByRole("banner").getByRole("combobox", { name: `Search ${mode}` });
}

function pageResults(page: Page): Locator {
	return page.getByRole("listbox", { name: /results$/ });
}

async function search(page: Page, query: string, mode: "settings" | "admin" = "settings") {
	await pageSearch(page, mode).fill(query);
}

function resultGroup(page: Page, mode: "Settings" | "Admin"): Locator {
	return pageResults(page).getByRole("group", { name: mode });
}

async function expectOptions(options: Locator, names: string[]) {
	await expect
		.poll(() => options.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label"))))
		.toEqual(names);
}

function currentPageLinks(page: Page): Locator {
	return page.getByRole("complementary").getByRole("navigation").locator('a[aria-current="page"]');
}

test("an admin's Settings menu has the mode switch and only the Personal and Mailbox groups", async ({ page }) => {
	await page.goto("/settings/account");
	const menu = settingsMenu(page);
	await expect(menu.getByRole("link", { name: "Back to inbox" })).toHaveAttribute("href", "/inbox");

	const modeSwitch = menu.getByRole("group", { name: "Settings or admin" });
	await expect(modeSwitch.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
	const admin = modeSwitch.getByRole("link", { name: "Admin" });
	await expect(admin).toHaveAttribute("href", "/admin");
	await expect(admin).not.toHaveAttribute("aria-current", /.*/);

	await expect(menu.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
	await expect(menu.getByRole("searchbox")).toBeHidden();
	await expect(pageSearch(page)).toBeVisible();
	await expect(pageSearch(page)).toHaveAttribute("placeholder", "Search settings");
	await expect(menu.getByRole("navigation")).toHaveCount(2);
	await expect(menu.getByRole("navigation", { name: "Personal" })).toBeVisible();
	await expect(menu.getByRole("navigation", { name: "Mailbox" })).toBeVisible();
	await expect(menu.getByRole("link", { name: "My account" })).toHaveAttribute("aria-current", "page");
	await expect(menu.getByText("Workspace")).toHaveCount(0);
	for (const href of ["/admin", "/accounts", "/mailboxes", "/domains", "/branding"])
		await expect(menu.getByRole("navigation").locator(`a[href="${href}"]`)).toHaveCount(0);
});

test("the top-bar search finds admin pages from Settings and can be cleared", async ({ page }) => {
	await page.goto("/settings/account");
	const menu = settingsMenu(page);
	const field = pageSearch(page);
	await expect(field).toHaveAttribute("aria-expanded", "false");

	await search(page, "members");
	await expect(field).toHaveAttribute("aria-expanded", "true");
	await expect(field).toHaveAttribute("aria-controls", (await pageResults(page).getAttribute("id"))!);
	await expectOptions(resultGroup(page, "Admin").getByRole("option"), ["Accounts"]);
	await search(page, "shared inboxes");
	await expectOptions(resultGroup(page, "Admin").getByRole("option"), ["Mailboxes"]);

	await search(page, "do");
	await expect(resultGroup(page, "Settings").getByRole("option").first()).toBeVisible();
	await expect(resultGroup(page, "Admin").getByRole("option", { name: "Domains" })).toBeVisible();

	await search(page, "zzzz");
	await expect(page.getByText("No pages match “zzzz”.")).toBeVisible();
	await expect(pageResults(page).getByRole("option")).toHaveCount(0);
	await field.press("Enter");
	await expect(page).toHaveURL(/\/settings\/account$/);
	await search(page, "");
	await expect(field).toHaveAttribute("aria-expanded", "false");
	await expect(pageResults(page)).toBeHidden();
	await expect(menu.getByRole("navigation")).toHaveCount(2);
	await expect(menu.getByRole("navigation", { name: "Personal" })).toBeVisible();

	await search(page, "domains");
	await expectOptions(resultGroup(page, "Admin").getByRole("option"), ["Domains"]);
	await resultGroup(page, "Admin").getByRole("option", { name: "Domains" }).click();
	await expect(page).toHaveURL(/\/domains$/);
	await expect(pageSearch(page, "admin")).toHaveValue("");
	await expect(pageResults(page)).toBeHidden();
});

test("the top-bar results work from the keyboard", async ({ page }) => {
	await page.goto("/settings/account");
	const field = pageSearch(page);
	await search(page, "a");
	const options = pageResults(page).getByRole("option");
	await expect(options.nth(2)).toBeVisible();
	await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(0);

	await field.press("ArrowDown");
	await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
	await expect(field).toHaveAttribute("aria-activedescendant", (await options.nth(0).getAttribute("id"))!);
	await field.press("ArrowDown");
	await field.press("ArrowDown");
	await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
	await field.press("ArrowUp");
	await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
	await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
	const highlighted = (await options.nth(1).getAttribute("aria-label"))!;
	await field.press("Enter");
	await expect(currentPageLinks(page)).toHaveText([highlighted]);
	await expect(pageResults(page)).toBeHidden();
	await expect(pageSearch(page)).toHaveValue("");

	await page.goto("/settings/account");
	await search(page, "domains");
	await expect(pageResults(page)).toBeVisible();
	await field.press("Escape");
	await expect(pageResults(page)).toBeHidden();
	await expect(field).toBeFocused();
	await expect(field).toHaveAttribute("aria-expanded", "false");
	await expect(page).toHaveURL(/\/settings\/account$/);

	await page.goto("/admin");
	await search(page, "appearance", "admin");
	await pageSearch(page, "admin").press("Enter");
	await expect(page).toHaveURL(/\/settings\/appearance$/);
	await expectMode(settingsMenu(page), "Settings", "Appearance");
});

test("clicking a result opens it and closes the list", async ({ page }) => {
	await page.goto("/settings/account");
	await search(page, "backups");
	await resultGroup(page, "Admin").getByRole("option", { name: "Backups" }).click();
	await expect(page).toHaveURL(/\/backups$/);
	await expectMode(adminMenu(page), "Admin", "Backups");
	await expect(pageResults(page)).toBeHidden();
});

test("the / shortcut focuses the top-bar search on Settings and Admin pages", async ({ page }) => {
	for (const [path, mode] of [
		["/settings/account", "settings"],
		["/admin", "admin"],
	] as const) {
		await page.goto(path);
		await expect(pageSearch(page, mode)).toBeVisible();
		// Shortcuts start listening once the shortcut preference has loaded.
		await expect(async () => {
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
			await page.keyboard.press("/");
			await expect(pageSearch(page, mode)).toBeFocused({ timeout: 1000 });
		}).toPass();
		await expect(pageSearch(page, mode)).toHaveValue("");
	}
});

test("the switch, search and links work from the keyboard with visible focus", async ({ page }) => {
	await page.goto("/settings/account");
	const menu = settingsMenu(page);
	const modeSwitch = menu.getByRole("group", { name: "Settings or admin" });
	const ringed = (locator: Locator) =>
		locator.evaluate((element) => element.matches(":focus-visible") && getComputedStyle(element).boxShadow !== "none");

	await menu.getByRole("link", { name: "Back to inbox" }).focus();
	for (const target of [
		modeSwitch.getByRole("link", { name: "Settings" }),
		modeSwitch.getByRole("link", { name: "Admin" }),
	]) {
		await page.keyboard.press("Tab");
		await expect(target).toBeFocused();
		expect(await ringed(target)).toBe(true);
	}
	await page.keyboard.press("Tab");
	const myAccount = menu.getByRole("link", { name: "My account" });
	await expect(myAccount).toBeFocused();
	expect(await ringed(myAccount)).toBe(true);

	await page.keyboard.press("Shift+Tab");
	await expect(modeSwitch.getByRole("link", { name: "Admin" })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/admin$/);

	// The page search sits in the top bar, before the menu in tab order.
	await adminMenu(page).getByRole("link", { name: "Back to inbox" }).focus();
	const field = pageSearch(page, "admin");
	for (let step = 0; step < 6 && !(await field.evaluate((element) => element === document.activeElement)); step++)
		await page.keyboard.press("Shift+Tab");
	await expect(field).toBeFocused();
	const pillRing = await field.evaluate((element) => getComputedStyle(element.parentElement!).boxShadow);
	expect(pillRing).toContain("inset");
});

test("a member sees no switch and no admin pages, even in search", async ({ browser }) => {
	const { context, page } = await signInFresh(browser, await createAccount("user"));
	await page.goto("/settings/account");
	const menu = settingsMenu(page);
	await expect(menu.getByRole("navigation", { name: "Personal" })).toBeVisible();
	await expect(menu.getByRole("navigation", { name: "Mailbox" })).toBeVisible();
	await expect(menu.getByRole("group", { name: "Settings or admin" })).toHaveCount(0);

	for (const query of ["domains", "backups", "members"]) {
		await search(page, query);
		await expect(page.getByText(`No pages match “${query}”.`)).toBeVisible();
	}
	await search(page, "a");
	await expect(resultGroup(page, "Settings").getByRole("option").first()).toBeVisible();
	await expect(resultGroup(page, "Admin")).toHaveCount(0);
	await context.close();
});

test("a non-primary admin gets the switch but never primary-only pages in search", async ({ browser }) => {
	const { context, page } = await signInFresh(browser, await createAccount("admin"));
	await page.goto("/settings/account");
	const menu = settingsMenu(page);
	await expect(menu.getByRole("group", { name: "Settings or admin" })).toBeVisible();

	for (const query of ["backups", "branding", "webhooks", "audit"]) {
		await search(page, query);
		await expect(page.getByText(`No pages match “${query}”.`)).toBeVisible();
	}
	await search(page, "members");
	await expect(resultGroup(page, "Admin").getByRole("option", { name: "Accounts" })).toBeVisible();
	await context.close();
});

test("admin pages use the Settings layout with the mail sidebar, top bar and Admin menu", async ({ page }) => {
	await page.goto("/admin");
	const menu = adminMenu(page);
	await expectMode(menu, "Admin", "Overview");
	await expect(page.getByRole("main")).toHaveCount(1);
	await expect(
		page
			.locator("aside")
			.first()
			.getByRole("link", { name: /^Inbox\b/ }),
	).toBeVisible();
	await expect(pageSearch(page, "admin")).toBeVisible();
	await expect(adminMenu(page).getByRole("searchbox")).toBeHidden();
	await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();

	await expect(menu.getByRole("navigation", { name: "Admin overview" }).getByRole("link")).toHaveText(["Overview"]);
	await expect(menu.getByRole("navigation", { name: "Email" }).getByRole("link")).toHaveText([
		"Mailboxes",
		"Domains",
		"Routing",
		"Webhooks",
	]);
	await expect(menu.getByRole("navigation", { name: "Administration" }).getByRole("link")).toHaveText([
		"API keys",
		"General",
		"Agent",
		"Accounts",
		"Activity",
		"Backups",
		"Alerts",
		"AI usage",
	]);
	await expect(menu.getByRole("navigation", { name: "Product" }).getByRole("link")).toHaveText(["Branding"]);

	// The overview keeps its heading and the database card but no grid of link cards; the menu is the only nav.
	await expect(page.getByRole("heading", { level: 1, name: "Admin settings" })).toBeVisible();
	await expect(page.getByText("Database", { exact: true })).toBeVisible();
	for (const href of ["/domains", "/mailboxes", "/agent", "/branding", "/accounts", "/api-keys"])
		await expect(page.locator(`a[href="${href}"]`)).toHaveCount(1);
	await expect(menu.getByRole("link", { name: "Back to inbox" })).toHaveAttribute("href", "/inbox");
});

test("every Admin menu link opens its page and is the only current link", async ({ page }) => {
	await page.goto("/admin");
	const menu = adminMenu(page);
	for (const item of adminPages) {
		await menu.getByRole("navigation").getByRole("link", { name: item.label, exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`${item.path}$`));
		await expect(page.getByRole("main").getByRole("heading", { level: 1, name: item.heading })).toBeVisible();
		await expectMode(menu, "Admin", item.label);
		await expect(page.getByRole("main")).toHaveCount(1);
	}
});

test("admin detail pages highlight their parent item and do not overflow", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const { accounts } = (await (await api.get("/api/accounts")).json()) as { accounts: { id: string }[] };
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
	await api.dispose();

	await page.goto(`/accounts/${accounts[0].id}`);
	await expect(page.getByRole("heading", { level: 1, name: "Details" })).toBeVisible();
	await expectMode(adminMenu(page), "Admin", "Accounts");
	expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

	await page.goto(`/mailboxes/${mailboxes[0].id}`);
	await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
	await expectMode(adminMenu(page), "Admin", "Mailboxes");

	for (const path of ["/domains", "/accounts", "/backups", "/activity", "/ai-usage"]) {
		await page.goto(path);
		await expect(adminMenu(page).getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
		await expect(page.getByRole("main").getByRole("heading", { level: 1 }).last()).toBeVisible();
		expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
	}
});

test("searching audit finds Activity, which /audit-logs also opens", async ({ page }) => {
	await page.goto("/settings/account");
	await search(page, "audit");
	const fromSettings = resultGroup(page, "Admin").getByRole("option");
	await expectOptions(fromSettings, ["Activity"]);
	await fromSettings.click();
	await expect(page).toHaveURL(/\/activity$/);
	await expectMode(adminMenu(page), "Admin", "Activity");

	await page.goto("/admin");
	await search(page, "audit logs", "admin");
	await expectOptions(pageResults(page).getByRole("option"), ["Activity"]);
	await pageResults(page).getByRole("option", { name: "Activity" }).click();
	await expect(page).toHaveURL(/\/activity$/);
	await expectMode(adminMenu(page), "Admin", "Activity");

	await page.goto("/audit-logs");
	await expect(page).toHaveURL(/\/activity$/);
	await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
	await expectMode(adminMenu(page), "Admin", "Activity");
});

test("the switch follows the URL through browser Back and Forward", async ({ page }) => {
	await page.goto("/settings/account");
	await modeSwitchOf(settingsMenu(page)).getByRole("link", { name: "Admin" }).click();
	await expect(page).toHaveURL(/\/admin$/);
	await expectMode(adminMenu(page), "Admin", "Overview");
	await expect(modeSwitchOf(adminMenu(page)).getByRole("link", { name: "Settings" })).toHaveAttribute(
		"href",
		"/settings/account",
	);
	await adminMenu(page).getByRole("link", { name: "Domains" }).click();
	await expect(page).toHaveURL(/\/domains$/);
	await expectMode(adminMenu(page), "Admin", "Domains");

	await page.goBack();
	await expect(page).toHaveURL(/\/admin$/);
	await expectMode(adminMenu(page), "Admin", "Overview");
	await page.goBack();
	await expect(page).toHaveURL(/\/settings\/account$/);
	await expectMode(settingsMenu(page), "Settings", "My account");
	await page.goForward();
	await expect(page).toHaveURL(/\/admin$/);
	await expectMode(adminMenu(page), "Admin", "Overview");
	await page.goForward();
	await expect(page).toHaveURL(/\/domains$/);
	await expectMode(adminMenu(page), "Admin", "Domains");
});

test("the top-bar search on Admin pages finds Settings pages", async ({ page }) => {
	await page.goto("/admin");
	await expect(pageSearch(page, "admin")).toHaveAttribute("placeholder", "Search admin");
	await search(page, "appearance", "admin");
	await expectOptions(resultGroup(page, "Settings").getByRole("option"), ["Appearance"]);
	await resultGroup(page, "Settings").getByRole("option", { name: "Appearance" }).click();
	await expect(page).toHaveURL(/\/settings\/appearance$/);
	await expectMode(settingsMenu(page), "Settings", "Appearance");
	await expect(pageSearch(page)).toHaveAttribute("placeholder", "Search settings");
});

test("the top-bar search on admin pages never searches mail, and the inbox search still does", async ({ page }) => {
	await page.goto("/domains");
	await adminMenu(page).getByRole("link", { name: "Back to inbox" }).click();
	await expect(page).toHaveURL(/\/inbox$/);

	await page.goto("/domains");
	const field = pageSearch(page, "admin");
	await field.fill("Webhook retry question");
	await expect(page.getByText("No pages match “Webhook retry question”.")).toBeVisible();
	await field.press("Enter");
	await expect(page).toHaveURL(/\/domains$/);
	await expect(page.getByRole("main").getByText("Webhook retry question", { exact: true })).toHaveCount(0);

	await page.goto("/inbox");
	const mail = page.getByRole("textbox", { name: /Search mail/ });
	await expect(mail).toBeVisible();
	await expect(page.getByRole("combobox", { name: /Search (settings|admin)/ })).toHaveCount(0);
	await mail.fill("Webhook retry question");
	await mail.press("Enter");
	await expect(page).toHaveURL(/\/inbox$/);
	const main = page.getByRole("main");
	await expect(main.getByText("Webhook retry question", { exact: true }).first()).toBeVisible();
	await expect(main.getByText("Cannot access workspace", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("listbox", { name: /results$/ })).toHaveCount(0);
});

test("the mailbox selector opens Admin and Settings in the matching mode", async ({ page }) => {
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Open account menu" }).click();
	await page.getByRole("link", { name: "Admin", exact: true }).click();
	await expect(page).toHaveURL(/\/admin$/);
	await expectMode(adminMenu(page), "Admin", "Overview");

	await page.goto("/inbox");
	await page.getByRole("button", { name: "Open account menu" }).click();
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await expect(page).toHaveURL(/\/settings\/account$/);
	await expectMode(settingsMenu(page), "Settings", "My account");
});

test("a non-primary admin's Admin menu hides primary-only pages, which stay blocked", async ({ browser }) => {
	const { context, page } = await signInFresh(browser, await createAccount("admin"));
	await page.goto("/admin");
	const menu = adminMenu(page);
	await expectMode(menu, "Admin", "Overview");
	await expect(page.getByRole("heading", { level: 1, name: "Admin settings" })).toBeVisible();
	for (const label of ["Overview", "Mailboxes", "Routing"])
		await expect(menu.getByRole("navigation").getByRole("link", { name: label, exact: true })).toBeVisible();
	for (const label of primaryOnlyLabels)
		await expect(menu.getByRole("navigation").getByRole("link", { name: label, exact: true })).toHaveCount(0);
	await expect(page.getByText("Database", { exact: true })).toHaveCount(0);

	for (const path of ["/backups", "/branding", "/audit-logs", "/alerts"]) {
		await page.goto(path);
		await expect(page).toHaveURL(/\/admin$/);
	}
	await context.close();
});

test("a member cannot open admin pages", async ({ browser }) => {
	const { context, page } = await signInFresh(browser, await createAccount("user"));
	for (const path of ["/admin", "/domains"]) {
		await page.goto(path);
		await expect(page).toHaveURL(/\/inbox$/);
		await expect(adminMenu(page)).toHaveCount(0);
	}
	await context.close();
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the Admin menu opens from the pill and closes after choosing a page", async ({ page }) => {
		await page.goto("/domains");
		await expect(page.getByRole("main").getByRole("heading", { level: 1, name: "Domains" })).toBeVisible();
		const pill = page.getByRole("button", { name: "Domains", exact: true });
		await expect(pill).toBeVisible();
		await pill.click();

		const sheet = page.getByRole("dialog", { name: "Admin menu" });
		await expect(sheet).toBeVisible();
		await expect(modeSwitchOf(sheet).getByRole("link", { name: "Admin" })).toHaveAttribute("aria-current", "page");
		for (const name of ["Admin overview", "Email", "Administration", "Product"])
			await expect(sheet.getByRole("navigation", { name })).toBeVisible();
		await sheet.getByRole("link", { name: "Backups" }).click();
		await expect(page).toHaveURL(/\/backups$/);
		await expect(sheet).toBeHidden();
		await expect(page.getByRole("button", { name: "Backups", exact: true })).toBeVisible();
		await expect(page.getByRole("heading", { level: 1, name: "Database Backups" })).toBeVisible();
	});

	test("admin pages keep their heading and their content clears the pill", async ({ page }) => {
		for (const { path, pill } of [
			{ path: "/domains", pill: "Domains" },
			{ path: "/backups", pill: "Backups" },
		]) {
			await page.goto(path);
			await expect(page.getByRole("main").getByRole("heading", { level: 1 }).last()).toBeVisible();
			expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
			const pillBox = await page.getByRole("button", { name: pill, exact: true }).boundingBox();
			const contentBottom = await page.evaluate(() => {
				const main = document.querySelector("main")!;
				main.scrollTop = main.scrollHeight;
				const content = main.querySelector(".max-w-3xl")!;
				return content.getBoundingClientRect().bottom;
			});
			expect(pillBox && contentBottom <= pillBox.y, path).toBe(true);
		}
	});

	test("the switch changes mode inside the sheet", async ({ page }) => {
		await page.goto("/admin");
		await page.getByRole("button", { name: "Overview", exact: true }).click();
		await modeSwitchOf(page.getByRole("dialog", { name: "Admin menu" }))
			.getByRole("link", { name: "Settings" })
			.click();
		await expect(page).toHaveURL(/\/settings\/account$/);
		await page.getByRole("button", { name: "My account", exact: true }).click();
		await modeSwitchOf(page.getByRole("dialog", { name: "Settings menu" }))
			.getByRole("link", { name: "Admin" })
			.click();
		await expect(page).toHaveURL(/\/admin$/);
	});

	test("the sheet keeps its own page search while the top-bar field is hidden", async ({ page }) => {
		await page.goto("/settings/account");
		await expect(page.getByRole("combobox", { name: "Search settings" })).toBeHidden();
		await page.getByRole("button", { name: "My account", exact: true }).click();
		const sheet = page.getByRole("dialog", { name: "Settings menu" });
		const field = sheet.getByRole("searchbox", { name: "Search settings" });
		await expect(field).toBeVisible();

		await field.fill("zzzz");
		await expect(sheet.getByText("No pages match “zzzz”.")).toBeVisible();
		await field.fill("");
		await expect(sheet.getByRole("navigation", { name: "Personal" })).toBeVisible();

		await field.fill("backups");
		await sheet
			.getByRole("navigation", { name: "Admin: Administration" })
			.getByRole("link", { name: "Backups" })
			.click();
		await expect(page).toHaveURL(/\/backups$/);
		await expect(sheet).toBeHidden();
	});

	test("the top-bar menu button opens the mail sidebar on admin pages", async ({ page }) => {
		await page.goto("/domains");
		await page.getByRole("button", { name: "Open menu" }).click();
		const inbox = page
			.locator("aside")
			.first()
			.getByRole("link", { name: /^Inbox\b/ });
		await expect(inbox).toBeVisible();
		await inbox.click();
		await expect(page).toHaveURL(/\/inbox$/);
	});
});

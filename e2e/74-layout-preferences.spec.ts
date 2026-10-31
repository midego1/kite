import { expect, test, type Browser, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, apiSignIn, signIn, uniqueToken } from "./support/helpers";

const PASSWORD = "layout-preferences-123";
const LAYOUT_API = "/api/settings/layout";

/** A user of its own: the shared admin's pages keep their own layout (e2e/global-setup.ts). */
async function createUser(): Promise<string> {
	const admin = await apiContext(STORAGE_STATE);
	const domains = (await (await admin.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
	const username = uniqueToken("layout");
	const created = await admin.post("/api/accounts", {
		data: {
			username,
			domainId: domains.domains.find((domain) => domain.hostname === DOMAIN)!.id,
			password: PASSWORD,
			role: "user",
		},
	});
	expect(created.ok(), await created.text()).toBe(true);
	await admin.dispose();
	return `${username}@${DOMAIN}`;
}

/** A fresh browser: its own storage, nothing chosen yet. */
async function openDevice(browser: Browser, email: string): Promise<Page> {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await signIn(page, email, PASSWORD);
	await expect(page).toHaveURL(/\/inbox/);
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 15_000 });
	return page;
}

async function chooseLayout(page: Page, name: string) {
	await page.getByRole("button", { name: "Open account menu" }).click();
	const option = page.getByRole("radio", { name, exact: true });
	await option.click();
	await expect(option).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");
}

async function expectLayoutChecked(page: Page, names: string[]) {
	await page.getByRole("button", { name: "Open account menu" }).click();
	for (const name of names)
		await expect(page.getByRole("radio", { name, exact: true })).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");
}

const stored = (page: Page, key: string) => page.evaluate((name) => localStorage.getItem(name), key);

test("layout choices follow the account to another browser", async ({ browser }) => {
	const email = await createUser();
	const laptop = await openDevice(browser, email);

	const saved = laptop.waitForResponse(
		(response) => response.url().endsWith(LAYOUT_API) && response.request().method() === "PATCH",
	);
	await chooseLayout(laptop, "Below inbox");
	await chooseLayout(laptop, "Compact");
	await saved;
	// Resizing the list beside the reading pane saves where it stops.
	await chooseLayout(laptop, "Right of inbox");
	const handle = laptop.getByRole("separator", { name: "Resize message list" });
	await handle.focus();
	for (let step = 0; step < 4; step++) await laptop.keyboard.press("ArrowRight");
	await expect.poll(() => stored(laptop, "kite-column-width:message-list")).not.toBeNull();
	const width = Number(await stored(laptop, "kite-column-width:message-list"));
	await laptop.goto("/settings/inbox");
	await laptop.getByRole("switch", { name: /Group emails into conversations/ }).click();
	await expect.poll(() => stored(laptop, "kite-conversation-view")).toBe("off");

	const account = await apiSignIn(email, PASSWORD);
	await expect
		.poll(async () => (await (await account.get(LAYOUT_API)).json()).layout)
		.toEqual({ readingPane: "right", density: "compact", conversationView: false, listWidth: width });
	await account.dispose();

	// A browser that has never been used with this account gets the same layout.
	const phone = await openDevice(browser, email);
	await expect.poll(() => stored(phone, "kite-message-density")).toBe("compact");
	expect(await stored(phone, "kite-conversation-view")).toBe("off");
	expect(Number(await stored(phone, "kite-column-width:message-list"))).toBe(width);
	await expectLayoutChecked(phone, ["Right of inbox", "Compact"]);
	await expect(phone.getByRole("main").locator("[data-density]")).toHaveAttribute("data-density", "compact");

	await laptop.context().close();
	await phone.context().close();
});

test("a browser can keep its own layout, and nothing it changes reaches the account", async ({ browser }) => {
	const email = await createUser();
	const page = await openDevice(browser, email);
	const saved = page.waitForResponse(
		(response) => response.url().endsWith(LAYOUT_API) && response.request().method() === "PATCH",
	);
	await chooseLayout(page, "Comfortable");
	await saved;
	expect(await stored(page, "kite-layout-sync")).toBeNull();

	await page.goto("/settings/inbox");
	const sync = page.getByRole("switch", { name: /Use the same layout on every device/ });
	await expect(sync).toBeChecked();
	await sync.click();
	await expect(sync).not.toBeChecked();
	expect(await stored(page, "kite-layout-sync")).toBe("off");

	const patches: string[] = [];
	page.on("request", (request) => {
		if (request.url().endsWith(LAYOUT_API) && request.method() === "PATCH") patches.push(request.postData() ?? "");
	});
	await page.goto("/inbox");
	await chooseLayout(page, "No split");
	await chooseLayout(page, "Compact");
	await page.reload();
	await expectLayoutChecked(page, ["No split", "Compact"]);
	expect(patches).toEqual([]);

	const account = await apiSignIn(email, PASSWORD);
	expect((await (await account.get(LAYOUT_API)).json()).layout).toEqual({ density: "comfortable" });
	await account.dispose();
	await page.context().close();
});

test("a choice made while the account's layout loads is saved when the page closes", async ({ browser }) => {
	const email = await createUser();
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	// The account's layout never arrives, so the choice waits for it until the page goes away.
	await page.route(`**${LAYOUT_API}`, async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		await new Promise(() => {});
	});
	await signIn(page, email, PASSWORD);
	await expect(page).toHaveURL(/\/inbox/);
	await expect(page.getByRole("button", { name: "Compose new email", exact: true })).toBeVisible({ timeout: 15_000 });
	await chooseLayout(page, "Compact");
	// The page going away (its `pagehide`; the page itself stays so the request can be seen) sends the waiting
	// choice at once, with a keepalive request that would outlive a closing page.
	const saved = page.waitForRequest((request) => request.url().endsWith(LAYOUT_API) && request.method() === "PATCH");
	await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
	expect((await saved).postDataJSON()).toEqual({ layout: { density: "compact" } });

	const account = await apiSignIn(email, PASSWORD);
	await expect.poll(async () => (await (await account.get(LAYOUT_API)).json()).layout).toEqual({ density: "compact" });
	await account.dispose();
	await context.close();
});

test("before the database update the layout stays in the browser", async ({ browser }) => {
	const email = await createUser();
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	// What the server answers while migration 0080 is pending.
	await page.route(`**${LAYOUT_API}`, (route) =>
		route.request().method() === "GET"
			? route.fulfill({ json: { ready: false, layout: null } })
			: route.fulfill({
					status: 409,
					json: { error: "Apply the pending database update first", code: "MIGRATION_PENDING" },
				}),
	);
	const patches: string[] = [];
	page.on("request", (request) => {
		if (request.url().endsWith(LAYOUT_API) && request.method() === "PATCH") patches.push(request.url());
	});
	await signIn(page, email, PASSWORD);
	await expect(page).toHaveURL(/\/inbox/);
	await chooseLayout(page, "Below inbox");
	await page.reload();
	await expectLayoutChecked(page, ["Below inbox"]);
	expect(patches).toEqual([]);
	await context.close();
});

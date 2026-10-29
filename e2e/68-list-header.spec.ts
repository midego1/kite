import { expect, test, type Browser, type Page } from "@playwright/test";
import { mockAssistant } from "./support/assistant-mock";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";

// The list header at the narrowest and the default list width: the title stays readable in every style and
// theme next to the sidebar toggle, the Kite AI button stays gone, and the sidebar still comes back from its
// icon rail and on phones. The account menu sits at the bottom of the sidebar, expanded, as a rail icon and in
// the phone sheet.

const MIN_WIDTH = 250;
const DEFAULT_WIDTH = 360;
const LONG_FOLDER = "Quarterly tax receipts and invoices";

const headerOf = (page: Page) =>
	page.locator("div.h-14").filter({ has: page.getByRole("link", { name: "List settings" }) });

/** A fresh page per look and width: the list remembers the width it was last resized to per account. */
async function openList(
	browser: Browser,
	path: string,
	width: number,
	style: string,
	theme: string,
	viewport = { width: 1400, height: 900 },
	assistant = false,
) {
	const context = await browser.newContext({ storageState: STORAGE_STATE, viewport });
	const page = await context.newPage();
	if (assistant) await mockAssistant(page);
	await page.addInitScript(
		({ width, style, theme }) => {
			localStorage.setItem("kite-style", style);
			localStorage.setItem("kite-theme", theme);
			localStorage.setItem("kite-column-width:message-list", String(width));
		},
		{ width, style, theme },
	);
	await page.goto(path);
	await expect(page.locator("html")).toHaveAttribute("data-style", style);
	await expect(page.getByRole("link", { name: "List settings" })).toBeVisible({ timeout: 60_000 });
	// The boot overlay fades out over 300 ms; measure and photograph only the settled page.
	await expect(page.locator("[data-loading-overlay]")).toHaveCSS("opacity", "0");
	return { page, context };
}

test.describe("message list header", () => {
	let longFolderPath = "";

	test.beforeAll(async () => {
		const api = await apiContext(STORAGE_STATE);
		const mailboxes = (await (await api.get("/api/mailboxes", { timeout: 60_000 })).json()) as
			{ id: string }[] | { mailboxes: { id: string }[] };
		const first = (Array.isArray(mailboxes) ? mailboxes : mailboxes.mailboxes)[0];
		const created = await api.post("/api/folders", {
			data: { mailboxId: first.id, name: `${LONG_FOLDER} ${uniqueToken("")}`.slice(0, 40) },
		});
		expect(created.ok(), await created.text()).toBe(true);
		longFolderPath = `/folders/${((await created.json()) as { id: string }).id}`;
		await api.dispose();
	});

	for (const style of ["kite", "lavender", "classic"]) {
		for (const theme of ["light", "dark"]) {
			test(`the folder title is readable at the minimum and default width in ${style} ${theme}`, async ({
				browser,
			}, testInfo) => {
				test.setTimeout(240_000);
				for (const [name, path, width] of [
					["Inbox", "/inbox", MIN_WIDTH],
					["Archived", "/archived", MIN_WIDTH],
					["Long folder", longFolderPath, MIN_WIDTH],
					["Inbox", "/inbox", DEFAULT_WIDTH],
				] as const) {
					const { page, context } = await openList(browser, path, width, style, theme);
					const header = headerOf(page);
					const select = header.getByRole("button", { name: "Select" });
					await expect(select).toBeVisible();
					// Below 20rem "Select" is icon-only, so the title keeps the room.
					await expect(select.getByText("Select", { exact: true })).toBeVisible({ visible: width > MIN_WIDTH });
					const clipped = await header.locator("p.truncate").evaluate((node) => node.scrollWidth > node.clientWidth);
					// A folder name longer than the list is wide ends in an ellipsis, with the full name on hover.
					if (name !== "Long folder") expect.soft(clipped, `${name} at ${width}px in ${style} ${theme}`).toBe(false);
					await header.screenshot({
						path: testInfo.outputPath(
							`list-header-${name.toLowerCase().replace(" ", "-")}-${width}-${style}-${theme}.png`,
						),
					});
					await context.close();
				}
			});
		}
	}

	test("the list header has the collapse toggle and no Kite AI button", async ({ browser }) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light");
		const header = headerOf(page);
		await expect(header.getByRole("button", { name: /Kite AI/ })).toHaveCount(0);
		await expect(page.getByTestId("assistant-button-list")).toHaveCount(0);
		await expect(header.getByRole("button", { name: "Collapse menu" })).toBeVisible();
		await expect(header.getByRole("button", { name: "Expand menu" })).toHaveCount(0);
		await context.close();
	});

	test("the toggle sits left of the title in every list view and leaves the sidebar header", async ({ browser }) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light");
		const sidebar = page.getByRole("navigation", { name: "Kite" });
		const expectToggleBeforeTitle = async (view: string) => {
			const header = headerOf(page);
			const toggle = header.getByRole("button", { name: "Collapse menu" });
			await expect(toggle, view).toBeVisible();
			await expect(toggle, view).toHaveAttribute("aria-label", "Collapse menu");
			const [toggleBox, titleBox] = await Promise.all([
				toggle.boundingBox(),
				header.locator("p.truncate").boundingBox(),
			]);
			expect(toggleBox!.x + toggleBox!.width, view).toBeLessThanOrEqual(titleBox!.x + 1);
			// One toggle on the page: the sidebar header has dropped its own.
			await expect(page.getByRole("button", { name: "Collapse menu" }), view).toHaveCount(1);
			await expect(sidebar.getByRole("button", { name: "Collapse menu" }), view).toHaveCount(0);
		};
		await expectToggleBeforeTitle("Inbox");
		await page.getByRole("textbox", { name: /Search mail/ }).fill("nomatchzzqq");
		await page.getByRole("textbox", { name: /Search mail/ }).press("Enter");
		await expectToggleBeforeTitle("Search");
		for (const [view, path] of [
			["Sent", "/sent"],
			["Drafts", "/drafts"],
			["Archived", "/archived"],
			["Folder", longFolderPath],
		] as const) {
			await page.goto(path);
			await expect(page.getByRole("link", { name: "List settings" })).toBeVisible({ timeout: 60_000 });
			await expectToggleBeforeTitle(view);
		}
		await page.goto("/inbox");
		await page.getByRole("button", { name: "Open All mailboxes" }).click();
		await expect(page.getByRole("button", { name: "Open All mailboxes" })).toHaveAttribute("aria-pressed", "true");
		await expectToggleBeforeTitle("All mailboxes");
		await context.close();
	});

	test("a hidden list gives the toggle back to the sidebar header", async ({ browser }) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light", undefined, true);
		const sidebar = page.getByRole("navigation", { name: "Kite" });
		const collapse = page.getByRole("button", { name: "Collapse menu" });
		await headerOf(page).getByRole("button", { name: "Collapse menu" }).waitFor();

		await page.getByRole("list", { name: "Inbox" }).locator("[data-message-row]").first().getByRole("link").click();
		await expect(page).toHaveURL(/\/inbox\/[^/]+$/);
		// The list stays beside the open message, with its header holding the one toggle.
		await expect(headerOf(page).getByRole("button", { name: "Collapse menu" })).toBeVisible();
		await expect(sidebar.getByRole("button", { name: "Collapse menu" })).toHaveCount(0);

		// Hiding the list leaves the mounted header unseen, so the sidebar header shows the toggle again.
		await page.getByRole("button", { name: "Hide email list" }).click();
		await expect(sidebar.getByRole("button", { name: "Collapse menu" })).toBeVisible();
		await expect(collapse).toHaveCount(1);
		await page.getByRole("button", { name: "Show email list" }).click();
		await expect(headerOf(page).getByRole("button", { name: "Collapse menu" })).toBeVisible();
		await expect(sidebar.getByRole("button", { name: "Collapse menu" })).toHaveCount(0);

		// The assistant hides the list too, unless the user chose to keep it.
		await page.locator("body").press(".");
		await expect(page.getByRole("region", { name: "Email assistant" })).toBeVisible();
		await expect(sidebar.getByRole("button", { name: "Collapse menu" })).toBeVisible();
		await expect(collapse).toHaveCount(1);
		await sidebar.getByRole("button", { name: "Collapse menu" }).click();
		await expect
			.poll(async () => (await page.locator("#kite-sidebar-layout > [data-panel]").first().boundingBox())!.width)
			.toBeLessThan(80);
		await context.close();
	});

	test("the list header toggle collapses the sidebar to the icon rail, whose Expand button brings it back", async ({
		browser,
	}) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light");
		const sidebar = page.locator("#kite-sidebar-layout > [data-panel]").first();
		const expanded = (await sidebar.boundingBox())!.width;
		await headerOf(page).getByRole("button", { name: "Collapse menu" }).click();
		await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80);
		// The rail keeps its own button; the list header's toggle is gone while the rail shows.
		await expect(headerOf(page).getByRole("button", { name: /menu/i })).toHaveCount(0);
		await sidebar.getByRole("button", { name: "Expand menu" }).click();
		await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - expanded)).toBeLessThan(3);
		await expect(headerOf(page).getByRole("button", { name: "Collapse menu" })).toBeVisible();
		await context.close();
	});

	test("with the sidebar collapsed to the icon rail the assistant opens from the rail", async ({ browser }) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light", undefined, true);
		const sidebar = page.locator("#kite-sidebar-layout > [data-panel]").first();
		await headerOf(page).getByRole("button", { name: "Collapse menu" }).click();
		await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80);
		await expect(page.getByText("Assistant", { exact: true })).toHaveCount(0);

		const rail = sidebar.getByRole("button", { name: "Open email assistant" });
		const panel = page.getByRole("region", { name: "Email assistant" });
		await expect(rail).toBeVisible();
		await rail.hover();
		await expect(page.getByRole("tooltip", { name: "Open email assistant" })).toBeVisible();
		await rail.click();
		await expect(panel).toBeVisible();
		await expect(sidebar.getByRole("button", { name: "Close email assistant" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await sidebar.getByRole("button", { name: "Close email assistant" }).click();
		await expect(panel).toBeHidden();
		await context.close();
	});

	test("the account menu opens upward from the bottom of the expanded sidebar", async ({ browser }, testInfo) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light");
		const sidebar = page.getByRole("navigation", { name: "Kite" });
		const button = sidebar.getByRole("button", { name: "Open account menu" });
		await expect(button).toBeVisible();
		// The mailbox avatar row stays at the top; the account is the last item, under Settings, Support and the build info.
		await expect(sidebar.getByRole("button", { name: /^Open .*@/ }).first()).toBeVisible();
		const [accountBox, supportBox, buildBox, sidebarBox] = await Promise.all([
			button.boundingBox(),
			sidebar.getByRole("link", { name: "Support" }).boundingBox(),
			sidebar.getByText(/Kite v/).boundingBox(),
			sidebar.boundingBox(),
		]);
		expect(accountBox!.y).toBeGreaterThan(supportBox!.y + supportBox!.height - 1);
		expect(accountBox!.y).toBeGreaterThan(buildBox!.y + buildBox!.height - 1);
		expect(accountBox!.y + accountBox!.height).toBeLessThanOrEqual(sidebarBox!.y + sidebarBox!.height + 1);
		await expect(button).toContainText(/\S+@\S+/);
		// The accessible name keeps the visible name and address (WCAG 2.5.3), and the old name still matches.
		const visible = (await button.locator("span.block").allInnerTexts()).join(" ");
		await expect(button).toHaveAccessibleName(`Open account menu, ${visible}`);
		await expect(sidebar.getByRole("button", { name: "Open account menu" })).toHaveCount(1);
		await page.screenshot({ path: testInfo.outputPath("account-bottom-expanded-closed.png") });

		await button.focus();
		await page.keyboard.press("Enter");
		await expect(button).toHaveAttribute("aria-expanded", "true");
		const menu = page.locator('[data-placement="sidebar"]');
		await expect(menu.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
		await expect(menu.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
		await expect(menu.getByRole("link", { name: "Admin" })).toBeVisible();
		await expect(menu.getByRole("link", { name: "Add another account" })).toBeVisible();
		await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
		const menuBox = (await menu.boundingBox())!;
		expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(accountBox!.y);
		expect(menuBox.y).toBeGreaterThanOrEqual(0);
		await page.screenshot({ path: testInfo.outputPath("account-bottom-expanded-open.png") });

		await page.keyboard.press("Escape");
		await expect(button).toHaveAttribute("aria-expanded", "false");
		await expect(button).toBeFocused();
		await context.close();
	});

	test("the open account menu follows its button when the window is resized", async ({ browser }) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light");
		const button = page.getByRole("navigation", { name: "Kite" }).getByRole("button", { name: "Open account menu" });
		await button.click();
		const menu = page.locator('[data-placement="sidebar"]');
		await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
		const gap = async () =>
			(await button.boundingBox())!.y - ((await menu.boundingBox())!.y + (await menu.boundingBox())!.height);
		expect(Math.abs((await gap()) - 8)).toBeLessThanOrEqual(2);
		await page.setViewportSize({ width: 1400, height: 640 });
		// Still just above the button, and still inside the window.
		await expect.poll(async () => Math.abs((await gap()) - 8)).toBeLessThanOrEqual(2);
		const box = (await menu.boundingBox())!;
		expect(box.y).toBeGreaterThanOrEqual(0);
		expect(box.y + box.height).toBeLessThanOrEqual(640);
		await context.close();
	});

	test("the account avatar sits at the bottom of the icon rail and opens the same menu", async ({
		browser,
	}, testInfo) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light");
		const sidebar = page.locator("#kite-sidebar-layout > [data-panel]").first();
		await headerOf(page).getByRole("button", { name: "Collapse menu" }).click();
		await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80);
		const button = sidebar.getByRole("button", { name: "Open account menu" });
		await expect(button).toBeVisible();
		await expect(button).not.toContainText("@");
		const [buttonBox, sidebarBox] = await Promise.all([button.boundingBox(), sidebar.boundingBox()]);
		expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width);
		expect(buttonBox!.y + buttonBox!.height).toBeGreaterThan(sidebarBox!.y + sidebarBox!.height - 80);
		await page.screenshot({ path: testInfo.outputPath("account-bottom-rail-closed.png") });

		await button.click();
		const menu = page.locator('[data-placement="sidebar"]');
		await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
		await expect(menu.getByRole("link", { name: "Add another account" })).toBeVisible();
		const menuBox = (await menu.boundingBox())!;
		expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(buttonBox!.y);
		await page.screenshot({ path: testInfo.outputPath("account-bottom-rail-open.png") });
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(button).toBeFocused();
		await context.close();
	});

	test("on a phone the menu sheet ends with the account, and the list header has no toggle", async ({
		browser,
	}, testInfo) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light", {
			width: 390,
			height: 844,
		});
		await expect(headerOf(page).getByRole("button", { name: /menu/i })).toHaveCount(0);
		await page.getByRole("button", { name: "Open menu" }).click();
		const sheet = page.getByRole("dialog", { name: "Menu" });
		await expect(sheet).toBeVisible();
		const account = sheet.getByRole("button", { name: "Open account menu" });
		await expect(account).toBeVisible();
		const [accountBox, supportBox] = await Promise.all([
			account.boundingBox(),
			sheet.getByRole("link", { name: "Support" }).boundingBox(),
		]);
		expect(accountBox!.y).toBeGreaterThan(supportBox!.y);
		await page.screenshot({ path: testInfo.outputPath("account-bottom-phone-sheet.png") });

		await account.click();
		const menu = page.locator('[data-placement="sidebar"]');
		await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
		const menuBox = (await menu.boundingBox())!;
		expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(accountBox!.y);
		expect(menuBox.x).toBeGreaterThanOrEqual(0);
		expect(menuBox.x + 1).toBeLessThanOrEqual(390);
		await page.screenshot({ path: testInfo.outputPath("account-bottom-phone-open.png") });
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await context.close();
	});
});

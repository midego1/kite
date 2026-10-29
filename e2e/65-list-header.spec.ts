import { expect, test, type Browser, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";

// The list header at the narrowest and the default list width: the title stays readable in every style and
// theme, the removed buttons stay gone, and the sidebar still comes back from its icon rail and on phones.

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
) {
	const context = await browser.newContext({ storageState: STORAGE_STATE, viewport });
	const page = await context.newPage();
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

	test("the list header has no Kite AI or sidebar toggle button", async ({ browser }) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light");
		const header = headerOf(page);
		await expect(header.getByRole("button", { name: /Kite AI/ })).toHaveCount(0);
		await expect(header.getByRole("button", { name: /menu/i })).toHaveCount(0);
		await expect(page.getByTestId("assistant-button-list")).toHaveCount(0);
		await context.close();
	});

	test("the sidebar's own toggle collapses it to the icon rail and brings it back", async ({ browser }) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light");
		const sidebar = page.locator("#kite-sidebar-layout > [data-panel]").first();
		const expanded = (await sidebar.boundingBox())!.width;
		await page.getByRole("button", { name: "Collapse menu" }).click();
		await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(80);
		// The rail keeps a way back, and the list header still has no toggle of its own.
		await expect(headerOf(page).getByRole("button", { name: /menu/i })).toHaveCount(0);
		await page.getByRole("button", { name: "Expand menu" }).click();
		await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - expanded)).toBeLessThan(3);
		await context.close();
	});

	test("on a phone the menu opens as a sheet from the page header, not the list header", async ({ browser }) => {
		const { page, context } = await openList(browser, "/inbox", DEFAULT_WIDTH, "kite", "light", {
			width: 390,
			height: 844,
		});
		await expect(headerOf(page).getByRole("button", { name: /menu/i })).toHaveCount(0);
		await page.getByRole("button", { name: "Open menu" }).click();
		const sheet = page.getByRole("dialog", { name: "Menu" });
		await expect(sheet).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(sheet).toBeHidden();
		await context.close();
	});
});

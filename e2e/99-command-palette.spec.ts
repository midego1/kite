import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";
import { PALETTE_PLACEHOLDER, openPalette } from "./support/module-flows";

// The Cmd+K palette: a floating search box over a panel with a category column and grouped results.

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const results = (page: Page) => page.getByRole("listbox", { name: "Results" });
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}\\b`) });

/** The count chip of a category tab, as a number. */
async function countOf(page: Page, name: string): Promise<number> {
	const label = await tab(page, name)
		.locator("[aria-label$='results'], [aria-label$='result']")
		.getAttribute("aria-label");
	return Number(label?.split(" ")[0]);
}

async function openInbox(page: Page) {
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
}

test("Cmd+K opens the search box over a panel with categories, counts, grouped rows and the key hints", async ({
	page,
}) => {
	await openInbox(page);
	const search = await openPalette(page);
	const dialog = palette(page);
	await expect(search).toBeFocused();
	await expect(search).toHaveAttribute("role", "combobox");

	const tabs = page.getByRole("tablist", { name: "Categories" }).getByRole("tab");
	await expect(tabs.first()).toHaveText(/^All/);
	for (const name of ["Pages", "Messages", "Contacts", "Actions", "Settings", "Calendar", "Drive"])
		await expect(tab(page, name), name).toBeVisible();
	await expect(tab(page, "All")).toHaveAttribute("aria-selected", "true");

	// Every category's chip adds up to the All chip, and the group headings show in the sidebar's order.
	const names = (await tabs.allInnerTexts()).map((text) => text.split("\n")[0].trim());
	let sum = 0;
	for (const name of names.slice(1)) sum += await countOf(page, name);
	expect(await countOf(page, "All")).toBe(sum);
	const headings = results(page).locator("[role='group'] > div:first-child");
	await expect(headings.first()).toHaveText("Pages");
	await expect(headings).toContainText(["Pages", "Actions", "Settings"]);
	expect(await countOf(page, "Messages")).toBe(0);

	// A row shows its icon tile, a bold title, a type badge, a subtitle and its shortcut keys.
	const compose = results(page).getByRole("option", { name: /^Compose new message/ });
	await expect(compose).toContainText("ACTION");
	await expect(compose).toContainText("Open draft editor");
	await expect(compose.locator("kbd")).toHaveText(["C"]);
	const inbox = results(page).getByRole("option", { name: /^Go to Inbox/ });
	await expect(inbox).toContainText("PAGE");
	await expect(inbox.locator("kbd")).toHaveText(["G", "I"]);
	await expect(results(page).getByRole("option", { name: /^Account Settings/ })).toContainText("SETTING");

	await expect(dialog.getByText("Kite search")).toBeVisible();
	await expect(dialog.locator("kbd", { hasText: "Esc" }).last()).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
});

test("a category narrows the list: by click, by Alt+number, by number from the sidebar and by arrow keys", async ({
	page,
}) => {
	await openInbox(page);
	await openPalette(page);
	const pagesCount = await countOf(page, "Pages");
	await tab(page, "Pages").click();
	await expect(tab(page, "Pages")).toHaveAttribute("aria-selected", "true");
	await expect(results(page).getByRole("option")).toHaveCount(pagesCount);
	await expect(results(page).getByRole("option").first()).toHaveAttribute("aria-selected", "true");
	for (const option of await results(page).getByRole("option").all()) await expect(option).toContainText("PAGE");

	// Alt+5 is Actions whichever part of the palette has focus; typing afterwards still goes to the search box.
	await page.getByPlaceholder(PALETTE_PLACEHOLDER).focus();
	await page.keyboard.press("Alt+Digit5");
	await expect(tab(page, "Actions")).toHaveAttribute("aria-selected", "true");
	await expect(results(page).getByRole("option")).toHaveCount(await countOf(page, "Actions"));

	// From the sidebar a bare digit works too, and the arrows walk the tabs.
	await tab(page, "Actions").focus();
	await page.keyboard.press("Digit6");
	await expect(tab(page, "Settings")).toHaveAttribute("aria-selected", "true");
	await expect(tab(page, "Settings")).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(tab(page, "Actions")).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("Home");
	await expect(tab(page, "All")).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("End");
	await expect(tab(page, "All")).not.toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("ArrowDown");
	await expect(tab(page, "All")).toHaveAttribute("aria-selected", "true");

	// A digit typed in the empty search box is a search, not a category.
	await page.getByPlaceholder(PALETTE_PLACEHOLDER).focus();
	await page.keyboard.type("4");
	await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toHaveValue("4");
	await expect(tab(page, "All")).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("Escape");
});

test("the arrow keys move the highlight from the box and from the list, Enter opens the highlighted page", async ({
	page,
}) => {
	await openInbox(page);
	const search = await openPalette(page);
	const options = results(page).getByRole("option");
	await expect(options.first()).toHaveAttribute("aria-selected", "true");
	const first = await search.getAttribute("aria-activedescendant");
	await search.press("ArrowDown");
	await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
	await expect(search).not.toHaveAttribute("aria-activedescendant", first ?? "");
	await expect(search).toHaveAttribute("aria-activedescendant", (await options.nth(1).getAttribute("id")) ?? "");
	await search.press("End");
	await expect(options.last()).toHaveAttribute("aria-selected", "true");
	await search.press("ArrowDown");
	await expect(options.first()).toHaveAttribute("aria-selected", "true");

	// Tab to the list; the arrows keep working there and a typed letter goes back to the search box.
	await search.press("Tab");
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await expect(results(page)).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
	await expect(results(page)).toHaveAttribute("aria-activedescendant", (await options.nth(1).getAttribute("id")) ?? "");
	await page.keyboard.type("starred");
	await expect(search).toBeFocused();
	await expect(search).toHaveValue("starred");
	await expect(options.first()).toHaveAttribute("aria-selected", "true");
	await expect(options.first()).toContainText("Go to Starred");
	await page.keyboard.press("Enter");
	await expect(palette(page)).toHaveCount(0);
	await expect(page).toHaveURL(/\/starred$/);
});

test("a message is found by its subject, shows its sender and date, and opens in the reader", async ({ page }) => {
	const token = uniqueToken("palette");
	const api = await apiContext(STORAGE_STATE);
	let message;
	try {
		message = await deliverInbound(api, {
			from: `"Nadia Okonkwo" <nadia.${token}@contoso.test>`,
			to: SUPPORT_ADDRESS,
			subject: `Quarterly roadmap ${token}`,
			text: "Here is the roadmap for the next quarter.",
		});
	} finally {
		await api.dispose();
	}
	await openInbox(page);
	const search = await openPalette(page);
	await search.fill(token);
	const row = results(page).getByRole("option", { name: new RegExp(`^Quarterly roadmap ${token}`) });
	await expect(row).toBeVisible();
	await expect(row).toContainText("MESSAGE");
	await expect(row).toContainText(/Nadia Okonkwo · \d{2}:\d{2}/);
	await expect(
		results(page)
			.locator("[role='group']", { has: page.getByRole("option", { name: new RegExp(`^Quarterly roadmap ${token}`) }) })
			.locator("> div:first-child"),
	).toHaveText("Messages");
	expect(await countOf(page, "Messages")).toBeGreaterThanOrEqual(1);

	// The sender is a contact now, listed with the address, and Messages narrows to the one row.
	await expect(results(page).getByRole("option", { name: /^Nadia Okonkwo/ })).toContainText(
		`nadia.${token}@contoso.test`,
	);
	await tab(page, "Messages").click();
	await expect(results(page).getByRole("option")).toHaveCount(1);
	await expect(row).toHaveAttribute("aria-selected", "true");
	await search.press("Enter");
	await expect(page).toHaveURL(new RegExp(`/inbox/${message.id}$`));
	await expect(page.getByRole("heading", { level: 1, name: `Quarterly roadmap ${token}` })).toBeVisible();
});

test("a contact opens the mail from that address, and a settings page opens from Settings", async ({ page }) => {
	const token = uniqueToken("contact");
	const api = await apiContext(STORAGE_STATE);
	try {
		await deliverInbound(api, {
			from: `"Priya ${token}" <priya.${token}@acme.test>`,
			to: SUPPORT_ADDRESS,
			subject: `Hello from ${token}`,
			text: "Checking in.",
		});
	} finally {
		await api.dispose();
	}
	await page.goto("/settings/account");
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	let search = await openPalette(page);
	await search.fill(`priya ${token}`);
	const contact = results(page).getByRole("option", { name: new RegExp(`^Priya ${token}`) });
	await expect(contact).toContainText("CONTACT");
	await expect(contact).toContainText(`priya.${token}@acme.test`);
	await contact.click();
	await expect(page).toHaveURL(/\/inbox\?q=from%3Apriya/);
	const field = page.getByRole("textbox", { name: /Search mail/ });
	await expect(field).toHaveValue(`from:priya.${token}@acme.test`);
	await expect(page.getByRole("list", { name: "Inbox" }).getByText(`Hello from ${token}`)).toBeVisible();

	search = await openPalette(page);
	await search.fill("appearance");
	const row = results(page).getByRole("option", { name: /^Appearance/ });
	await expect(row).toContainText("SETTING");
	await expect(row).toContainText("Settings · Account");
	await expect(row).toHaveAttribute("aria-selected", "true");
	await search.press("Enter");
	await expect(page).toHaveURL(/\/settings\/appearance$/);
});

test("the clear button empties the search and the close button closes; nothing matching says so", async ({ page }) => {
	await openInbox(page);
	const search = await openPalette(page);
	await search.fill("zzzqqqxxx-nothing");
	await expect(results(page).getByRole("status")).toHaveText("No matching results for “zzzqqqxxx-nothing”");
	expect(await countOf(page, "All")).toBe(0);
	await page.getByRole("button", { name: "Clear search" }).click();
	await expect(search).toHaveValue("");
	await expect(search).toBeFocused();
	await expect(results(page).getByRole("option").first()).toBeVisible();
	await tab(page, "Messages").click();
	await expect(results(page).getByRole("status")).toHaveText("Type to search your mail");
	await page.getByRole("button", { name: "Close" }).click();
	await expect(palette(page)).toHaveCount(0);
});

test("on a phone the palette fills the screen with the categories as a chip row", async ({ browser }) => {
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	const page = await context.newPage();
	try {
		await page.goto("/inbox");
		await expect(page.getByRole("list", { name: "Inbox" })).toBeVisible();
		await openPalette(page);
		const dialog = palette(page);
		// The dialog scales in; once settled it covers the whole screen.
		await expect.poll(async () => (await dialog.boundingBox())?.width).toBe(390);
		await expect.poll(async () => (await dialog.boundingBox())?.height).toBe(844);
		const tablist = page.getByRole("tablist", { name: "Categories" });
		const all = await tab(page, "All").boundingBox();
		const pages = await tab(page, "Pages").boundingBox();
		expect(pages!.x).toBeGreaterThan(all!.x + all!.width - 1);
		expect(Math.round(pages!.y)).toBe(Math.round(all!.y));
		await expect(tablist.locator("kbd:visible")).toHaveCount(0);
		await tab(page, "Pages").click();
		await expect(results(page).getByRole("option").first()).toContainText("PAGE");
		await results(page)
			.getByRole("option", { name: /^Go to Sent/ })
			.click();
		await expect(page).toHaveURL(/\/sent$/);
	} finally {
		await context.close();
	}
});

test("Escape returns focus to the button that opened the palette", async ({ page }) => {
	await openInbox(page);
	const opener = page.getByRole("button", { name: "Open account menu" });
	await opener.focus();
	await openPalette(page);
	await page.keyboard.press("Escape");
	await expect(palette(page)).toHaveCount(0);
	await expect(opener).toBeFocused();
});

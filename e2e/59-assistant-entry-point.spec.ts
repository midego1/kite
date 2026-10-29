import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { mockAssistant } from "./support/assistant-mock";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// Where people find Kite AI: the Assistant item in the sidebar, the button in the reader toolbar, the "." key,
// the command palette and the floating bubble, which only a floating composer hides. The list header has none.

/** The sidebar's Assistant item, which toggles the same panel as the reader toolbar button. */
const sidebarAssistant = (page: Page) => page.getByRole("button", { name: /^(Open|Close) email assistant$/ });

async function openMessage(page: Page): Promise<string> {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Entry point ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Entry Sender" <entry@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Body of the entry point message.",
	});
	await api.dispose();
	await page.goto("/inbox");
	await page
		.getByRole("list", { name: "Inbox" })
		.locator("[data-message-row]")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.getByRole("link")
		.click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	return subject;
}

test.describe("Kite AI entry points", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await mockAssistant(page);
	});

	test("the reader toolbar button opens and closes the assistant", async ({ page }) => {
		await openMessage(page);
		const reader = page.getByTestId("assistant-button-reader");
		const panel = page.getByRole("region", { name: "Email assistant" });
		await expect(reader).toHaveAccessibleName("Open Kite AI");
		await expect(reader).toHaveAttribute("aria-expanded", "false");
		await expect(reader).toHaveAttribute("aria-controls", "email-assistant-panel");

		await reader.click();
		await expect(panel).toBeVisible();
		await expect(reader).toHaveAccessibleName("Close Kite AI");
		await expect(reader).toHaveAttribute("aria-expanded", "true");

		await reader.click();
		await expect(panel).toBeHidden();
		await expect(reader).toHaveAttribute("aria-expanded", "false");
	});

	test("the sidebar item opens and closes the assistant, and the list header has no button for it", async ({
		page,
	}) => {
		await page.goto("/inbox");
		await expect(page.getByTestId("assistant-button-list")).toHaveCount(0);
		await expect(page.getByRole("button", { name: /Kite AI$/ }).filter({ hasText: "Kite AI" })).toHaveCount(0);
		const list = sidebarAssistant(page);
		const panel = page.getByRole("region", { name: "Email assistant" });
		await expect(list).toBeVisible();
		if ((await list.getAttribute("aria-expanded")) === "true") await list.click();
		await expect(panel).toBeHidden();

		await list.click();
		await expect(panel).toBeVisible();
		await expect(list).toHaveAttribute("aria-expanded", "true");
		await list.click();
		await expect(panel).toBeHidden();
		await expect(list).toHaveAttribute("aria-expanded", "false");
	});

	test("the . key toggles Kite AI, and the palette and the cheat sheet list it", async ({ page }) => {
		await page.goto("/inbox");
		const panel = page.getByRole("region", { name: "Email assistant" });
		const toggle = sidebarAssistant(page);
		await expect(toggle).toBeVisible();
		if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
		await expect(panel).toBeHidden();

		// The keys bind once the shortcut preference has loaded, which is when the cheat sheet can open.
		const sheet = page.getByRole("dialog");
		await expect(async () => {
			await page.keyboard.press("?");
			await expect(sheet).toBeVisible({ timeout: 1_000 });
		}).toPass();
		await expect(sheet.getByText("Toggle Kite AI")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(sheet).toBeHidden();

		await page.locator("body").press(".");
		await expect(panel).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await page.locator("body").press(".");
		await expect(panel).toBeHidden();

		await page.keyboard.press("ControlOrMeta+k");
		await page.getByPlaceholder("Type a command or search actions...").fill("Open Kite AI");
		await page.getByRole("option", { name: /Open Kite AI/ }).click();
		await expect(panel).toBeVisible();
	});

	test("the entry points stay hidden while the assistant is off", async ({ page }) => {
		await page.route("**/api/agent/availability", (route) => route.fulfill({ json: { enabled: false } }));
		await page.addInitScript(() => localStorage.setItem("kite-assistant-enabled", "false"));
		await openMessage(page);
		await expect(page.getByTestId("assistant-button-reader")).toHaveCount(0);
		await expect(sidebarAssistant(page)).toHaveCount(0);
		await page.locator("body").press(".");
		await expect(page.getByRole("region", { name: "Email assistant" })).toBeHidden();
	});

	test("the Ask Kite AI bubble stays with a reply docked in the reader and steps aside for the floating composer", async ({
		page,
	}) => {
		await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
		await openMessage(page);
		const bubble = page.getByRole("button", { name: "Ask Kite AI" });
		await expect(bubble).toBeVisible();

		await page.getByRole("button", { name: /^Reply to Entry Sender/ }).click();
		await expect(
			page
				.getByRole("main")
				.getByRole("region", { name: "Compose message" })
				.filter({ has: page.getByRole("button", { name: "Pop out composer" }) }),
		).toBeVisible();
		await expect(bubble).toBeVisible();
		// The docked reply's footer runs under the corner, so the bubble must not cover its buttons.
		const bubbleBox = await bubble.boundingBox();
		const deleteBox = await page.getByRole("button", { name: "Delete draft" }).boundingBox();
		expect(bubbleBox && deleteBox).toBeTruthy();
		expect(bubbleBox!.y + bubbleBox!.height <= deleteBox!.y || deleteBox!.x + deleteBox!.width <= bubbleBox!.x).toBe(
			true,
		);

		await page.getByRole("button", { name: "Pop out composer" }).click();
		await expect(page.getByRole("button", { name: "Minimize composer" })).toBeVisible();
		await expect(bubble).toBeHidden();
	});
	test("the docked assistant is a panel level with the list and the reader", async ({ page }) => {
		// With nothing open the list and the reader both show beside the assistant.
		await page.goto("/inbox");
		const toggle = sidebarAssistant(page);
		await expect(toggle).toBeVisible();
		if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
		const panel = page.getByRole("region", { name: "Email assistant" });
		await expect(panel).toBeVisible();
		// The slide-in animation ends with the panel at its final width.
		await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBe(390 - 16);

		const reader = page.locator("#kite-reader-panel section").first();
		const list = page.locator("#kite-message-list-panel aside").first();
		const [panelBox, readerBox, listBox] = await Promise.all([
			panel.boundingBox(),
			reader.boundingBox(),
			list.boundingBox(),
		]);
		expect(panelBox && readerBox && listBox).toBeTruthy();
		expect(Math.abs(panelBox!.y - readerBox!.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(panelBox!.y + panelBox!.height - (readerBox!.y + readerBox!.height))).toBeLessThanOrEqual(1);
		// The same gap as between the list and the reader.
		const gap = panelBox!.x - (readerBox!.x + readerBox!.width);
		const listGap = readerBox!.x - (listBox!.x + listBox!.width);
		expect(Math.abs(gap - listGap)).toBeLessThanOrEqual(1);

		// Its header is as tall as the list's, so the bottom borders line up.
		const headerBox = await panel.locator("header").boundingBox();
		const listHeaderBox = await page.getByRole("link", { name: "List settings" }).evaluate((link) => {
			const row = link.closest("div.border-b");
			const rect = row?.getBoundingClientRect();
			return rect ? { y: rect.y, height: rect.height } : null;
		});
		expect(headerBox && listHeaderBox).toBeTruthy();
		expect(Math.abs(headerBox!.y + headerBox!.height - (listHeaderBox!.y + listHeaderBox!.height))).toBeLessThanOrEqual(
			1,
		);

		const style = await panel.evaluate((element) => {
			const computed = getComputedStyle(element);
			return { border: computed.borderTopWidth, radius: computed.borderTopLeftRadius, shadow: computed.boxShadow };
		});
		const readerStyle = await reader.evaluate((element) => {
			const computed = getComputedStyle(element);
			return { border: computed.borderTopWidth, radius: computed.borderTopLeftRadius, shadow: computed.boxShadow };
		});
		expect(style).toEqual(readerStyle);
	});

	test("the sidebar menu scrolls above the pinned bottom group in a short window", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 700 });
		await page.goto("/inbox");
		const sidebar = page.locator("nav:has(a[href='/settings/account'])").first();
		await expect(sidebar).toBeVisible();
		const scroller = sidebar.locator("> div").nth(1);
		const footer = sidebar.locator("> div").nth(2);
		// A notice as tall as the real ones can get must not squeeze the menu away or sit over it.
		await footer.evaluate((element) => {
			const notice = document.createElement("div");
			notice.style.cssText = "height:400px;flex:none";
			element.insertBefore(notice, element.firstChild);
		});
		const foldersHeader = scroller.getByText("Folders", { exact: true });
		await foldersHeader.scrollIntoViewIfNeeded();
		await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));

		const [scrollerBox, footerBox, foldersBox] = await Promise.all([
			scroller.boundingBox(),
			footer.boundingBox(),
			foldersHeader.boundingBox(),
		]);
		expect(scrollerBox && footerBox && foldersBox).toBeTruthy();
		expect(scrollerBox!.y + scrollerBox!.height).toBeLessThanOrEqual(footerBox!.y + 1);
		expect(scrollerBox!.height).toBeGreaterThan(120);
		expect(foldersBox!.y).toBeGreaterThanOrEqual(scrollerBox!.y);
		expect(foldersBox!.y + foldersBox!.height).toBeLessThanOrEqual(scrollerBox!.y + scrollerBox!.height);
	});
});

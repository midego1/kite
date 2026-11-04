import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, setSendingSettings, signIn, uniqueToken } from "./support/helpers";

// The interface direction setting (ROADMAP milestone 1): Automatic follows the browser language, Left to right and Right
// to left are stored like the reading layout, and <html dir> is right before the first paint. A mirrored interface keeps
// every drag, key and floating window on the correct side; a left-to-right one is untouched.

const DIRECTION_KEY = "kite-interface-direction";
const SIDEBAR = "#kite-sidebar-panel";
const PAGE_PANEL = "#kite-page-panel";
const LIST = "#kite-message-list-panel";
const READER = "#kite-reader-panel";

/** Keeps the shared admin's account layout out of it: the choice stays in this browser (see e2e/74-layout-preferences). */
async function chooseDirection(page: Page, direction: "auto" | "ltr" | "rtl") {
	await page.addInitScript(
		([key, value]) => {
			localStorage.setItem("kite-layout-sync", "off");
			if (!localStorage.getItem(key!)) localStorage.setItem(key!, value!);
		},
		[DIRECTION_KEY, direction],
	);
}

async function box(locator: Locator) {
	const found = await locator.boundingBox();
	if (!found) throw new Error("element has no box");
	return found;
}

async function expectDirection(page: Page, direction: "ltr" | "rtl") {
	await expect(page.locator("html")).toHaveAttribute("dir", direction);
}

async function openInbox(page: Page) {
	await page.goto("/inbox");
	await expect(page.locator(SIDEBAR)).toBeVisible();
	await expect(page.locator("[data-message-row]").first()).toBeVisible();
}

/** A drag along the x axis on an element's centre. */
async function dragBy(page: Page, handle: Locator, distance: number) {
	const from = await box(handle);
	const x = from.x + from.width / 2;
	const y = from.y + from.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + distance / 2, y, { steps: 4 });
	await page.mouse.move(x + distance, y, { steps: 4 });
	await page.mouse.up();
}

/** A record, from the first moment of the document, of what `dir` said when <body> appeared and every change after it. */
async function watchFirstPaintDirection(page: Page) {
	await page.addInitScript(() => {
		const record = { atBody: null as string | null, changes: [] as (string | null)[] };
		(window as unknown as { __direction: typeof record }).__direction = record;
		const watchBody = new MutationObserver(() => {
			if (!document.body) return;
			const root = document.documentElement;
			record.atBody = root.getAttribute("dir");
			watchBody.disconnect();
			new MutationObserver(() => record.changes.push(root.getAttribute("dir"))).observe(root, {
				attributes: true,
				attributeFilter: ["dir"],
			});
		});
		watchBody.observe(document, { childList: true, subtree: true });
	});
}

const firstPaintDirection = (page: Page) =>
	page.evaluate(() => (window as unknown as { __direction: { atBody: string; changes: string[] } }).__direction);

let subject: string;
let longSender: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	subject = `Mirrored pane ${uniqueToken()}`;
	longSender = `Alexandria Wilhelmina Featherstonehaugh Montgomery Cholmondeley ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"${longSender}" <mirror@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Read from the other side.",
	});
	await setSendingSettings(api, { previewEnabled: false, undoSeconds: 30 });
	await api.dispose();
});

test.afterAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	await api.dispose();
});

test.describe("the setting", () => {
	test("the account menu switches the interface and the choice survives a reload with no flash", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("kite-layout-sync", "off"));
		await watchFirstPaintDirection(page);
		await openInbox(page);
		await expectDirection(page, "ltr");
		expect((await box(page.locator(SIDEBAR))).x).toBeLessThan(10);

		await page.getByRole("button", { name: "Open account menu" }).click();
		const direction = page.getByRole("radiogroup", { name: "Direction" });
		await expect(direction.getByRole("radio", { name: "Automatic" })).toHaveAttribute("aria-checked", "true");
		await direction.getByRole("radio", { name: "Right to left" }).click();

		await expectDirection(page, "rtl");
		const sidebar = await box(page.locator(SIDEBAR));
		const viewport = page.viewportSize()!;
		expect(sidebar.x + sidebar.width).toBeGreaterThan(viewport.width - 10);
		expect((await box(page.locator(PAGE_PANEL))).x).toBeLessThan(sidebar.x);

		await page.reload();
		await expect(page.locator(SIDEBAR)).toBeVisible();
		const record = await firstPaintDirection(page);
		expect(record.atBody, "dir was set before <body> appeared").toBe("rtl");
		expect(
			record.changes.filter((value) => value !== "rtl"),
			"dir never left rtl",
		).toEqual([]);
		await expectDirection(page, "rtl");

		await page.getByRole("button", { name: "Open account menu" }).click();
		await expect(page.getByRole("radio", { name: "Right to left" })).toHaveAttribute("aria-checked", "true");
		// Names the side it opens on in this direction.
		await expect(page.getByRole("radio", { name: "Left of inbox" })).toBeVisible();
	});

	test("the account menu opens in place beside its button", async ({ page }) => {
		await chooseDirection(page, "rtl");
		await openInbox(page);
		const trigger = await box(page.getByRole("button", { name: "Open account menu" }));
		await page.getByRole("button", { name: "Open account menu" }).click();
		const option = page.getByRole("radio", { name: "Right to left" });
		await expect(option).toBeVisible();
		const menu = await box(page.locator('[data-placement="sidebar"]').first());
		const viewport = page.viewportSize()!;
		expect(menu.x).toBeGreaterThanOrEqual(0);
		expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
		// Anchored to the right edge of the window, over the sidebar, not to the far side.
		expect(menu.x + menu.width).toBeGreaterThan(viewport.width - 40);
		expect(menu.y + menu.height).toBeLessThanOrEqual(trigger.y + 1);
	});

	test("Automatic follows the browser language, and a stored choice wins over it", async ({ browser }) => {
		for (const [locale, expected] of [
			["ar-EG", "rtl"],
			["he", "rtl"],
			["fa-IR", "rtl"],
			["nl-NL", "ltr"],
		] as const) {
			const context = await browser.newContext({ locale, storageState: STORAGE_STATE });
			const page = await context.newPage();
			await page.addInitScript(() => localStorage.setItem("kite-layout-sync", "off"));
			await watchFirstPaintDirection(page);
			await page.goto("/inbox");
			await expect(page.locator(SIDEBAR)).toBeVisible();
			expect((await firstPaintDirection(page)).atBody, locale).toBe(expected);
			await expectDirection(page, expected);
			await context.close();
		}
		const context = await browser.newContext({ locale: "ar-EG", storageState: STORAGE_STATE });
		const page = await context.newPage();
		await chooseDirection(page, "ltr");
		await page.goto("/inbox");
		await expect(page.locator(SIDEBAR)).toBeVisible();
		await expectDirection(page, "ltr");
		await context.close();
	});

	test("signed-out pages follow the browser language and the stored choice", async ({ browser }) => {
		const signedOut = { cookies: [], origins: [] };
		for (const [locale, expected] of [
			["ar-EG", "rtl"],
			["en-US", "ltr"],
		] as const) {
			const context = await browser.newContext({ locale, storageState: signedOut });
			const page = await context.newPage();
			await page.goto("/login");
			await expect(page.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
			await expectDirection(page, expected);
			await context.close();
		}
		const context = await browser.newContext({ locale: "en-US", storageState: signedOut });
		const page = await context.newPage();
		await chooseDirection(page, "rtl");
		await page.goto("/login");
		await expectDirection(page, "rtl");
		await context.close();
	});

	test("the choice follows the account to another browser", async ({ browser }) => {
		const password = "rtl-interface-123";
		const admin = await apiContext(STORAGE_STATE);
		const domains = (await (await admin.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
		const username = uniqueToken("rtl");
		const created = await admin.post("/api/accounts", {
			data: {
				username,
				domainId: domains.domains.find((domain) => domain.hostname === DOMAIN)!.id,
				password,
				role: "user",
			},
		});
		expect(created.ok(), await created.text()).toBe(true);
		await admin.dispose();

		const openDevice = async (open: Browser) => {
			const context = await open.newContext({ storageState: { cookies: [], origins: [] } });
			const page = await context.newPage();
			await signIn(page, `${username}@${DOMAIN}`, password);
			await expect(page).toHaveURL(/\/inbox/);
			return page;
		};
		const first = await openDevice(browser);
		await expectDirection(first, "ltr");
		await first.getByRole("button", { name: "Open account menu" }).click();
		const saved = first.waitForResponse(
			(response) => response.url().includes("/api/settings/layout") && response.request().method() === "PATCH",
		);
		await first.getByRole("radio", { name: "Right to left" }).click();
		await saved;

		const second = await openDevice(browser);
		await expectDirection(second, "rtl");
		await second.context().close();
		await first.context().close();
	});
});

test.describe("a mirrored interface", () => {
	test.beforeEach(async ({ page }) => {
		await chooseDirection(page, "rtl");
	});

	test("the dividers resize the panel on the correct side, and saved sizes carry over", async ({ page }) => {
		await openInbox(page);
		await openMessage(page, subject);
		const sidebar = page.locator(SIDEBAR);
		const list = page.locator(LIST);
		const reader = page.locator(READER);
		const sidebarBefore = await box(sidebar);
		const listBefore = await box(list);
		const readerBefore = await box(reader);
		// Sidebar on the right, then the list, then the reader.
		expect(sidebarBefore.x).toBeGreaterThan(listBefore.x);
		expect(listBefore.x).toBeGreaterThan(readerBefore.x);

		// Pulling the list's divider leftward widens the list and narrows the reader.
		await dragBy(page, page.getByRole("separator", { name: "Resize message list" }), -80);
		await expect(async () => {
			expect((await box(list)).width).toBeGreaterThan(listBefore.width + 60);
		}).toPass();
		const listAfter = await box(list);
		expect((await box(reader)).width).toBeLessThan(readerBefore.width - 60);
		expect(listAfter.x + listAfter.width).toBeCloseTo(listBefore.x + listBefore.width, -1);

		// Pulling the menu's divider leftward widens the menu.
		await dragBy(page, page.getByRole("separator", { name: "Resize right menu" }), -60);
		await expect(async () => {
			expect((await box(sidebar)).width).toBeGreaterThan(sidebarBefore.width + 40);
		}).toPass();
		const sidebarAfter = await box(sidebar);
		expect(sidebarAfter.x + sidebarAfter.width).toBeCloseTo(sidebarBefore.x + sidebarBefore.width, -1);

		// The same pixel sizes read back in either direction.
		await page.evaluate((key) => localStorage.setItem(key, "ltr"), DIRECTION_KEY);
		await page.reload();
		await expectDirection(page, "ltr");
		await expect(async () => {
			expect(Math.abs((await box(list)).width - listAfter.width)).toBeLessThanOrEqual(2);
			expect(Math.abs((await box(sidebar)).width - sidebarAfter.width)).toBeLessThanOrEqual(2);
		}).toPass();
		expect((await box(sidebar)).x).toBeLessThan((await box(list)).x);
	});

	test("the composer docks on the left and the undo bar stays clear of it", async ({ page }) => {
		await page.setViewportSize({ width: 1700, height: 900 });
		await openInbox(page);
		const popup = () => page.getByRole("region", { name: "Compose message" });
		await page.getByRole("button", { name: "Compose new email" }).click();
		await expect(popup()).toBeVisible();
		expect((await box(popup())).x).toBeLessThan(64);

		const recipient = popup().getByLabel("To", { exact: true });
		await recipient.fill("receiver@e2e.test");
		await recipient.press("Enter");
		await popup().getByLabel("Subject").fill(`Mirrored send ${uniqueToken()}`);
		await popup().getByRole("textbox", { name: "Message body" }).fill("Which side?");
		await popup().getByRole("button", { name: "Send", exact: true }).click();

		const bar = page.getByRole("status").filter({ hasText: /Sending in \d+s/ });
		await expect(bar).toBeVisible();
		expect((await box(bar)).x).toBeLessThan(64);

		// With another composer open the bar stands beside it, towards the middle of the screen.
		await page.getByRole("button", { name: "Compose new email" }).click();
		await expect(popup()).toBeVisible();
		await expect(async () => {
			const composer = await box(popup());
			expect((await box(bar)).x).toBeGreaterThanOrEqual(composer.x + composer.width);
		}).toPass();
		await bar.getByRole("button", { name: "Undo" }).click();
	});

	test("toasts stand on the left", async ({ page }) => {
		await openInbox(page);
		await page.route("**/api/messages/**", (route) =>
			route.request().method() === "GET" ? route.fallback() : route.abort(),
		);
		const row = page.locator("[data-message-row]").filter({ hasText: subject }).first();
		await row.hover();
		await row.getByRole("button", { name: /^Archive/ }).click();
		const toast = page.getByText("Could not update the messages. Please try again.").locator("xpath=..");
		await expect(toast).toBeVisible();
		// It scales up as it enters, so its box settles.
		await expect(async () => {
			const found = await box(toast);
			expect(found.x).toBeLessThan(64);
			expect(found.x + found.width).toBeLessThan(page.viewportSize()!.width / 2);
		}).toPass();
	});

	test("the assistant window, its bubble and its resize handle sit on the left", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
		await page.setViewportSize({ width: 1500, height: 900 });
		await openInbox(page);
		const bubble = page.getByRole("button", { name: /^(Ask|Minimize) Kite AI$/ });
		if ((await bubble.getAttribute("aria-expanded")) !== "true") await bubble.click();
		await expect(page.locator("#email-assistant-panel")).toBeVisible();
		const bubbleBox = await box(bubble);
		expect(bubbleBox.x).toBeLessThan(64);

		const handle = page.getByRole("separator", { name: "Resize assistant width" });
		const panelBefore = await box(page.locator("#email-assistant-panel"));
		expect(panelBefore.x).toBeLessThan(64);
		const handleBox = await box(handle);
		expect(Math.abs(handleBox.x + handleBox.width / 2 - (panelBefore.x + panelBefore.width))).toBeLessThan(8);
		// The far edge of a window on the left is its right edge: pulling it rightward widens the window.
		await dragBy(page, handle, 60);
		await expect(async () => {
			expect((await box(page.locator("#email-assistant-panel"))).width).toBeGreaterThan(panelBefore.width + 40);
		}).toPass();

		// A composer stands next to it, further from the screen edge.
		await page.getByRole("button", { name: "Compose new email" }).click();
		await page
			.getByRole("button", { name: /Restore|Expand composer/ })
			.first()
			.click({ timeout: 5_000 })
			.catch(() => undefined);
		const composer = page.getByRole("region", { name: "Compose message" });
		await expect(composer).toBeVisible();
		const panelAfter = await box(page.locator("#email-assistant-panel"));
		expect((await box(composer)).x).toBeGreaterThanOrEqual(panelAfter.x + panelAfter.width);
	});

	test("the docked assistant sits on the left and its handle widens it rightward", async ({ page }) => {
		await page.setViewportSize({ width: 1600, height: 900 });
		await openInbox(page);
		await page.getByRole("button", { name: "Open email assistant" }).click();
		const panel = page.locator("#email-assistant-panel");
		await expect(panel).toBeVisible();
		const handle = page.getByRole("separator", { name: "Resize assistant" });
		await expect(async () => {
			const main = await box(page.getByRole("main"));
			expect((await box(panel)).x + (await box(panel)).width).toBeLessThanOrEqual(main.x + 1);
		}).toPass();
		const before = await box(panel);
		await dragBy(page, handle, 60);
		await expect(async () => {
			expect((await box(panel)).width).toBeGreaterThan(before.width + 40);
		}).toPass();
	});

	test("the subscription drawer docks to the left and the month picker opens under its button", async ({ page }) => {
		await page.goto("/finance?subscription=missing");
		const drawer = page.locator("[data-finance-drawer]");
		await expect(drawer).toBeVisible();
		await expect(async () => {
			const found = await box(drawer);
			expect(found.x).toBeLessThanOrEqual(1);
			expect(found.width).toBeLessThan(page.viewportSize()!.width / 2);
		}).toPass();

		await page.goto("/calendar");
		const month = page.getByRole("button", { expanded: false, name: /\d{4}/ }).first();
		await expect(month).toBeVisible();
		const button = await box(month);
		await month.click();
		const picker = page.getByRole("dialog", { name: "Choose a calendar date" });
		await expect(picker).toBeVisible();
		const found = await box(picker);
		expect(Math.abs(found.x + found.width - (button.x + button.width))).toBeLessThanOrEqual(2);
	});

	test("dates keep their order and English text its ellipsis at the end", async ({ page }) => {
		await openInbox(page);
		const row = page.locator("[data-message-row]").filter({ hasText: subject }).first();
		const time = row.locator("time").first();
		// First-strong isolates around the date, which is what <bdi> does.
		expect(await time.textContent()).toMatch(/^⁨.*⁩$/);

		const edges = await row.getByText(longSender).evaluate((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			const text = range.getBoundingClientRect();
			const clip = element.closest(".truncate")!.getBoundingClientRect();
			return { textLeft: text.left, textRight: text.right, clipLeft: clip.left, clipRight: clip.right };
		});
		// The text overflows from its own start: the first letters stay visible and the end is what gets cut.
		expect(edges.textRight).toBeGreaterThan(edges.clipRight);
		expect(Math.abs(edges.textLeft - edges.clipLeft)).toBeLessThanOrEqual(1);
	});

	test("arrow keys follow the direction in Radix menus and Kite's own tabs", async ({ page }) => {
		await openInbox(page);
		await page.keyboard.press("Control+k");
		const tabs = page.getByRole("tablist", { name: "Categories" });
		await expect(tabs).toBeVisible();
		const first = tabs.getByRole("tab").first();
		const second = tabs.getByRole("tab").nth(1);
		await first.focus();
		await page.keyboard.press("ArrowLeft");
		await expect(second).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await expect(first).toBeFocused();
		await page.keyboard.press("Escape");

		// The Radix direction context reaches a dropdown, and `align="start"` lines it up with the trigger's right edge.
		await openMessage(page, subject);
		const trigger = page.getByRole("button", { name: "Move to", exact: true }).first();
		const triggerBox = await box(trigger);
		await trigger.click();
		const menu = page.locator("[data-radix-menu-content]").first();
		await expect(menu).toHaveAttribute("dir", "rtl");
		await expect(async () => {
			const found = await box(menu);
			expect(found.x).toBeGreaterThanOrEqual(0);
			expect(Math.abs(found.x + found.width - (triggerBox.x + triggerBox.width))).toBeLessThanOrEqual(2);
		}).toPass();
	});

	test("a hinge keeps the list on the right screen and the reader on the left one", async ({ page }) => {
		const FIRST = { left: 0, top: 0, width: 600, height: 900 };
		const SECOND = { left: 640, top: 0, width: 600, height: 900 };
		await page.setViewportSize({ width: 1240, height: 900 });
		await page.addInitScript(
			(segments) => {
				Object.defineProperty(window, "viewport", { value: { segments }, configurable: true });
				Object.defineProperty(window, "ontouchstart", { value: null, configurable: true });
			},
			[FIRST, SECOND],
		);
		await page.goto("/inbox");
		await expect(page.locator("[data-reading-pane]")).toHaveAttribute("data-fold-hinge", "vertical");
		await openMessage(page, subject);
		const expectReaderOnFirstScreen = () =>
			expect(async () => {
				const reader = await box(page.locator(READER));
				expect(reader.x).toBeGreaterThanOrEqual(FIRST.left - 1);
				expect(reader.x + reader.width).toBeLessThanOrEqual(FIRST.width + 1);
			}).toPass();
		await expectReaderOnFirstScreen();
		await expect(async () => {
			const list = await box(page.locator(LIST));
			expect(list.x).toBeGreaterThanOrEqual(SECOND.left - 1);
			expect(list.x + list.width).toBeLessThanOrEqual(SECOND.left + SECOND.width + 1);
		}).toPass();
		// With the list hidden the reader keeps to its screen instead of spreading over the hinge.
		await page.getByRole("button", { name: "Hide email list" }).click();
		await expectReaderOnFirstScreen();
		await page.getByRole("button", { name: "Show email list" }).click();
		await expectReaderOnFirstScreen();
	});
});

test.describe("a phone in right to left", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("the menu sheet slides in from the right", async ({ page }) => {
		await chooseDirection(page, "rtl");
		await page.goto("/inbox");
		await page.getByRole("button", { name: "Open menu" }).click();
		const close = page.getByRole("button", { name: "Close menu" });
		await expect(close).toBeVisible();
		await expect(async () => {
			const sheet = await box(page.getByRole("dialog", { name: "Menu" }));
			expect(sheet.x + sheet.width).toBeGreaterThan(388);
			expect(sheet.x).toBeGreaterThan(0);
		}).toPass();
	});
});

test.describe("left to right is untouched", () => {
	test("sidebar, panels, composer and toasts keep their places", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("kite-layout-sync", "off"));
		await page.setViewportSize({ width: 1700, height: 900 });
		await watchFirstPaintDirection(page);
		await openInbox(page);
		await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
		expect((await firstPaintDirection(page)).atBody).toBe("ltr");

		const sidebar = await box(page.locator(SIDEBAR));
		const list = await box(page.locator(LIST));
		const reader = await box(page.locator(READER));
		expect(sidebar.x).toBeLessThan(10);
		expect(list.x).toBeGreaterThan(sidebar.x);
		expect(reader.x).toBeGreaterThan(list.x);

		// The panels are in reading order in the DOM, with no direction overrides.
		const group = page.locator("#kite-sidebar-layout");
		await expect(group.locator("> *").first()).toHaveAttribute("id", SIDEBAR.slice(1));
		expect(await group.evaluate((element) => getComputedStyle(element).direction)).toBe("ltr");
		await expect(page.getByRole("separator", { name: "Resize left menu" })).toBeVisible();

		// Dragging keeps working the old way.
		await dragBy(page, page.getByRole("separator", { name: "Resize message list" }), 80);
		await expect(async () => {
			expect((await box(page.locator(LIST))).width).toBeGreaterThan(list.width + 60);
		}).toPass();

		await page.getByRole("button", { name: "Compose new email" }).click();
		const composer = await box(page.getByRole("region", { name: "Compose message" }));
		expect(composer.x + composer.width).toBeGreaterThan(1700 - 64);

		const time = page.locator("[data-message-row] time").first();
		expect(await time.textContent()).not.toMatch(/[⁨⁩]/);
		expect(await page.evaluate(() => getComputedStyle(document.querySelector(".truncate")!).unicodeBidi)).not.toBe(
			"plaintext",
		);
	});
});

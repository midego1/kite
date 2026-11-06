import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, setSendingSettings, signIn, uniqueToken } from "./support/helpers";

// The interface direction setting (ROADMAP milestone 1): Left to right and Right to left are stored like the reading
// layout, Automatic follows the interface language, and <html dir> is right before the first paint. A mirrored interface keeps every drag, key and floating window on the correct side; a left-to-right one is
// untouched, and a change from elsewhere never throws away what is being typed.

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
		await expect(page.getByText("Left to right until Kite is translated.")).toBeVisible();
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

	test("arrow keys move through the menu's radio groups and follow the direction", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("kite-layout-sync", "off"));
		await openInbox(page);
		await page.getByRole("button", { name: "Open account menu" }).click();
		const density = page.getByRole("radiogroup", { name: "Density" });
		const checked = density.getByRole("radio", { checked: true });
		await checked.focus();
		const start = await checked.getAttribute("aria-label");
		await page.keyboard.press("ArrowRight");
		await expect(density.getByRole("radio", { checked: true })).not.toHaveAttribute("aria-label", start!);
		await expect(density.getByRole("radio", { checked: true })).toBeFocused();
		await page.keyboard.press("ArrowLeft");
		await expect(density.getByRole("radio", { checked: true })).toHaveAttribute("aria-label", start!);

		// Mirrored, the arrow pointing along the reading direction goes forward.
		await page.getByRole("radio", { name: "Right to left" }).click();
		await expectDirection(page, "rtl");
		await page.getByRole("button", { name: "Open account menu" }).click();
		const mirrored = page.getByRole("radiogroup", { name: "Density" });
		await mirrored.getByRole("radio", { checked: true }).focus();
		await page.keyboard.press("ArrowLeft");
		await expect(mirrored.getByRole("radio", { checked: true })).not.toHaveAttribute("aria-label", start!);
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

	test("Automatic mirrors only an Arabic interface, whatever else the browser reads, and a choice wins", async ({
		browser,
	}) => {
		for (const [locale, direction] of [
			["ar-EG", "rtl"],
			["he", "ltr"],
			["fa-IR", "ltr"],
			["nl-NL", "ltr"],
		] as const) {
			const context = await browser.newContext({ locale, storageState: STORAGE_STATE });
			const page = await context.newPage();
			await page.addInitScript(() => localStorage.setItem("kite-layout-sync", "off"));
			await watchFirstPaintDirection(page);
			await page.goto("/inbox");
			await expect(page.locator(SIDEBAR)).toBeVisible();
			expect((await firstPaintDirection(page)).atBody, locale).toBe(direction);
			await expectDirection(page, direction);
			await context.close();
		}
		for (const choice of ["ltr", "rtl"] as const) {
			const context = await browser.newContext({ locale: "ar-EG", storageState: STORAGE_STATE });
			const page = await context.newPage();
			await chooseDirection(page, choice);
			await page.goto("/inbox");
			await expect(page.locator(SIDEBAR)).toBeVisible();
			await expectDirection(page, choice);
			await context.close();
		}
	});

	test("signed-out pages follow the same rule: a browser language or a choice made here", async ({ browser }) => {
		const signedOut = { cookies: [], origins: [] };
		const context = await browser.newContext({ locale: "fr-FR", storageState: signedOut });
		const page = await context.newPage();
		await page.goto("/login");
		await expect(page.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
		await expectDirection(page, "ltr");
		await context.close();

		const chosen = await browser.newContext({ locale: "en-US", storageState: signedOut });
		const chosenPage = await chosen.newPage();
		await chooseDirection(chosenPage, "rtl");
		await chosenPage.goto("/login");
		await expectDirection(chosenPage, "rtl");
		await chosen.close();
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

		// On the next browser the account's choice lands in storage and waits for a navigation.
		const second = await openDevice(browser);
		await expect.poll(() => second.evaluate((key) => localStorage.getItem(key), DIRECTION_KEY)).toBe("rtl");
		await expectDirection(second, "ltr");
		await second.getByRole("link", { name: "Sent" }).first().click();
		await expectDirection(second, "rtl");
		await second.context().close();
		await first.context().close();
	});
});

test.describe("a change from elsewhere", () => {
	/**
	 * Starts a reply to a message of its own (a draft from another test would come back) and types into it; the composer's
	 * editor is marked to tell a remount from a survivor.
	 */
	async function typeReply(page: Page, text: string) {
		const replySubject = `Reply kept ${uniqueToken()}`;
		const api = await apiContext(STORAGE_STATE);
		await deliverInbound(api, {
			from: `"Keeper" <keeper@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject: replySubject,
			text: "Answer me.",
		});
		await api.dispose();
		await openInbox(page);
		await openMessage(page, replySubject);
		await page.getByRole("button", { name: /^Reply to / }).click();
		const body = page.getByRole("main").getByRole("textbox", { name: "Message body" });
		await expect(body).toHaveAttribute("contenteditable", "true");
		await body.click();
		await page.keyboard.type(text);
		await expect(body).toContainText(text);
		await body.evaluate((element) => element.setAttribute("data-rtl-probe", "typed"));
		return body;
	}

	test("another tab's choice waits for a navigation and leaves a typed reply alone", async ({ page }) => {
		await chooseDirection(page, "ltr");
		const text = `Keep me ${uniqueToken()}`;
		const body = await typeReply(page, text);
		const sidebarGroup = page.locator("#kite-sidebar-layout");
		await sidebarGroup.evaluate((element) => element.setAttribute("data-rtl-probe", "group"));

		// A real `storage` event: the other tab shares this one's storage.
		const other = await page.context().newPage();
		await other.goto("/settings/appearance");
		await other.getByRole("button", { name: "Open account menu" }).click();
		await other.getByRole("radio", { name: "Right to left" }).click();
		await expectDirection(other, "rtl");
		await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), DIRECTION_KEY)).toBe("rtl");
		await other.close();

		// Nothing moved under the typing: same direction, same panels, same editor, same text.
		await expect(body).toHaveAttribute("data-rtl-probe", "typed");
		await expect(sidebarGroup).toHaveAttribute("data-rtl-probe", "group");
		await expect(body).toContainText(text);
		await expectDirection(page, "ltr");
		await page.bringToFront();
		await body.click();
		await page.keyboard.type(" and more");
		await expect(body).toContainText(`${text} and more`);

		await page.getByRole("link", { name: "Sent" }).first().click();
		await expectDirection(page, "rtl");
		await expect(page.locator(SIDEBAR)).toBeVisible();
	});

	test("choosing here with a reply open keeps the typed text", async ({ page }) => {
		await chooseDirection(page, "ltr");
		const text = `Still here ${uniqueToken()}`;
		await typeReply(page, text);
		await page.getByRole("button", { name: "Open account menu" }).click();
		await page.getByRole("radio", { name: "Right to left" }).click();
		await expectDirection(page, "rtl");
		await page.locator("body").click({ position: { x: 700, y: 5 } });
		// The reply either stays open or folds into its saved draft, which the reply box reopens.
		const body = page.getByRole("main").getByRole("textbox", { name: "Message body" });
		await expect(async () => {
			if (!(await body.isVisible())) await page.getByRole("button", { name: /^Reply to / }).click({ timeout: 2_000 });
			await expect(body).toContainText(text, { timeout: 2_000 });
		}).toPass();
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

	test("English sentences keep their full stop, placeholders their brackets and code its order", async ({ page }) => {
		await page.goto("/settings/account");
		await expect(page.getByRole("heading", { name: "My account" })).toBeVisible();
		const results = await page.evaluate(() => {
			const main = document.querySelector<HTMLElement>("main")!;
			const host = document.createElement("div");
			host.innerHTML = `
				<div data-case="plain div">Hello there.</div>
				<div data-case="div with a link">Hello <a href="#">there</a>.</div>
				<p data-case="paragraph">Hello there.</p>
				<div class="flex"><span data-case="flex item">Hello there.</span></div>
				<div data-buttons><button type="button">One</button> <button type="button">Two</button></div>
				<kbd data-kbd>⌘K</kbd>
				<ol class="list-decimal ps-5"><li data-marker>Step one.</li></ol>
			`;
			main.insertBefore(host, main.firstChild);
			const charBox = (element: Element, index: number) => {
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
				let node = walker.nextNode();
				let at = index < 0 ? (element.textContent?.length ?? 0) + index : index;
				while (node && at >= (node.textContent?.length ?? 0)) {
					at -= node.textContent?.length ?? 0;
					node = walker.nextNode();
				}
				const range = document.createRange();
				range.setStart(node!, at);
				range.setEnd(node!, at + 1);
				return range.getBoundingClientRect();
			};
			const sentences = Array.from(host.querySelectorAll("[data-case]")).map((element) => {
				const edge = element.getBoundingClientRect();
				const first = charBox(element, 0);
				const stop = charBox(element, -1);
				return {
					name: element.getAttribute("data-case"),
					stopAfterText: stop.left > first.left,
					againstInterfaceStart: Math.abs(stop.right - edge.right) <= 1,
				};
			});
			const [one, two] = Array.from(host.querySelectorAll("[data-buttons] button"));
			const buttonsMirrored = one!.getBoundingClientRect().left > two!.getBoundingClientRect().left;
			const kbd = host.querySelector("[data-kbd]")!;
			const kbdDirection = getComputedStyle(kbd).direction;
			const markerDirection = getComputedStyle(host.querySelector("[data-marker]")!, "::marker").direction;
			host.remove();
			return { sentences, buttonsMirrored, kbdDirection, markerDirection };
		});
		for (const sentence of results.sentences) {
			expect(sentence.stopAfterText, `${sentence.name}: the full stop follows the text`).toBe(true);
			expect(sentence.againstInterfaceStart, `${sentence.name}: lined up with the interface`).toBe(true);
		}
		expect(results.buttonsMirrored, "a row of nothing but buttons still mirrors").toBe(true);
		expect(results.kbdDirection).toBe("ltr");
		expect(results.markerDirection, 'a list number reads "1.", not ".1"').toBe("ltr");

		const email = page.getByPlaceholder("recovery@example.com");
		expect(await email.evaluate((input) => getComputedStyle(input, "::placeholder").unicodeBidi)).toBe("plaintext");
		expect(await email.evaluate((input) => getComputedStyle(input).unicodeBidi)).toBe("plaintext");
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

		// Dragging keeps working the old way. With a message open the session is known, so the saved width has been read
		// and cannot put a drag back, as in the mirrored test above.
		await openMessage(page, subject);
		await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
		await dragBy(page, page.getByRole("separator", { name: "Resize message list" }), 80);
		await expect(async () => {
			expect((await box(page.locator(LIST))).width).toBeGreaterThan(list.width + 60);
		}).toPass({ timeout: 15_000 });

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

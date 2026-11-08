import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";
import { expectEveryModuleOn } from "./support/module-spec";

// The phone tab bar: Mail, the modules that are on, and More (the full mail menu), in the space the
// section pill used to own. It folds away for the reader and Compose and returns from md up to the sidebar.

function primaryNav(page: Page) {
	return page.getByRole("navigation", { name: "Primary" });
}

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("the bar follows the section and More opens the mail menu", async ({ page }) => {
		await page.goto("/inbox");
		const bar = primaryNav(page);
		await expect(bar).toBeVisible();
		await expect(bar.getByRole("link", { name: /^Mail/ })).toHaveAttribute("aria-current", "page");
		for (const label of ["Calendar", "Drive", "Money Watch"]) {
			await expect(bar.getByRole("link", { name: label, exact: true })).toBeVisible();
		}

		await bar.getByRole("link", { name: "Calendar", exact: true }).click();
		await expect(page).toHaveURL(/\/calendar$/);
		await expect(bar.getByRole("link", { name: "Calendar", exact: true })).toHaveAttribute("aria-current", "page");

		await bar.getByRole("link", { name: "Drive", exact: true }).click();
		await expect(page).toHaveURL(/\/drive$/);
		await expect(bar.getByRole("link", { name: "Drive", exact: true })).toHaveAttribute("aria-current", "page");

		await bar.getByRole("link", { name: "Money Watch", exact: true }).click();
		await expect(page).toHaveURL(/\/finance$/);
		await expect(bar.getByRole("link", { name: "Money Watch", exact: true })).toHaveAttribute("aria-current", "page");

		await bar.getByRole("button", { name: "More navigation" }).click();
		const menu = page.getByRole("dialog", { name: "Menu" });
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("link", { name: /^Inbox\b/ })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
	});

	test("a module that is off has no tab, and its slot goes to a core folder", async ({ page }) => {
		const api = await apiContext(STORAGE_STATE);
		try {
			await setModuleState(api, { modules: { drive: false } });
			await page.goto("/inbox");
			const bar = primaryNav(page);
			await expect(bar).toBeVisible();
			await expect(bar.getByRole("link", { name: "Drive", exact: true })).toHaveCount(0);
			for (const label of ["Mail", "Calendar", "Money Watch", "Starred"]) {
				await expect(bar.getByRole("link", { name: new RegExp(`^${label}`) })).toBeVisible();
			}
			await expect(bar.getByRole("button", { name: "More navigation" })).toBeVisible();
		} finally {
			await restoreModules(api);
			await api.dispose();
		}
	});

	test("the Money Watch tab shows a short label that is not clipped at 320 px", async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await page.goto("/inbox");
		const tab = primaryNav(page).getByRole("link", { name: "Money Watch", exact: true });
		await expect(tab).toBeVisible();
		await expect(tab).toContainText("Money");
		const clipped = await tab.locator("span.truncate").evaluate((label) => label.scrollWidth > label.clientWidth);
		expect(clipped).toBe(false);
	});

	test("opening a message and Compose hide the bar, and Back brings it back", async ({ page }) => {
		await page.goto("/inbox");
		await expect(primaryNav(page)).toBeVisible();

		await openMessage(page, "Cannot access workspace");
		await expect(primaryNav(page)).toHaveCount(0);

		await page.getByRole("button", { name: "Back to Inbox" }).click();
		await expect(page).toHaveURL(/\/inbox$/);
		await expect(primaryNav(page)).toBeVisible();

		await page.goto("/compose");
		await expect(primaryNav(page)).toHaveCount(0);
	});

	test("the floating composer hides the bar until it closes", async ({ page }) => {
		await page.goto("/inbox");
		await primaryNav(page).getByRole("button", { name: "More navigation" }).click();
		await page
			.getByRole("dialog", { name: "Menu" })
			.getByRole("button", { name: /^Compose/ })
			.click();
		await expect(primaryNav(page)).toHaveCount(0);

		await page.getByRole("button", { name: "Close composer" }).first().click();
		await expect(primaryNav(page)).toBeVisible();
	});

	test("the Settings pill sits above the bar instead of over it", async ({ page }) => {
		await page.goto("/settings/account");
		const bar = primaryNav(page);
		const pill = page.getByRole("button", { name: "My account", exact: true });
		await expect(bar).toBeVisible();
		await expect(pill).toBeVisible();
		const [pillBox, barBox] = await Promise.all([pill.boundingBox(), bar.boundingBox()]);
		expect(pillBox && barBox && pillBox.y + pillBox.height <= barBox.y).toBe(true);
	});

	test("New mail floats above the bar on a mail screen, and is gone where it would be the wrong action", async ({
		page,
	}) => {
		await page.goto("/inbox");
		const bar = primaryNav(page);
		const fab = page.locator("[data-mobile-compose-fab]");
		await expect(fab).toBeVisible();
		const fabBox = await fab.boundingBox();
		expect(fabBox && fabBox.width >= 44 && fabBox.height >= 44).toBe(true);
		const barBox = await bar.boundingBox();
		expect(fabBox && barBox && fabBox.y + fabBox.height <= barBox.y).toBe(true);

		await fab.click();
		await expect(page.getByRole("button", { name: "Close composer" }).first()).toBeVisible();
		await page.getByRole("button", { name: "Close composer" }).first().click();

		// Calendar and Drive have their own primary action; Mail's compose button would be the wrong one there.
		await page.goto("/calendar");
		await expect(fab).toHaveCount(0);
		await page.goto("/drive");
		await expect(fab).toHaveCount(0);

		// An open message already offers Reply, so the button steps aside rather than sitting over its reply bar.
		await page.goto("/inbox");
		await openMessage(page, "Cannot access workspace");
		await expect(fab).toHaveCount(0);
	});
});

test("the bar folds away at the sidebar breakpoint and returns when the window narrows", async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 800 });
	await page.goto("/inbox");
	await expect(primaryNav(page)).toHaveCount(0);
	await expect(
		page
			.locator("aside")
			.first()
			.getByRole("link", { name: /^Inbox\b/ }),
	).toBeVisible();

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(primaryNav(page)).toBeVisible();
	await page.setViewportSize({ width: 1024, height: 800 });
	await expect(primaryNav(page)).toHaveCount(0);
});

test.describe("on an unfolded screen with the list beside the reader", () => {
	test.use({ viewport: { width: 720, height: 900 }, hasTouch: true });

	let subject: string;

	test.beforeAll(async () => {
		const api = await apiContext(STORAGE_STATE);
		subject = `Tab bar pane ${uniqueToken()}`;
		await deliverInbound(api, {
			from: `"Tab Sender" <tabs@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject,
			text: "Read beside the list.",
		});
		await api.dispose();
	});

	test("the bar stays while a message is open and goes once the list is hidden", async ({ page }) => {
		await page.goto("/inbox");
		await expect(page.locator("[data-reading-pane]")).toHaveAttribute("data-reading-pane", "right");
		await expect(primaryNav(page)).toBeVisible();
		// New mail is reachable before a message is open, beside the empty reading pane.
		await expect(page.locator("[data-mobile-compose-fab]")).toBeVisible();

		await openMessage(page, subject);
		const list = page.getByRole("main").locator("[data-density]");
		await expect(list).toBeVisible();
		await expect(primaryNav(page)).toBeVisible();
		// The open message's own reply bar sits where New mail would float, so it steps aside here too.
		await expect(page.locator("[data-mobile-compose-fab]")).toHaveCount(0);

		// The reader alone is the full-screen view again, so the bar steps aside as it does on a phone.
		await page.getByRole("button", { name: "Hide email list" }).click();
		await expect(list).toBeHidden();
		await expect(primaryNav(page)).toHaveCount(0);
		await page.getByRole("button", { name: "Show email list" }).click();
		await expect(primaryNav(page)).toBeVisible();
	});

	test("Compose still hides the bar", async ({ page }) => {
		await page.goto("/compose");
		await expect(primaryNav(page)).toHaveCount(0);
	});
});

// Fails this file when one of its tests left a module off or a user restricted.
test.afterAll(async () => {
	await expectEveryModuleOn();
});

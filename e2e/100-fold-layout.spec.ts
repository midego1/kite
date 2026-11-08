import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";
import { chooseOption } from "./support/select";

// Foldable layout: a folded cover screen keeps the phone's single pane, an unfolded inner screen shows the
// list and reader side by side, and the Appearance setting can force either posture on any device.

const FOLDED = { width: 390, height: 844 };
const UNFOLDED = { width: 884, height: 1104 };
const LANDSCAPE_PHONE = { width: 844, height: 390 };
const NARROW_WINDOW = { width: 900, height: 800 };
// The narrowest phone-shell width that still has room for the list and the reader.
const TWO_PANES_MIN = { width: 700, height: 900 };
const SMALL_TABLET = { width: 800, height: 1000 };
const DESKTOP = { width: 1440, height: 900 };

// A tablet or an unfolded foldable has a touch screen; a mouse window of the same width is just a narrow desktop.
test.use({ hasTouch: true });

let subject: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	subject = `Foldable pane ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Fold Sender" <fold@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Read across the fold.",
	});
	await api.dispose();
});

async function expectPosture(page: Page, posture: "folded" | "unfolded" | "desktop") {
	await expect(page.locator("html")).toHaveAttribute("data-fold-posture", posture);
}

async function chooseFoldLayout(page: Page, value: "auto" | "single" | "two") {
	await page.goto("/settings/appearance");
	await chooseOption(page.getByRole("combobox", { name: "Fold layout" }), value);
	await expect(page.locator("html")).toHaveAttribute("data-fold-layout", value === "auto" ? /.+/ : value);
}

test("a folded phone keeps one pane and Back returns to the list", async ({ page }) => {
	await page.setViewportSize(FOLDED);
	await page.goto("/inbox");
	await expectPosture(page, "folded");
	await expect(page.locator("[data-reading-pane]")).toHaveCount(0);

	const list = page.getByRole("list", { name: "Inbox" });
	await expect(list.getByText(subject, { exact: true })).toBeVisible();
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByRole("list", { name: "Inbox" })).toHaveCount(0);
	await page.getByRole("button", { name: "Back to Inbox" }).click();
	await expect(page).toHaveURL(/\/inbox$/);
	await expect(page.getByRole("list", { name: "Inbox" }).getByText(subject, { exact: true })).toBeVisible();
});

test("an unfolded tablet shows the list beside the reader", async ({ page }) => {
	await page.setViewportSize(UNFOLDED);
	await page.goto("/inbox");
	await expectPosture(page, "unfolded");
	const layout = page.locator("[data-reading-pane]");
	await expect(layout).toHaveAttribute("data-reading-pane", "right");
	await expect(page.getByTestId("reading-pane-empty")).toBeVisible();

	await openMessage(page, subject);
	const heading = page.getByRole("heading", { level: 1, name: subject });
	await expect(heading).toBeVisible();
	const list = page.getByRole("main").locator("[data-density]");
	await expect(list.getByText(subject, { exact: true })).toBeVisible();
	const listBox = await list.boundingBox();
	const headingBox = await heading.boundingBox();
	expect(listBox && headingBox && listBox.x + listBox.width <= headingBox.x).toBe(true);
	// No Viewport Segments API in this browser, so there is no hinge to reserve space for.
	await expect(layout).not.toHaveAttribute("data-fold-hinge", /.+/);
});

// At this width the phone shell's own breakpoint (768px) has already switched to the desktop sidebar, which
// is built for a mouse: row actions must still not depend on hovering, because an unfolded foldable or
// tablet this wide is still a touch screen (message-list-row-actions.tsx's `pointer-coarse:` styling).
test("an unfolded tablet's row actions work without hovering", async ({ page }) => {
	await page.setViewportSize(UNFOLDED);
	await page.goto("/inbox");
	await expectPosture(page, "unfolded");

	const list = page.getByRole("main").locator("[data-density]");
	const row = list.locator("[data-message-row]").filter({ hasText: subject });
	await expect(row).toBeVisible();
	for (const name of ["Archive", "Trash", "Snooze"]) {
		const button = row.getByRole("button", { name, exact: true });
		await expect(button).toBeVisible();
		const box = await button.boundingBox();
		expect(box && box.width >= 44 && box.height >= 44, `${name} is at least 44x44`).toBe(true);
	}
});

test("an unfolded tablet keeps the No split and Below inbox choices", async ({ page }) => {
	await page.setViewportSize(UNFOLDED);
	// Only the first load: the later one must keep the choice made in between.
	await page.addInitScript(() => {
		if (!localStorage.getItem("kite-reading-pane")) localStorage.setItem("kite-reading-pane", "none");
	});
	await page.goto("/inbox");
	await expectPosture(page, "unfolded");
	await expect(page.locator("[data-reading-pane]")).toHaveCount(0);
	await openMessage(page, subject);
	await expect(page.getByRole("button", { name: "Back to Inbox" })).toBeVisible();

	await page.evaluate(() => {
		localStorage.setItem("kite-reading-pane", "below");
		window.dispatchEvent(new Event("kite:reading-layout-changed"));
	});
	await page.goto("/inbox");
	await expect(page.locator("[data-reading-pane]")).toHaveAttribute("data-reading-pane", "below");
});

test("the email list can be hidden and shown again below the desktop width", async ({ page }) => {
	await page.setViewportSize(UNFOLDED);
	await page.goto("/inbox");
	await openMessage(page, subject);
	const list = page.getByRole("main").locator("[data-density]");
	await expect(list).toBeVisible();
	await page.getByRole("button", { name: "Hide email list" }).click();
	await expect(list).toBeHidden();
	await page.getByRole("button", { name: "Show email list" }).click();
	await expect(list).toBeVisible();
});

test("a phone held sideways keeps one pane", async ({ page }) => {
	await page.setViewportSize(LANDSCAPE_PHONE);
	await page.goto("/inbox");
	await expectPosture(page, "folded");
	await expect(page.locator("[data-reading-pane]")).toHaveCount(0);
	await openMessage(page, subject);
	await expect(page.getByRole("button", { name: "Back to Inbox" })).toBeVisible();
});

test("two panes that cannot fit fall back to one pane", async ({ page }) => {
	// A small tablet next to the 260px sidebar leaves less than the list and reader need.
	await page.setViewportSize(SMALL_TABLET);
	await page.goto("/inbox");
	await expectPosture(page, "unfolded");
	await expect(page.locator("[data-reading-pane]")).toHaveCount(0);
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByRole("button", { name: "Back to Inbox" })).toBeVisible();
});

test.describe("a fold with a hinge", () => {
	const FIRST = { left: 0, top: 0, width: 600, height: 900 };
	const SECOND = { left: 640, top: 0, width: 600, height: 900 };

	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1240, height: 900 });
		await page.addInitScript(
			(segments) => {
				Object.defineProperty(window, "viewport", { value: { segments }, configurable: true });
			},
			[FIRST, SECOND],
		);
	});

	async function expectClearOfHinge(page: Page) {
		const list = page.locator("#kite-message-list-panel");
		const reader = page.locator("#kite-reader-panel");
		await expect(page.locator("[data-reading-pane]")).toHaveAttribute("data-fold-hinge", "vertical");
		await expect(async () => {
			const listBox = await list.boundingBox();
			const readerBox = await reader.boundingBox();
			expect(readerBox).not.toBeNull();
			expect(readerBox!.x).toBeGreaterThanOrEqual(SECOND.left - 1);
			expect(readerBox!.x + readerBox!.width).toBeLessThanOrEqual(SECOND.left + SECOND.width + 1);
			if (listBox && listBox.width > 0) expect(listBox.x + listBox.width).toBeLessThanOrEqual(FIRST.width + 1);
		}).toPass();
	}

	test("stacked panes ignore the hinge", async ({ page }) => {
		await page.addInitScript(() => {
			if (!localStorage.getItem("kite-reading-pane")) localStorage.setItem("kite-reading-pane", "below");
		});
		await page.goto("/inbox");
		await expectPosture(page, "unfolded");
		const layout = page.locator("[data-reading-pane]");
		await expect(layout).toHaveAttribute("data-reading-pane", "below");
		await expect(layout).not.toHaveAttribute("data-fold-hinge", /.+/);
		const list = await page.locator("#kite-message-list-panel").boundingBox();
		const reader = await page.locator("#kite-reader-panel").boundingBox();
		// One above the other, each as wide as the page, across the hinge.
		expect(list!.y + list!.height).toBeLessThanOrEqual(reader!.y + 1);
		expect(reader!.x + reader!.width).toBeGreaterThan(SECOND.left + 100);
		expect(list!.width).toBeGreaterThan(FIRST.width - 260);
	});

	test("the list stays on the first screen and the reader on the second", async ({ page }) => {
		// A saved list width from the desktop would reach into the hinge.
		await page.addInitScript(() => localStorage.setItem("kite-reading-pane", "right"));
		await page.goto("/inbox");
		await expectPosture(page, "unfolded");
		await expectClearOfHinge(page);
		await openMessage(page, subject);
		await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
		await expectClearOfHinge(page);
		await page.getByRole("button", { name: "Hide email list" }).click();
		await expectClearOfHinge(page);
		await page.getByRole("button", { name: "Show email list" }).click();
		await expectClearOfHinge(page);
	});
});

test("a desktop keeps the existing reading-pane preference", async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto("/inbox");
	await expectPosture(page, "desktop");
	await expect(page.locator("[data-reading-pane]")).toHaveAttribute("data-reading-pane", "right");
	await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
});

test.describe("a mouse window", () => {
	test.use({ hasTouch: false });

	test("is a narrow desktop and keeps one pane", async ({ page }) => {
		await page.setViewportSize(NARROW_WINDOW);
		await page.goto("/inbox");
		await expectPosture(page, "desktop");
		await expect(page.locator("[data-reading-pane]")).toHaveCount(0);
	});

	test("opening the docked assistant on a desktop keeps the split without rebuilding it", async ({ page }) => {
		// Narrow enough that the assistant leaves the panes under the minimum two-pane width (539 px).
		await page.setViewportSize({ width: 1030, height: 900 });
		await page.goto("/inbox");
		await expectPosture(page, "desktop");
		await openMessage(page, subject);
		const assistant = page.getByRole("button", { name: "Open email assistant" });
		test.skip((await assistant.count()) === 0, "The assistant is not enabled in this environment.");
		const group = page.locator("[data-reading-pane]");
		await group.evaluate((element) => ((window as unknown as { __group: Element }).__group = element));
		await assistant.click();
		await expect(page.getByRole("button", { name: "Close email assistant" })).toBeVisible();
		// The page panel narrows with a transition; check only once it is under the two-pane minimum.
		await expect.poll(async () => (await page.getByRole("main").boundingBox())?.width ?? Infinity).toBeLessThan(539);
		await expect(group).toHaveAttribute("data-reading-pane", "right");
		expect(
			await page.evaluate(
				() => (window as unknown as { __group: Element }).__group === document.querySelector("[data-reading-pane]"),
			),
		).toBe(true);
	});
});

test("the Appearance setting forces one or two panes on any device", async ({ page }) => {
	await page.setViewportSize(TWO_PANES_MIN);
	await chooseFoldLayout(page, "two");
	await expectPosture(page, "unfolded");
	await page.goto("/inbox");
	await expect(page.locator("[data-reading-pane]")).toHaveAttribute("data-reading-pane", "right");
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByRole("main").locator("[data-density]").getByText(subject, { exact: true })).toBeVisible();

	// On the cover screen itself there is no room for two panes, so the choice falls back to one.
	await page.setViewportSize(FOLDED);
	await expectPosture(page, "unfolded");
	await expect(page.locator("[data-reading-pane]")).toHaveCount(0);

	await page.setViewportSize(DESKTOP);
	await chooseFoldLayout(page, "single");
	await expectPosture(page, "folded");
	await page.goto("/inbox");
	await expect(page.locator("[data-reading-pane]")).toHaveCount(0);
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByRole("main").locator("[data-density]")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Back to Inbox" })).toBeVisible();
});

test("folding and unfolding live keeps the open message", async ({ page }) => {
	await page.setViewportSize(UNFOLDED);
	await page.goto("/inbox");
	await openMessage(page, subject);
	const messageUrl = page.url();
	const heading = page.getByRole("heading", { level: 1, name: subject });
	await expect(heading).toBeVisible();
	await expect(page.getByRole("main").locator("[data-density]")).toBeVisible();

	await page.setViewportSize(FOLDED);
	await expectPosture(page, "folded");
	await expect(heading).toBeVisible();
	await expect(page.getByRole("main").locator("[data-density]")).toHaveCount(0);
	expect(page.url()).toBe(messageUrl);

	await page.setViewportSize(UNFOLDED);
	await expectPosture(page, "unfolded");
	await expect(heading).toBeVisible();
	await expect(page.getByRole("main").locator("[data-density]")).toBeVisible();
	expect(page.url()).toBe(messageUrl);
});

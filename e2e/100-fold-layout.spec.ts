import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";
import { chooseOption } from "./support/select";

// Foldable layout: a folded cover screen keeps the phone's single pane, an unfolded inner screen shows the
// list and reader side by side, and the Appearance setting can force either posture on any device.

const FOLDED = { width: 390, height: 844 };
const UNFOLDED = { width: 884, height: 1104 };
const DESKTOP = { width: 1440, height: 900 };

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

test("a desktop keeps the existing reading-pane preference", async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto("/inbox");
	await expectPosture(page, "desktop");
	await expect(page.locator("[data-reading-pane]")).toHaveAttribute("data-reading-pane", "right");
	await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
});

test("the Appearance setting forces one or two panes on any device", async ({ page }) => {
	await page.setViewportSize(FOLDED);
	await chooseFoldLayout(page, "two");
	await expectPosture(page, "unfolded");
	await page.goto("/inbox");
	await expect(page.locator("[data-reading-pane]")).toHaveAttribute("data-reading-pane", "right");
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByRole("main").locator("[data-density]").getByText(subject, { exact: true })).toBeVisible();

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

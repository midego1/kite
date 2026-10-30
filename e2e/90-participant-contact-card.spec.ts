import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

// The thread header's participant chips are buttons: hover shows the full address, click opens a contact
// card with Copy, New email, Show all mail from and the contact actions. The sender name in the message
// opens the same card.

/** Set to a directory to save the card's screenshots there (the PR's). */
const SHOT_DIR = process.env.CARD_SHOT_DIR;

const FIRST = "hi@cursor-card.test";
const SECOND = "roshni@cursor-card.test";
const NAME = "Roshni at Cursor";

let subject: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	subject = `Card ${token}`;
	const first = await deliverInbound(api, {
		from: `"${NAME}" <${FIRST}>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "First message of the card thread.",
		messageId: `<${token}-1@e2e.test>`,
	});
	expect(first.id).toBeTruthy();
	// The same person writes again from a second address, in the same conversation.
	await deliverInbound(api, {
		from: `"${NAME}" <${SECOND}>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: ${subject}`,
		text: "Second message of the card thread.",
		messageId: `<${token}-2@e2e.test>`,
		inReplyTo: `<${token}-1@e2e.test>`,
	});
	await api.dispose();
});

async function openThread(page: Page, variant?: { style: string; theme: string }) {
	if (variant) {
		await page.addInitScript(({ style, theme }) => {
			localStorage.setItem("kite-style", style);
			localStorage.setItem("kite-theme", theme);
		}, variant);
	}
	await page.goto("/inbox");
	await openMessage(page, new RegExp(`${subject}$`));
	await expect(page.getByRole("heading", { level: 1, name: /Card / })).toBeVisible();
	return page.getByRole("list", { name: "Participants" });
}

/** A click before hydration does nothing, so click again until the card shows. */
async function openCard(page: Page, chip: Locator) {
	const card = page.getByRole("dialog", { name: /Contact card for/ });
	await expect(async () => {
		if (!(await card.isVisible())) await chip.click();
		await expect(card).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 20_000 });
	return card;
}

test("hover and focus show the full address and how many others the person used", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const chips = await openThread(page);
	const chip = chips.getByRole("button", { name: new RegExp(NAME) });
	await expect(chip).toHaveAttribute("aria-haspopup", "dialog");
	await expect(chip).toHaveAttribute("aria-expanded", "false");
	await chip.hover();
	const tip = page.getByRole("tooltip");
	await expect(tip).toContainText(/@cursor-card\.test/);
	await expect(tip).toContainText("+1 more address");
	await page.mouse.move(5, 5);
	await expect(tip).toHaveCount(0);
	// Keyboard focus shows it too.
	await chip.focus();
	await expect(page.getByRole("tooltip")).toContainText("+1 more address");
});

test("click opens the contact card: address, Copy, New email, Show all mail from, Escape", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.setViewportSize({ width: 1440, height: 900 });
	const chips = await openThread(page);
	const chip = chips.getByRole("button", { name: new RegExp(NAME) });
	const card = await openCard(page, chip);
	await expect(chip).toHaveAttribute("aria-expanded", "true");
	await expect(card).toContainText(NAME);
	const address = await card.locator("[data-contact-card-address]").innerText();
	expect([FIRST, SECOND]).toContain(address);
	await expect(card.getByRole("button", { name: "New email" })).toBeVisible();
	await expect(card.getByRole("button", { name: `Show all mail from ${NAME}` })).toBeVisible();
	await expect(card.getByRole("button", { name: /Add to contacts|Edit contact/ })).toBeVisible();
	await expect(card.getByRole("button", { name: "Block contact" })).toBeVisible();

	// Copy puts the address on the clipboard.
	await card.getByRole("button", { name: "Copy address" }).click();
	await expect(card.getByRole("button", { name: "Address copied" })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);

	// Tab order stays inside the card's controls and Escape closes it, returning the focus to the chip.
	await page.keyboard.press("Escape");
	await expect(card).toHaveCount(0);
	await expect(chip).toBeFocused();
	await expect(chip).toHaveAttribute("aria-expanded", "false");

	// Enter opens it from the keyboard; a click outside closes it.
	await page.keyboard.press("Enter");
	await expect(page.getByRole("dialog", { name: /Contact card for/ })).toBeVisible();
	await page.mouse.click(5, 5);
	await expect(page.getByRole("dialog", { name: /Contact card for/ })).toHaveCount(0);

	// New email opens the composer addressed to the person.
	const again = await openCard(page, chip);
	await again.getByRole("button", { name: "New email" }).click();
	await expect(page.getByRole("button", { name: `Remove ${address}` })).toBeVisible({ timeout: 20_000 });
	await page.keyboard.press("Escape");
});

test("Show all mail from searches the person's mail in the list", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const chips = await openThread(page);
	const card = await openCard(page, chips.getByRole("button", { name: new RegExp(NAME) }));
	const address = await card.locator("[data-contact-card-address]").innerText();
	await card.getByRole("button", { name: `Show all mail from ${NAME}` }).click();
	await expect(page).toHaveURL(/\/inbox$/);
	await expect(page.getByRole("textbox", { name: "Search mail" })).toHaveValue(`from:${address}`);
	await expect(
		page
			.getByRole("main")
			.getByText(new RegExp(`${subject}$`))
			.first(),
	).toBeVisible();
	await expect(page.getByRole("main").getByText(`Re: ${subject}`).first()).toBeVisible();
});

test("the sender name in the message opens the same card", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openThread(page);
	const sender = page.locator("article").getByRole("button", { name: NAME });
	const card = await openCard(page, sender);
	await expect(card).toContainText(NAME);
	await expect(card.getByRole("button", { name: "New email" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(card).toHaveCount(0);
});

test("your own address says You and offers no actions about someone else", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const chips = await openThread(page);
	const own = chips.getByRole("button", { name: /support|Support/ }).first();
	const card = await openCard(page, own);
	await expect(card.getByText("You", { exact: true })).toBeVisible();
	await expect(card.locator("[data-contact-card-address]")).toHaveText(SUPPORT_ADDRESS);
	await expect(card.getByRole("button", { name: "Copy address" })).toBeVisible();
	await expect(card.getByRole("button", { name: "New email" })).toHaveCount(0);
	await expect(card.getByRole("button", { name: /Show all mail from/ })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Block contact" })).toHaveCount(0);
});

test("on a phone the card fits the screen", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const chips = await openThread(page);
	const card = await openCard(page, chips.getByRole("button", { name: new RegExp(NAME) }));
	const box = (await card.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(390);
	expect(box.y + box.height).toBeLessThanOrEqual(844);
	await card.getByRole("button", { name: "Show all mail from Roshni at Cursor" }).click();
	await expect(page).toHaveURL(/\/inbox$/);
});

if (SHOT_DIR) {
	for (const variant of [
		{ name: "kite-light", style: "kite", theme: "light" },
		{ name: "kite-dark", style: "kite", theme: "dark" },
		{ name: "classic-light", style: "classic", theme: "light" },
		{ name: "classic-dark", style: "classic", theme: "dark" },
	]) {
		test(`screenshots (${variant.name})`, async ({ page }) => {
			mkdirSync(SHOT_DIR, { recursive: true });
			await page.setViewportSize({ width: 1440, height: 900 });
			const chips = await openThread(page, variant);
			const chip = chips.getByRole("button", { name: new RegExp(NAME) });
			// The conversation loads after the header, so the other address shows once it has.
			await expect(async () => {
				await chip.hover();
				await expect(page.getByRole("tooltip")).toContainText("+1 more address", { timeout: 1_500 });
			}).toPass({ timeout: 20_000 });
			await page.screenshot({
				path: `${SHOT_DIR}/tooltip-${variant.name}.png`,
				clip: { x: 0, y: 0, width: 1440, height: 420 },
			});
			await openCard(page, chip);
			await page.mouse.move(700, 800);
			await page.screenshot({
				path: `${SHOT_DIR}/card-${variant.name}.png`,
				clip: { x: 0, y: 0, width: 1440, height: 520 },
			});
		});
	}
}

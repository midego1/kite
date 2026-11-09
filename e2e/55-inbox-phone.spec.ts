import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// Below md the inbox shows one pane at a time: the list, or the open email with a back button. The sidebar
// is a sheet that slides over the page from the menu button.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

let subject: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	subject = `Phone pane ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Phone Sender" <phone@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Read on a phone.",
	});
	await api.dispose();
});

test("opening an email replaces the list, and Back returns to it", async ({ page }) => {
	await page.goto("/inbox");
	const list = page.getByRole("list", { name: "Inbox" });
	await expect(list.getByText(subject, { exact: true })).toBeVisible();
	await expect(page.locator("[data-reading-pane]")).toHaveCount(0);

	await list.getByText(subject, { exact: true }).click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByRole("list", { name: "Inbox" })).toHaveCount(0);
	// The reader's toolbar stays on one row on a phone.
	const toolbar = page.getByRole("button", { name: "More actions" });
	const back = page.getByRole("button", { name: "Back to Inbox" });
	expect(Math.abs((await toolbar.boundingBox())!.y - (await back.boundingBox())!.y)).toBeLessThan(4);
	await expect(page.getByRole("button", { name: /^Reply to Phone Sender/ })).toBeVisible();

	await back.click();
	await expect(page).toHaveURL(/\/inbox$/);
	await expect(page.getByRole("list", { name: "Inbox" }).getByText(subject, { exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toHaveCount(0);
});

test("the menu opens the sidebar as a sheet, which closes on navigation and on Escape", async ({ page }) => {
	await page.goto("/inbox");
	const menuButton = page.getByRole("button", { name: "Open menu" });
	await menuButton.click();
	const sheet = page.getByRole("dialog", { name: "Menu" });
	await expect(sheet).toBeVisible();
	await expect(page.locator("[data-mobile-menu]")).toHaveAttribute("aria-expanded", "true");
	await sheet.getByRole("link", { name: /^Starred\b/ }).click();
	await expect(page).toHaveURL(/\/starred$/);
	await expect(sheet).toHaveCount(0);

	await menuButton.click();
	await expect(sheet).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expect(menuButton).toBeFocused();

	await menuButton.click();
	await sheet.getByRole("button", { name: "Close menu" }).click();
	await expect(sheet).toHaveCount(0);
});

test("the list's search and category chips share the phone header without hiding the folder name", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("list", { name: "Inbox" }).getByText(subject, { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Primary", exact: true })).toBeVisible();
	await expect(page.getByRole("textbox", { name: /Search mail/ })).toBeVisible();
	const title = page.getByRole("main").locator("p", { hasText: /^Inbox$/ });
	await expect(title).toBeVisible();
	expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

// A touch screen never hovers, so a row's actions (star, archive, trash, mark read, snooze, move) must not
// depend on it: the corner star and a ⋯ button stay visible at all times, 44px, side by side with no overlap
// (row-actions-menu.tsx), and the ⋯ opens a bottom sheet listing every action — each asserted here by its real
// effect, not just by being on screen (message-list-row.tsx, message-list-row-actions.tsx).

function rowFor(page: Page, subject: string) {
	return page.locator("[data-message-row]").filter({ hasText: subject });
}

async function openRowMenu(page: Page, subject: string) {
	const row = rowFor(page, subject);
	await expect(row).toBeVisible();
	const star = row.getByRole("button", { name: "Star" }).first();
	const more = row.getByRole("button", { name: new RegExp(`^More actions for`) }).first();
	await expect(star).toBeVisible();
	await expect(more).toBeVisible();
	const [starBox, moreBox] = await Promise.all([star.boundingBox(), more.boundingBox()]);
	expect(starBox && starBox.width >= 44 && starBox.height >= 44, "Star is at least 44x44").toBe(true);
	expect(moreBox && moreBox.width >= 44 && moreBox.height >= 44, "More actions is at least 44x44").toBe(true);
	const overlap =
		starBox &&
		moreBox &&
		!(
			starBox.x + starBox.width <= moreBox.x ||
			moreBox.x + moreBox.width <= starBox.x ||
			starBox.y + starBox.height <= moreBox.y ||
			moreBox.y + moreBox.height <= starBox.y
		);
	expect(overlap, "the corner star and the ⋯ button do not overlap").toBe(false);
	await more.click();
	const sheet = page.getByRole("dialog");
	await expect(sheet).toBeVisible();
	return sheet;
}

test("starring and marking a row read or unread from its ⋯ sheet has a real effect", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const starSubject = `Phone star ${uniqueToken()}`;
	const message = await deliverInbound(api, {
		from: `"Phone Sender" <phone@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: starSubject,
	});
	await page.goto("/inbox");

	const sheet = await openRowMenu(page, starSubject);
	await sheet.getByRole("button", { name: "Star" }).click();
	await expect(sheet).toHaveCount(0);
	await expect(rowFor(page, starSubject).getByRole("button", { name: "Star" })).toHaveAttribute("aria-pressed", "true");
	await page.goto("/starred");
	await expect(page.getByRole("main").getByText(starSubject, { exact: true })).toBeVisible();

	await page.goto("/inbox");
	type ReadState = { message: { read: boolean } };
	const readNow = async () => ((await (await api.get(`/api/messages/${message.id}`)).json()) as ReadState).message.read;
	expect(await readNow()).toBe(false);
	const sheet2 = await openRowMenu(page, starSubject);
	await sheet2.getByRole("button", { name: "Mark as read" }).click();
	await expect(sheet2).toHaveCount(0);
	await expect.poll(readNow).toBe(true);
	await api.dispose();
});

test("archiving a row from its ⋯ sheet moves it out of the inbox", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const archiveSubject = `Phone archive ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Phone Sender" <phone@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: archiveSubject,
	});
	await api.dispose();
	await page.goto("/inbox");

	const sheet = await openRowMenu(page, archiveSubject);
	await sheet.getByRole("button", { name: "Archive" }).click();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByRole("main").getByText(archiveSubject, { exact: true })).toHaveCount(0);
	await page.goto("/archived");
	await expect(page.getByRole("main").getByText(archiveSubject, { exact: true })).toBeVisible();
});

test("trashing a row from its ⋯ sheet moves it out of the inbox", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const trashSubject = `Phone trash ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Phone Sender" <phone@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: trashSubject,
	});
	await api.dispose();
	await page.goto("/inbox");

	const sheet = await openRowMenu(page, trashSubject);
	await sheet.getByRole("button", { name: "Trash" }).click();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByRole("main").getByText(trashSubject, { exact: true })).toHaveCount(0);
	await page.goto("/trash");
	await expect(page.getByRole("main").getByText(trashSubject, { exact: true })).toBeVisible();
});

test("snoozing a row from its ⋯ sheet's expandable Snooze entry moves it out of the inbox", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const snoozeSubject = `Phone snooze ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Phone Sender" <phone@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: snoozeSubject,
	});
	await api.dispose();
	await page.goto("/inbox");

	const sheet = await openRowMenu(page, snoozeSubject);
	// The expand toggle, not the submit button the expanded picker reveals (also named "Snooze").
	const snoozeEntry = sheet.getByRole("button", { name: "Snooze", exact: true }).first();
	await expect(snoozeEntry).toHaveAttribute("aria-expanded", "false");
	await snoozeEntry.click();
	await expect(snoozeEntry).toHaveAttribute("aria-expanded", "true");
	await sheet.getByRole("button", { name: /^Tomorrow/ }).click();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByRole("main").getByText(snoozeSubject, { exact: true })).toHaveCount(0);
	await page.goto("/snoozed");
	await expect(page.getByRole("main").getByText(snoozeSubject, { exact: true })).toBeVisible();
});

test("moving a row to spam from its ⋯ sheet's expandable Move to entry moves it out of the inbox", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const spamSubject = `Phone move ${uniqueToken()}`;
	await deliverInbound(api, { from: `"Phone Sender" <phone@outside.test>`, to: SUPPORT_ADDRESS, subject: spamSubject });
	await api.dispose();
	await page.goto("/inbox");

	const sheet = await openRowMenu(page, spamSubject);
	const moveEntry = sheet.getByRole("button", { name: "Move to", exact: true });
	await expect(moveEntry).toHaveAttribute("aria-expanded", "false");
	await moveEntry.click();
	await expect(moveEntry).toHaveAttribute("aria-expanded", "true");
	await sheet.getByRole("button", { name: "Report spam" }).click();
	const confirm = page.getByRole("alertdialog", { name: "Report as spam?" });
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Report spam" }).click();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByRole("main").getByText(spamSubject, { exact: true })).toHaveCount(0);
	await page.goto("/spam");
	await expect(page.getByRole("main").getByText(spamSubject, { exact: true })).toBeVisible();
});

test("the last row's star and ⋯ sheet stay reachable above the floating New mail button", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const lastSubject = `Phone last row ${uniqueToken()}`;
	// Enough messages that one sits at the very bottom of a 844px viewport, right where the FAB floats.
	for (let index = 0; index < 8; index += 1) {
		await deliverInbound(api, {
			from: `"Phone Sender" <phone@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject: index === 7 ? lastSubject : `Phone filler ${index} ${uniqueToken()}`,
		});
	}
	await api.dispose();
	await page.goto("/inbox");

	const lastRow = rowFor(page, lastSubject);
	await lastRow.scrollIntoViewIfNeeded();
	const fab = page.locator("[data-mobile-compose-fab]");
	await expect(fab).toBeVisible();
	const more = lastRow.getByRole("button", { name: new RegExp(`^More actions for`) }).first();
	await expect(more).toBeVisible();
	const [moreBox, fabBox] = await Promise.all([more.boundingBox(), fab.boundingBox()]);
	const coveredByFab =
		moreBox &&
		fabBox &&
		!(
			moreBox.x + moreBox.width <= fabBox.x ||
			fabBox.x + fabBox.width <= moreBox.x ||
			moreBox.y + moreBox.height <= fabBox.y ||
			fabBox.y + fabBox.height <= moreBox.y
		);
	expect(coveredByFab, "the last row's ⋯ button is not covered by the floating compose button").toBe(false);

	await more.click();
	const sheet = page.getByRole("dialog");
	await sheet.getByRole("button", { name: "Snooze", exact: true }).click();
	await sheet.getByRole("button", { name: /^Tomorrow/ }).click();
	await expect(sheet).toHaveCount(0);
	await expect(page.getByRole("main").getByText(lastSubject, { exact: true })).toHaveCount(0);
	await page.goto("/snoozed");
	await expect(page.getByRole("main").getByText(lastSubject, { exact: true })).toBeVisible();
});

// Upstream Mailflare review (docs/upstream/mailflare-review-2026-11-08.md #14): the reader's own toolbar row
// (Reply, Trash, Report spam, More) must not overflow the sticky header and push More off screen on a narrow
// phone — it scrolls inside itself instead (message-actions.tsx), and More stays pinned after it.
test("the reader toolbar's More trigger stays on screen on a small phone", async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 568 });
	await page.goto("/inbox");
	await page.getByRole("list", { name: "Inbox" }).getByText(subject, { exact: true }).click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();

	const more = page.getByRole("button", { name: "More actions" });
	await expect(more).toBeVisible();
	const box = await more.boundingBox();
	expect(box && box.x >= 0 && box.x + box.width <= 320, "More actions stays within the 320px viewport").toBe(true);

	await more.click();
	await expect(page.getByRole("button", { name: "Show original" })).toBeVisible();
});

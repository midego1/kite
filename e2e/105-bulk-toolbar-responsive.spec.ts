import { expect, test, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

const FROM = `"Picker" <picker@outside.test>`;

/** The list row for a subject, whether the list is wide or stacked beside the reading pane. */
function rowFor(page: Page, subject: string) {
	return page
		.getByRole("main")
		.locator("[data-message-row]")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();
}

/** The bulk toolbar in the list header: its action buttons sit beside the "N selected" count. */
function toolbar(page: Page) {
	return page.getByText(/^\d+ selected$/).locator("..");
}

/**
 * A visible element whose whole box is still inside `container`'s box: the real constraint the clipping bug
 * was about is the list panel's own width, not the browser window around it, which stays wide (1400px) even
 * when the panel resizes down to its 360px default.
 */
async function isFullyWithin(container: Locator, locator: Locator) {
	const outer = await container.boundingBox();
	const box = await locator.boundingBox();
	if (!outer || !box) return false;
	return (
		box.x >= outer.x &&
		box.y >= outer.y &&
		box.x + box.width <= outer.x + outer.width &&
		box.y + box.height <= outer.y + outer.height
	);
}

async function deliverToSpam(subject: string): Promise<void> {
	const api = await apiContext(STORAGE_STATE);
	const message = await deliverInbound(api, { from: FROM, to: SUPPORT_ADDRESS, subject });
	await api.post("/api/messages/bulk", { data: { messageIds: [message.id], action: "spam" } });
	await api.dispose();
}

test("at the default split-pane list width, with a message open in Spam, every bulk action stays reachable", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 900 });
	const subject = `Toolbar fit ${uniqueToken()}`;
	await deliverToSpam(subject);

	await page.goto("/spam");
	await openMessage(page, subject);
	// The default split-pane list is 360px, padded to about 336px inside: narrower than what the full set of
	// labelled buttons needs, even though the browser window itself is 1400px wide.
	await rowFor(page, subject).getByRole("checkbox").check();
	const bar = toolbar(page);
	await expect(bar).toBeVisible();
	const panel = page.locator("#kite-message-list-panel");

	// Always inline, whatever the width: Delete, Mark as read and Clear selection (small enough that they
	// always have room, unlike the wider, labelled actions, or Delete forever next to them both).
	const trash = bar.getByRole("button", { name: "Delete", exact: true });
	const markRead = bar.getByRole("button", { name: /^Mark as (read|unread)$/ });
	const clear = bar.getByRole("button", { name: "Clear selection" });
	const more = bar.getByRole("button", { name: "More actions" });
	for (const button of [trash, markRead, clear, more]) {
		await expect(button).toBeVisible();
		expect(await isFullyWithin(panel, button)).toBe(true);
	}

	// Archive, Not spam, Delete forever and Move to have no room here: they are never rendered off to the
	// side where `overflow-hidden` would clip them, only folded into "More actions".
	await expect(bar.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
	await expect(bar.getByRole("button", { name: "Not spam" })).toHaveCount(0);
	await expect(bar.getByRole("button", { name: "Delete forever" })).toHaveCount(0);
	await expect(bar.getByRole("button", { name: "Move to", exact: true })).toHaveCount(0);

	await more.click();
	const menu = page.getByRole("menu");
	await expect(menu.getByRole("menuitem", { name: "Archive", exact: true })).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Not spam" })).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Delete forever" })).toBeVisible();
	const moveEntry = menu.getByRole("menuitem", { name: "Move to", exact: true });
	await expect(moveEntry).toHaveAttribute("aria-expanded", "false");
	await expect(menu.getByRole("menuitem", { name: "Clear selection" })).toBeVisible();

	// "Move to" was missing from this menu entirely before: expanding it reaches the same folder choices the
	// inline button offers at a wider container width. The keyboard opens it without a pointer path across
	// the other items first, which would close the whole menu instead.
	await moveEntry.press("ArrowRight");
	await expect(moveEntry).toHaveAttribute("aria-expanded", "true");
	await expect(menu.getByRole("menuitem", { name: "Inbox", exact: true })).toBeVisible();
	await menu.getByRole("menuitem", { name: "Not spam" }).click();
	await expect(rowFor(page, subject)).toHaveCount(0);
});

test("below the phone-shell breakpoint the single-pane list is wide enough that every action shows inline", async ({
	page,
}) => {
	// Narrower than a split desktop view, but still past the @xl container threshold once it is the list's
	// only pane (no reading pane beside it to share the width with, unlike the first test here).
	await page.setViewportSize({ width: 700, height: 900 });
	const subject = `Toolbar wide ${uniqueToken()}`;
	await deliverToSpam(subject);

	await page.goto("/spam");
	await rowFor(page, subject).getByRole("checkbox").check();
	const bar = toolbar(page);
	await expect(bar.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Not spam" })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Delete forever" })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Move to", exact: true })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Clear selection" })).toBeVisible();
	await expect(bar.getByRole("button", { name: "More actions" })).toHaveCount(0);
});

test("on a 375px phone, a checked row in Spam still reaches Move to through More actions", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 700 });
	const subject = `Toolbar phone ${uniqueToken()}`;
	await deliverToSpam(subject);

	await page.goto("/spam");
	await rowFor(page, subject).getByRole("checkbox").check();
	const bar = toolbar(page);
	const more = bar.getByRole("button", { name: "More actions" });
	await expect(more).toBeVisible();
	// A phone has no separate resizable list panel (the list is the whole main pane here), so the main
	// region itself is the container whose edge a clipped action would fall outside of.
	expect(await isFullyWithin(page.getByRole("main"), more)).toBe(true);
	await expect(bar.getByRole("button", { name: "Move to", exact: true })).toHaveCount(0);

	await more.click();
	const menu = page.getByRole("menu");
	const moveEntry = menu.getByRole("menuitem", { name: "Move to", exact: true });
	await expect(moveEntry).toBeVisible();
	await moveEntry.press("ArrowRight");
	await menu.getByRole("menuitem", { name: "Archived", exact: true }).click();
	await expect(rowFor(page, subject)).toHaveCount(0);
	await page.goto("/archived");
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toBeVisible();
});

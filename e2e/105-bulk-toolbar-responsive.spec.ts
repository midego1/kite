import { expect, test, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";
import type { StoredMessage } from "./support/helpers-types";

const FROM = `"Picker" <picker@outside.test>`;
const FOLDER_PATH = { inbox: "/inbox", spam: "/spam", trash: "/trash" } as const;
type Folder = keyof typeof FOLDER_PATH;
const FOLDERS: Folder[] = ["inbox", "spam", "trash"];

/** The list widths the default split-pane list resizes between: its minimum, default, and common wider ones
 * a user or a saved preference can leave it at. */
const LIST_WIDTHS = [250, 360, 600, 700, 900];
/** Browser window sizes from a small phone up through a wide desktop. */
const WINDOW_WIDTHS = [320, 375, 700, 900, 1400];

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
	return page.getByTestId("bulk-toolbar");
}

/**
 * Checks the row, tolerant of a resize that crosses the fold posture's "folded"/"desktop" boundary (700px):
 * `MessageSplitLayout` keys its panel group on the fold mode, so that remounts the list and can wipe out a
 * check that landed just before React finished swapping the tree. Retries the whole thing, not just the
 * click, since the stale element the first attempt found is gone by the time the remount settles.
 */
async function selectRow(page: Page, subject: string) {
	await expect(async () => {
		await rowFor(page, subject).getByRole("checkbox").check();
		await expect(page.getByText(/^\d+ selected$/)).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 15_000 });
}

/**
 * A visible element whose whole box is still inside `container`'s box: the real constraint the clipping bug
 * was about is the list panel's own width (or, with no split, the main pane's), not the browser window.
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

/** The resizable list panel when the layout is split beside a reading pane, else the main pane that is then
 * the list's whole width. */
async function clippingContainer(page: Page): Promise<Locator> {
	const panel = page.locator("#kite-message-list-panel");
	if ((await panel.count()) > 0) return panel;
	return page.getByRole("main");
}

async function deliverTo(folder: Folder, subject: string): Promise<StoredMessage> {
	const api = await apiContext(STORAGE_STATE);
	const message = await deliverInbound(api, { from: FROM, to: SUPPORT_ADDRESS, subject });
	if (folder !== "inbox") {
		const response = await api.post("/api/messages/bulk", { data: { messageIds: [message.id], action: folder } });
		expect(response.ok(), await response.text()).toBe(true);
	}
	await api.dispose();
	return message;
}

/**
 * Every button the bulk toolbar currently renders (whatever folded into "More actions" and whatever stayed
 * inline) has its whole box inside `container`: the count and Clear selection are checked by name directly,
 * since they must never be the ones that move.
 */
async function assertNoClipping(page: Page, container: Locator, context: string) {
	const bar = toolbar(page);
	await expect(bar, context).toBeVisible();
	await expect(page.getByText(/^\d+ selected$/), context).toBeVisible();
	const clear = bar.getByRole("button", { name: "Clear selection" });
	await expect(clear, context).toBeVisible();

	// One evaluate() reads every button's box together: the toolbar can still legitimately re-measure and
	// re-render around a fold-breakpoint resize, and reading boxes one Playwright round trip at a time risked
	// catching it mid-reflow (a button that is really fine, just caught between two renders).
	const containerHandle = await container.elementHandle();
	const barHandle = await bar.elementHandle();
	if (!containerHandle || !barHandle) throw new Error(`${context}: toolbar or its clipping container vanished`);
	const result = await page.evaluate(
		([outerEl, barEl]) => {
			const outer = (outerEl as HTMLElement).getBoundingClientRect();
			// Excludes the toolbar's own hidden measurement clone (aria-hidden): querySelectorAll, unlike
			// Playwright's role-based locators, does not know to leave it out on its own.
			const buttons = Array.from((barEl as HTMLElement).querySelectorAll("button")).filter(
				(button) => !button.closest('[aria-hidden="true"]'),
			);
			return {
				count: buttons.length,
				clipped: buttons
					.map((button) => {
						const box = button.getBoundingClientRect();
						const within =
							box.x >= outer.x &&
							box.y >= outer.y &&
							box.x + box.width <= outer.x + outer.width &&
							box.y + box.height <= outer.y + outer.height;
						return { name: button.getAttribute("aria-label") ?? button.textContent ?? "", within };
					})
					.filter((entry) => !entry.within)
					.map((entry) => entry.name),
			};
		},
		[containerHandle, barHandle],
	);
	expect(result.count, `${context}: at least Delete and Clear selection should be reachable`).toBeGreaterThan(1);
	expect(result.clipped, `${context}: clipped actions`).toEqual([]);
}

for (const folder of FOLDERS) {
	test(`${folder}: no bulk action is clipped at any list width, with a message open`, async ({ page }) => {
		const subject = `Toolbar list width ${folder} ${uniqueToken()}`;
		const message = await deliverTo(folder, subject);
		await page.setViewportSize({ width: 1400, height: 900 });
		await page.goto(`${FOLDER_PATH[folder]}/${message.id}`);
		await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();

		for (const width of LIST_WIDTHS) {
			// The preference is read once on mount, so a reload is what picks up a new value; the message stays
			// open across it since it is also in the URL, but the checkbox (plain React state) is not.
			await page.evaluate((value) => localStorage.setItem("kite-column-width:message-list", String(value)), width);
			await page.reload();
			await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
			await rowFor(page, subject).getByRole("checkbox").check();
			await assertNoClipping(page, page.locator("#kite-message-list-panel"), `${folder} at list width ${width}`);
		}
	});
}

for (const folder of FOLDERS) {
	test(`${folder}: no bulk action is clipped at any window size, list only`, async ({ page }) => {
		const subject = `Toolbar window ${folder} ${uniqueToken()}`;
		await deliverTo(folder, subject);
		await page.setViewportSize({ width: WINDOW_WIDTHS[0], height: 800 });
		await page.goto(FOLDER_PATH[folder]);
		// The first visit compiles the dashboard on a cold dev server: settle before resizing across the fold
		// breakpoint, or a check below can land mid-compile and be lost to the real mount that follows it.
		await expect(rowFor(page, subject)).toBeVisible({ timeout: 60_000 });

		for (const width of WINDOW_WIDTHS) {
			await page.setViewportSize({ width, height: 800 });
			// Crossing the single-pane/split-pane fold threshold remounts the list, which drops the checked
			// row's plain React state (selectRow already retries that), and can still remount again right
			// after, under the measurement itself: retry the pair together so a stale element handle recovers
			// by re-checking the row rather than failing the whole test on a resize that is still settling.
			await expect(async () => {
				await selectRow(page, subject);
				await assertNoClipping(page, await clippingContainer(page), `${folder} at window ${width}`);
			}).toPass({ timeout: 30_000 });
		}
	});
}

test("at the default split-pane list width, with a message open in Spam, every action reaches through Move to's submenu", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 900 });
	const subject = `Toolbar fit ${uniqueToken()}`;
	const message = await deliverTo("spam", subject);

	await page.goto(`/spam/${message.id}`);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	// The default split-pane list is 360px, padded to about 336px inside: narrower than what the full set of
	// labelled buttons needs, even though the browser window itself is 1400px wide.
	await rowFor(page, subject).getByRole("checkbox").check();
	const bar = toolbar(page);
	const more = bar.getByRole("button", { name: "More actions" });
	await expect(more).toBeVisible();

	await more.click();
	const menu = page.getByRole("menu");
	const moveEntry = menu.getByRole("menuitem", { name: "Move to", exact: true });
	await expect(moveEntry).toHaveAttribute("aria-expanded", "false");
	// "Move to" was missing from this menu entirely before: expanding it reaches the same folder choices the
	// inline button offers at a wider container width. The keyboard opens it without a pointer path across
	// the other items first, which would close the whole menu instead.
	await moveEntry.press("ArrowRight");
	await expect(moveEntry).toHaveAttribute("aria-expanded", "true");
	await expect(menu.getByRole("menuitem", { name: "Inbox", exact: true })).toBeVisible();
	await menu.getByRole("menuitem", { name: "Not spam" }).click();
	await expect(rowFor(page, subject)).toHaveCount(0);
});

test("below the phone-shell breakpoint the single-pane list has more room than the default split-pane list, so more actions show inline", async ({
	page,
}) => {
	// Just under the phone-shell breakpoint (768px): the sidebar collapses into a sheet and, with nothing open,
	// the list is the whole window, wider than the default split-pane list the first test here is constrained
	// to, even though it is a narrower window overall. Still not wide enough for every action: "Not spam" and
	// "Move to", the lowest-priority and widest ones, still fold into "More actions".
	await page.setViewportSize({ width: 767, height: 900 });
	const subject = `Toolbar wide ${uniqueToken()}`;
	await deliverTo("spam", subject);

	await page.goto("/spam");
	await rowFor(page, subject).getByRole("checkbox").check();
	const bar = toolbar(page);
	await expect(bar.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Mark as read" })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Delete forever" })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Clear selection" })).toBeVisible();
	await expect(bar.getByRole("button", { name: "Not spam" })).toHaveCount(0);
	await expect(bar.getByRole("button", { name: "Move to", exact: true })).toHaveCount(0);
	await expect(bar.getByRole("button", { name: "More actions" })).toBeVisible();
});

test("on a 375px phone, a checked row in Spam still reaches Move to through More actions", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 700 });
	const subject = `Toolbar phone ${uniqueToken()}`;
	await deliverTo("spam", subject);

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

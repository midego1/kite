import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken, waitForMessage } from "./support/helpers";

async function deliverMany(labels: string[]): Promise<string[]> {
	const api = await apiContext(STORAGE_STATE);
	const subjects: string[] = [];
	for (const label of labels) {
		const subject = `${label} ${uniqueToken()}`;
		await deliverInbound(api, { from: `"Picker" <picker@outside.test>`, to: SUPPORT_ADDRESS, subject });
		subjects.push(subject);
	}
	await api.dispose();
	return subjects;
}

function rowFor(page: Page, subject: string) {
	return page
		.getByRole("main")
		.locator("div.group")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();
}

test("Shift-click selects every message between two checkboxes", async ({ page }) => {
	// Delivered oldest first, so the list shows them newest first: E, D, C, B, A.
	const [a, b, c, d, e] = await deliverMany(["Range A", "Range B", "Range C", "Range D", "Range E"]);
	await page.goto("/inbox");
	const box = (subject: string) => rowFor(page, subject).getByRole("checkbox");
	await expect(box(a)).toBeVisible();

	await box(d).click();
	await box(a).click({ modifiers: ["Shift"] });
	for (const subject of [d, c, b, a]) await expect(box(subject)).toBeChecked();
	await expect(box(e)).not.toBeChecked();
	await expect(page.getByText("4 selected")).toBeVisible();
	expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

	// Shift-click on another checkbox re-extends from the same anchor (D), here shrinking the range to D..C.
	await box(c).click({ modifiers: ["Shift"] });
	for (const subject of [b, a]) await expect(box(subject)).not.toBeChecked();
	for (const subject of [d, c]) await expect(box(subject)).toBeChecked();
	await expect(page.getByText("2 selected")).toBeVisible();
});

test("opening another message keeps an existing checkbox selection", async ({ page }) => {
	const [first, second] = await deliverMany(["Open first", "Open second"]);
	await page.goto("/inbox");
	await rowFor(page, first).getByRole("checkbox").check();
	await expect(page.getByText("1 selected")).toBeVisible();

	await openMessage(page, second);
	await expect(page.getByRole("heading", { level: 1, name: second })).toBeVisible();
	// Opening a different message to read it does not lose track of what was already checked.
	await expect(page.getByText("1 selected")).toBeVisible();
	await expect(rowFor(page, first).getByRole("checkbox")).toBeChecked();
	await expect(rowFor(page, second).getByRole("checkbox")).not.toBeChecked();
});

test("selecting a message on a phone still offers the bulk actions", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const [subject] = await deliverMany(["Phone pick"]);
	await page.goto("/inbox");
	await rowFor(page, subject).getByRole("checkbox").check();
	// The compact phone header used to hide the bulk toolbar, leaving a selection with no actions.
	await expect(page.getByText("1 selected")).toBeVisible();
	await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Mark as read" })).toBeVisible();
	await expect(page.getByRole("button", { name: "More actions" })).toBeVisible();
});

test("the Select button only shows on a touch device; a pointer relies on the always-visible checkbox", async ({
	browser,
}) => {
	const [subject] = await deliverMany(["Touch check"]);

	// A touch device: "Select" reveals every row's checkbox for a finger that gets no hover.
	const touchContext = await browser.newContext({ storageState: STORAGE_STATE, hasTouch: true });
	const touchPage = await touchContext.newPage();
	await touchPage.goto("/inbox");
	await expect(touchPage.getByText(subject, { exact: true })).toBeVisible();
	await expect(touchPage.getByRole("button", { name: "Select", exact: true })).toBeVisible();
	await touchContext.close();

	// A pointer never sees it: the header checkbox and hover both work without a mode switch.
	const pointerContext = await browser.newContext({ storageState: STORAGE_STATE });
	const pointerPage = await pointerContext.newPage();
	await pointerPage.goto("/inbox");
	await expect(pointerPage.getByText(subject, { exact: true })).toBeVisible();
	await expect(pointerPage.getByRole("button", { name: "Select", exact: true })).toHaveCount(0);
	await expect(pointerPage.getByRole("checkbox", { name: "Select all visible messages" })).toBeVisible();
	await pointerContext.close();
});

test("a touch long press selects a row without opening it, and a trailing click never opens it either", async ({
	browser,
}) => {
	const [first] = await deliverMany(["Long press first"]);
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		hasTouch: true,
		viewport: { width: 390, height: 844 },
	});
	const page = await context.newPage();
	await page.goto("/inbox");
	const row = rowFor(page, first);
	await expect(row).toBeVisible();
	const box = (await row.boundingBox())!;
	const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const press = (pointerId: number) => ({
		pointerId,
		pointerType: "touch",
		clientX: point.x,
		clientY: point.y,
		bubbles: true,
	});

	await row.dispatchEvent("pointerdown", press(1));
	await page.waitForTimeout(650); // Past LONG_PRESS_MS (500ms).
	await expect(page.getByText("1 selected")).toBeVisible();
	await expect(row.getByRole("checkbox")).toBeChecked();
	// The release (and the click a touchscreen can still fire after it) never opens the row.
	await row.dispatchEvent("pointerup", press(1));
	await row.dispatchEvent("click", { bubbles: true, cancelable: true });
	await expect(page).toHaveURL(/\/inbox$/);
	await context.close();
});

test("a touch long press with no click right after it leaves the row's next tap unaffected", async ({ browser }) => {
	const [first] = await deliverMany(["Long press no click"]);
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		hasTouch: true,
		viewport: { width: 390, height: 844 },
	});
	const page = await context.newPage();
	await page.goto("/inbox");
	const row = rowFor(page, first);
	await expect(row).toBeVisible();
	const box = (await row.boundingBox())!;
	const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const press = (pointerId: number) => ({
		pointerId,
		pointerType: "touch",
		clientX: point.x,
		clientY: point.y,
		bubbles: true,
	});

	await row.dispatchEvent("pointerdown", press(1));
	await page.waitForTimeout(650);
	await expect(page.getByText("1 selected")).toBeVisible();
	// Lifted with no click following at all (a scroll away, say): without resetting at the start of the next
	// press, this would leave the row's very next, unrelated tap swallowed too.
	await row.dispatchEvent("pointercancel", press(1));

	// Dispatched on the subject text itself (inside the row's link), the way a real finger would land there,
	// not on the outer row container the first press used only to drive its own long-press handlers.
	const link = row.getByText(first, { exact: true });
	await link.dispatchEvent("pointerdown", press(2));
	await link.dispatchEvent("pointerup", press(2));
	await link.dispatchEvent("click", { bubbles: true, cancelable: true });
	await expect(page.getByRole("heading", { level: 1, name: first })).toBeVisible();
	await context.close();
});

test("a touch long press that fires mid-gesture disarms a swipe the same finger goes on to make", async ({
	browser,
}) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Long press then swipe ${uniqueToken()}`;
	const message = await deliverInbound(api, { from: `"Picker" <picker@outside.test>`, to: SUPPORT_ADDRESS, subject });
	await api.dispose();
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		hasTouch: true,
		viewport: { width: 390, height: 844 },
	});
	const page = await context.newPage();
	await page.goto("/inbox");
	const row = rowFor(page, subject);
	await expect(row).toBeVisible();
	const box = (await row.boundingBox())!;
	const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const move = (pointerId: number, dx: number) => ({
		pointerId,
		pointerType: "touch",
		clientX: point.x + dx,
		clientY: point.y,
		bubbles: true,
	});

	await row.dispatchEvent("pointerdown", move(1, 0));
	await page.waitForTimeout(650); // Past LONG_PRESS_MS (500ms): the row is now selected.
	await expect(page.getByText("1 selected")).toBeVisible();
	await expect(row.getByRole("checkbox")).toBeChecked();

	// The same finger, still down, now drags well past the swipe's own commit distance (88px) and releases:
	// without disarming the row's swipe-to-archive on the long press firing, this would archive the message
	// the long press had just selected instead.
	await row.dispatchEvent("pointermove", move(1, -120));
	await row.dispatchEvent("pointerup", move(1, -120));
	await expect(row).toBeVisible();
	await expect(row.getByRole("checkbox")).toBeChecked();

	const check = await apiContext(STORAGE_STATE);
	try {
		await waitForMessage(check, subject, { status: "received" });
	} finally {
		await check.dispose();
	}
	await context.close();
});

test("trashing a selected message from its row removes it from the selection", async ({ page }) => {
	const subjects = await deliverMany(["Pick one", "Pick two"]);

	await page.goto("/inbox");
	const rows = subjects.map((subject) => rowFor(page, subject));
	for (const row of rows) await row.getByRole("checkbox").check();
	await expect(page.getByText("2 selected")).toBeVisible();

	await rows[0].hover();
	await rows[0].getByRole("button", { name: "Trash" }).click();
	await expect(page.getByRole("main").getByText(subjects[0], { exact: true })).toHaveCount(0);
	await expect(page.getByText("1 selected")).toBeVisible();
});

test("the header checkbox and Cmd/Ctrl+A both select every loaded row, but Cmd/Ctrl+A leaves the search field alone", async ({
	page,
}) => {
	const token = uniqueToken();
	const subjects = await deliverMany([`Mass A ${token}`, `Mass B ${token}`, `Mass C ${token}`]);
	await page.goto("/inbox");
	// Scoped to these three: earlier tests in this file leave their own mail in the same Inbox.
	const search = page.getByPlaceholder(/^Search mail/);
	await search.fill(token);
	await expect(page.getByText(subjects[0], { exact: true })).toBeVisible();

	const selectAll = page.getByRole("checkbox", { name: "Select all visible messages" });
	await selectAll.check();
	await expect(page.getByText("3 selected")).toBeVisible();
	for (const subject of subjects) await expect(rowFor(page, subject).getByRole("checkbox")).toBeChecked();
	await selectAll.uncheck();
	await expect(page.getByText(/\d+ selected/)).toHaveCount(0);

	// Checking one row, then Cmd/Ctrl+A with the focus in the list selects every loaded row.
	await rowFor(page, subjects[0]).getByRole("checkbox").check();
	await expect(page.getByText("1 selected")).toBeVisible();
	await search.click();
	await page.keyboard.press("ControlOrMeta+a");
	// The shortcut belongs to the search field here: the selection is untouched.
	await expect(page.getByText("1 selected")).toBeVisible();

	await page.getByRole("list", { name: "Inbox" }).focus();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(page.getByText("3 selected")).toBeVisible();
	for (const subject of subjects) await expect(rowFor(page, subject).getByRole("checkbox")).toBeChecked();
});

test("Select all N in the folder extends a selection past the loaded page", async ({ page }) => {
	const token = uniqueToken();
	const labels = Array.from({ length: 26 }, (_, index) => `Reach ${token} ${index + 1}`);
	const subjects = await deliverMany(labels);
	await page.goto("/inbox");
	const search = page.getByPlaceholder(/^Search mail/);
	await search.fill(token);
	// Delivered oldest first, so the list shows the newest (last delivered) on its first page;
	// the oldest, message 1, is the one row past it that only "Select all" can reach.
	const newest = subjects.at(-1)!;
	const oldest = subjects[0]!;
	await expect(page.getByText(newest, { exact: true })).toBeVisible();
	await expect(page.getByText(oldest, { exact: true })).toHaveCount(0);

	await page.getByRole("checkbox", { name: "Select all visible messages" }).check();
	await expect(page.getByText("25 selected")).toBeVisible();

	const banner = page.getByRole("button", { name: /Select all 26 in Inbox/ });
	await expect(banner).toBeVisible();
	await banner.click();
	// More than a page's worth, including the one message the list never loaded.
	await expect(page.getByText("26 selected")).toBeVisible();

	// The default split-pane list has no room for Archive inline, so it is reached through "More actions".
	const toolbar = page.getByText(/^\d+ selected$/).locator("..");
	await toolbar.getByRole("button", { name: "More actions" }).click();
	await page.getByRole("menu").getByRole("menuitem", { name: "Archive", exact: true }).click();
	await expect(page.getByText(newest, { exact: true })).toHaveCount(0);

	const api = await apiContext(STORAGE_STATE);
	const params = new URLSearchParams({ status: "archived", q: token, limit: "1" });
	const response = await api.get(`/api/messages?${params}`);
	const { total } = (await response.json()) as { total: number };
	expect(total).toBe(26);
	await api.dispose();
});

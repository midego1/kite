import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

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

	const toolbar = page.getByText(/^\d+ selected$/).locator("..");
	await toolbar.getByRole("button", { name: "Archive", exact: true }).click();
	await expect(page.getByText(newest, { exact: true })).toHaveCount(0);

	const api = await apiContext(STORAGE_STATE);
	const params = new URLSearchParams({ status: "archived", q: token, limit: "1" });
	const response = await api.get(`/api/messages?${params}`);
	const { total } = (await response.json()) as { total: number };
	expect(total).toBe(26);
	await api.dispose();
});

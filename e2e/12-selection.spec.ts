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

	// Shift-click on a checked row clears the range back to the previous click.
	await box(c).click({ modifiers: ["Shift"] });
	for (const subject of [c, b, a]) await expect(box(subject)).not.toBeChecked();
	await expect(box(d)).toBeChecked();
	await expect(page.getByText("1 selected")).toBeVisible();
});

test("opening a message while others are selected shows it in the reading pane", async ({ page }) => {
	const [first, second] = await deliverMany(["Open first", "Open second"]);
	await page.goto("/inbox");
	await rowFor(page, first).getByRole("checkbox").check();
	await expect(page.getByText("1 selected")).toBeVisible();

	await openMessage(page, second);
	await expect(page.getByRole("heading", { level: 1, name: second })).toBeVisible();
	await expect(page.getByText("1 selected")).toHaveCount(0);
	await expect(rowFor(page, first).getByRole("checkbox")).not.toBeChecked();

	// Selecting again while a message is open brings the selection pane back.
	await rowFor(page, first).getByRole("checkbox").check();
	await expect(page.getByText("1 selected")).toBeVisible();
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
